import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { TABLES, PREF_KEYS, IGNORED_KEYS, MISC_COLLECTIONS, tx, tableOf, reservedName } from './db.js';
import { HttpError, cj, same, merge3, isAdminRole } from './util.js';
import { validate, PROJECT_TYPES, normalizePriority, normalizeArchived, normalizeCustomer, normalizeHistory, validId, validateCfg, validateNavDefault, validatePerms, validateModules, stripBadKeys, HIST_TEXT_MAX } from './validate.js';
import { notifyForIssue, notifyForComment } from './notify.js';
import { PERM_LABEL, projRole, roleCan, isWsAdmin, wsAdminIds, wsHasNoAdmin, wsOwner, mergeMap, mergePerms } from './perms.js';

export { HttpError };

export const DEFAULT_USER_PASSWORD = () => process.env.DEFAULT_USER_PASSWORD || 'Pano2026!';
const SECRET_USER_KEYS = ['pw', 'salt', 'mustChange', 'password', 'password_hash', 'passwordHash'];
const USER_COLS = ['id', 'username', 'name', 'role', 'active', 'system'];
const ROLES = ['super', 'admin', 'member', 'viewer'];
/* Genel yapılandırma ve cariler: yalnızca sistem yöneticisi değiştirir (projeye özel alan hariç: proje yetki tablosu,
   project.fields). Projeye bağlı kayıtların yetkisi proje rolünden (yetki-v2, server/perms.js) gelir: checkScope. */
export const ADMIN_ONLY = ['fields', 'rules', '_settings', 'customers'];
const ISSUE_CHILDREN = ['comments', 'worklogs', 'history', 'transitions'];
/* Yeni kaydı yalnız ekleyerek oluşturan koleksiyonlar (eşzamanlı oluşturmada üzerine yazılmaz). Geçmiş ve
   yorum: aynı kimlikle eşzamanlı ikinci gönderim ilk yazanın kaydını (yazarını) ezmesin. */
const CREATE_ONCE = ['workspaces', 'customers', 'history', 'comments', 'reports'];
/* Geçmiş yalnız eklenir (B2): var olan kayıt değiştirilemez, tek tek silinemez (yöneticiler dahil); silme yalnız
   iş silmenin cascade'iyle. Yeni kayıtta yönetici olmayanın yazarı oturuma, zamanı sunucu saatine ±5 dk zorlanır. */
export const HIST_LOCKED = 'Geçmiş kaydı değiştirilemez';
export const HIST_SKEW_MS = 5 * 60 * 1000;
export const COMMENT_FORBIDDEN = 'Başkasının yorumunu yalnızca yönetici değiştirebilir';
const HIST_KEYS = ['id', 'issueId', 'userId', 'at', 'field', 'from', 'to', 'kind', 'key', 'rule'];
export const HIST_MAX_BYTES = 2048;
/* Geçmiş kaydında bilinen anahtarlar dışındakiler atılır; değişiklik olduysa true. */
const stripHistKeys = d => { let n = 0; for (const k of Object.keys(d)) if (!HIST_KEYS.includes(k)) { delete d[k]; n++; } return n > 0; };

/* ---- kullanıcıyı istemciye gönderilecek biçime çevir (parola özeti yok) ---- */
export function publicUser(row) {
  return {
    ...row.data,
    id: row.id, username: row.username, name: row.name, role: row.role,
    active: row.active, system: row.system, mustChange: row.must_change,
  };
}

const maxSeq = async db => Number((await db.query('SELECT coalesce(max(seq),0) AS s FROM changes')).rows[0].s);

/* ---- tüm veri (yedek / dışa aktarma için; kişisel tercihler hariç) ---- */
export async function readAll(db) {
  const data = {};
  data.users = (await db.query('SELECT * FROM users ORDER BY ord')).rows.map(publicUser);
  for (const [col, table] of Object.entries(TABLES)) {
    data[col] = (await db.query(`SELECT data FROM ${table} ORDER BY ord`)).rows.map(r => r.data);
  }
  for (const r of (await db.query('SELECT collection, data FROM misc_records ORDER BY ord')).rows) {
    /* Eski sürümün geri yüklediği yedekte tablosu olan bir dizi (ör. workspaces) misc_records'a düşmüş
       olabilir: tablodaki kayıtlarla çift görünmesin. */
    if (Object.hasOwn(TABLES, r.collection)) continue;
    if (reservedName(r.collection)) continue;          // __proto__ / constructor: data'nın prototipine dokunmasın
    if (r.collection.startsWith('_')) continue;         // sunucuya ayrılmış ad (eski sürümde istemciden yazılmış `_access` vb.)
    (data[r.collection] ||= []).push(r.data);
  }
  for (const r of (await db.query('SELECT key, value FROM settings')).rows) data[r.key] = r.value;
  return data;
}

/* ---- oturum açan kullanıcı için tüm durum (tek tutarlı anlık görüntü) ---- */
export async function readState(pool, me) {
  return tx(pool, async c => {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const seq = await maxSeq(c);
    const data = scopeData(await readAll(c), me);
    const pr = (await c.query('SELECT data FROM user_prefs WHERE user_id=$1', [me.id])).rows[0];
    for (const k of PREF_KEYS) if (pr?.data?.[k] !== undefined && pr.data[k] !== null) data[k] = pr.data[k];
    if (maskTaxFor(me) && Array.isArray(data.customers)) data.customers = data.customers.map(maskCustomer);
    return { seq, data };
  });
}

/* KVKK: 11 haneli vergi numarası (T.C. kimlik no) yalnız sistem yöneticisine tam gider; diğer herkese (üye, alan
   yöneticisi, izleyici) maskeli, yalnız son 2 hane görünür: *********01. 10 haneli vergi numarası (tüzel kişi)
   kişisel veri değildir, maskelenmez. Yedek / dışa aktarma maskesizdir (yalnız yönetici). Maskeli değer geri
   yazılırsa gerçek değer korunur (applyOne → keepMaskedTaxNo). */
export const maskTaxFor = me => !!me && !isAdminRole(me.role);
const maskTax = t => '*'.repeat(9) + t.slice(-2);
export function maskCustomer(d) {
  if (!d || typeof d.taxNo !== 'string' || !/^\d{11}$/.test(d.taxNo)) return d;
  return { ...d, taxNo: maskTax(d.taxNo) };
}
/* Gelen vergi no güncel 11 haneli değerin maskesiyse (maskeli almış bir istemcinin geri yazması) gerçek değer kalır. */
function keepMaskedTaxNo(data, cur) {
  if (typeof cur?.taxNo !== 'string' || !/^\d{11}$/.test(cur.taxNo) || data.taxNo !== maskTax(cur.taxNo)) return false;
  data.taxNo = cur.taxNo;
  return true;
}

/* ---- son okunan sıra numarasından beri değişenler ---- */
export async function readChanges(pool, since, me) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (collection, record_id) seq, collection, record_id, op
       FROM changes WHERE seq > $1 ORDER BY collection, record_id, seq DESC`, [since]);
  const max = await maxSeq(pool);
  const items = [];
  const admin = !me || isAdminRole(me.role);
  let access = false;
  for (const r of rows) {
    const it = { c: r.collection, id: r.record_id, op: r.op, seq: Number(r.seq) };
    if (r.collection === '_reload') { items.push(it); continue; }
    /* Erişim değişikliği (18): bu kullanıcının (ya da herkesin) görebildiği alan/proje kümesi değişti. */
    if (r.collection === ACCESS_CH) {
      if (me && (r.record_id === me.id || (!admin && r.record_id === '*'))) access = true;   // yönetici yapılan da tam veriyi alsın
      continue;
    }
    if (r.op === 'put') {
      const d = await readOne(pool, r.collection, r.record_id);
      if (d === undefined) it.op = 'del';
      else it.data = r.collection === 'customers' && maskTaxFor(me) ? maskCustomer(d) : d;
    }
    items.push(it);
  }
  items.sort((a, b) => a.seq - b.seq);
  /* Toplu değişiklik (geri yükleme / içe aktarma) olduysa istemci her şeyi yeniden yüklesin. */
  if (items.some(i => i.c === '_reload')) return { seq: max, reload: true, items: [] };
  if (access) return { seq: max, reload: true, access: true, items: [] };
  return { seq: max, items: admin ? items : await scopeItems(pool, me, items) };
}

async function readOne(db, c, id) {
  if (c === 'users') {
    const r = (await db.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
    return r ? publicUser(r) : undefined;
  }
  if (c === '_settings') return (await db.query('SELECT value FROM settings WHERE key=$1', [id])).rows[0]?.value;
  const table = tableOf(c);
  if (table) return (await db.query(`SELECT data FROM ${table} WHERE id=$1`, [id])).rows[0]?.data;
  return (await db.query('SELECT data FROM misc_records WHERE collection=$1 AND id=$2', [c, id])).rows[0]?.data;
}

export const logChange = (c, collection, id, op, uid, batch) =>
  c.query('INSERT INTO changes (collection, record_id, op, user_id, batch_id) VALUES ($1,$2,$3,$4,$5)',
    [collection, id, op, uid, batch || null]);

/* ---- istemciden gelen değişiklikleri uygula ----
   changes: [{ c: 'issues', id: 'i_x', op: 'put'|'del', data: {...}, base: {...} }]
   base: istemcinin değişiklikten önce gördüğü hâl. Veritabanındaki kayıt bu arada
   başkası tarafından değiştirildiyse alan düzeyinde birleştirilir.
   c === '_settings' → genel ayar (id = anahtar), c === '_prefs' → kişisel tercih.
   Yetkisiz ya da geçersiz değişiklikler atlanır ve `rejected` içinde döner;
   sunucunun değiştirdiği kayıtlar (birleştirme, iş anahtarı) `adjusted` içinde döner. */
/* opts.system: sunucu kaynaklı yazma (e-postadan iş, server/mail.js) — talep edeni bilinmeyen iş havuza düşebilir ve
   yazanın (sistem kullanıcısının) alan erişimi denetlenmez (checkScope, bağlantı ucu erişimi). Veri bütünlüğü (anahtar,
   kolon, zorunlu alanlar) ve atananın alan rolü yine denetlenir. Yalnız sunucu içinden verilir: /api/sync opts geçirmez. */
export async function applyChanges(pool, me, changes, opts = {}) {
  if (!Array.isArray(changes)) throw new HttpError(400, 'changes dizi olmalı');
  if (changes.length > 5000) throw new HttpError(413, 'Tek seferde en fazla 5000 değişiklik gönderilebilir');
  /* Kararlı gruplama: kullanıcılar → çalışma alanı/cari kayıtları → proje kayıtları → diğerleri (silmeler
     dahil, gönderim sırasıyla) → en sonda kolon silmeleri. Yeni alan/cari ve ona bağlı yeni proje, yeni
     projenin kolonları dizide önce gelse de doğru sırayla yazılır; silinen kolonun işleri aynı gönderimde
     taşındıysa silme onlardan sonra denetlenir. Geçmiş, yorum ve bağlantılar işlerden sonra (B2): yeni işin geçmişi
     işi bulur; iş silmeyle birlikte gönderilen geçmiş/yorum silmeleri cascade'den sonra "kayıt yok" olur. */
  /* Modül ayarı (Cariler aç/kapat) en önce: aynı gönderimdeki cari yazmaları yeni ayara göre denetlenir.
     Süre kaydı ve geçişler de işlerden sonra (bağlı kaydın işi var olmalı: checkParent). Proje silme proje grubunda:
     bağlı kayıtları sunucu siler (cascadeProjectDelete); aynı gönderimdeki alt kayıt silmeleri sonra "çöpte" diye geçer. */
  const rank = ch => (ch?.c === 'users' || (ch?.c === '_settings' && ch?.id === 'modules') ? 0
    : ['workspaces', 'customers'].includes(ch?.c) && ch?.op === 'put' ? 1
    : ch?.c === 'projects' ? 2
    : ch?.c === 'statuses' && ch?.op === 'del' ? 5
    : ['history', 'comments', 'links', 'worklogs', 'transitions'].includes(ch?.c) ? 4 : 3);
  const ordered = changes.map((ch, i) => [rank(ch), i, ch]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  /* Kilitlenme (40P01) ya da serileştirme hatası (40001): işlem bir kez yeniden denenir. */
  for (let attempt = 0; ; attempt++) {
    try { return await applyOnce(pool, me, ordered, opts); }
    catch (e) {
      if (!['40P01', '40001'].includes(e?.code)) throw e;
      if (attempt >= 1) throw new HttpError(409, 'Sunucu meşgul, yeniden deneyin');
    }
  }
}

const CLIENT_RESERVED = ['_prefs', '_settings'];
/* misc koleksiyonu: beyaz listede ve tercih/ayar adıyla çakışmıyor (durumda `data.ui`/`data.cfg` dizi olmasın). */
async function miscAllowed(c, name) {
  if (!MISC_COLLECTIONS.includes(name) || PREF_KEYS.includes(name) || IGNORED_KEYS.includes(name)) return false;
  return !(await c.query('SELECT 1 FROM settings WHERE key=$1', [name])).rowCount;
}
async function applyOnce(pool, me, ordered, opts = {}) {
  const rejected = [], adjusted = [];
  let applied = 0;
  const batch = randomUUID();
  const ctx = { me, batch, adjusted, touchedIssues: new Set(), cols: new Map(), colNamed: new Set(), system: opts.system === true };
  gateCtx(ctx, ordered.map(x => x[2]));
  const meAdmin = isAdminRole(me.role);
  const rejIdx = new Map();                         // ret listesi gönderim sırasında döner

  await tx(pool, async c => {
    /* Kolon kilitleri tek seferde ve sıralı: ters sıralı eşzamanlı iki gönderim kilitlenmesin. */
    {
      const st = ordered.map(x => x[2]).filter(ch => ch?.c === 'statuses' && typeof ch.id === 'string' && validId(ch.id)
        && ['put', 'del'].includes(ch.op));
      const pids = st.map(ch => ch.op === 'put' ? ch.data?.projectId : null);
      if (st.length) pids.push(...(await c.query('SELECT DISTINCT project_id FROM statuses WHERE id = ANY($1)',
        [st.map(ch => ch.id)])).rows.map(r => r.project_id));
      /* Yetkisiz kişi kilit almaz: kolonlarını değiştiremeyeceği projenin kilidi atlanır (değişikliği applyRecord'da reddedilir). */
      const allowed = [];
      for (const pid of new Set(pids)) if (await colAllowed(c, ctx, pid)) allowed.push(pid);
      await lockColumns(c, ctx, allowed);
    }
    for (const [, i, ch] of ordered) {
      const reject = reason => { const r = { c: ch?.c, id: ch?.id, reason }; rejIdx.set(r, i); rejected.push(r); };
      if (!ch || typeof ch.c !== 'string' || typeof ch.id !== 'string'
          || ch.c.length > 60 || !/^[\w$-]+$/.test(ch.c) || !['put', 'del'].includes(ch.op)) { reject('geçersiz'); continue; }
      /* Kimlikler HTML özniteliklerine basılır: yalnız güvenli karakterler (XSS'e karşı kalıcı çözüm). */
      if (!validId(ch.id)) { reject('geçersiz kimlik'); continue; }
      if (ch.op === 'put' && ch.data === undefined) { reject('veri yok'); continue; }
      if (ch.op === 'put' && !['_prefs', '_settings'].includes(ch.c)
          && (ch.data === null || typeof ch.data !== 'object' || Array.isArray(ch.data))) { reject('veri nesne olmalı'); continue; }
      if (IGNORED_KEYS.includes(ch.c) || ch.c === '_reload') continue;
      /* `_` ile başlayan adlar sunucuya ayrılmış (`_access`, `_reload` sinyalleri); istemci yalnız `_prefs` ve `_settings` yazar. */
      if (ch.c.startsWith('_') && !CLIENT_RESERVED.includes(ch.c)) { reject('geçersiz koleksiyon'); continue; }
      if (reservedName(ch.c)) { reject('geçersiz koleksiyon'); continue; }
      /* Tablosu olmayan koleksiyon yalnız beyaz listedeyse (Güv D1): herkese giden rastgele dizi yazılamaz. */
      if (!CLIENT_RESERVED.includes(ch.c) && ch.c !== 'users' && !tableOf(ch.c) && !(await miscAllowed(c, ch.c))) {
        reject('geçersiz koleksiyon'); continue;
      }

      if (ch.c === '_prefs') {                       // herkes kendi tercihini yazar
        if (!PREF_KEYS.includes(ch.id)) { reject('geçersiz tercih'); continue; }
        await c.query(
          `INSERT INTO user_prefs (user_id, data) VALUES ($1, jsonb_build_object($2::text, $3::jsonb))
           ON CONFLICT (user_id) DO UPDATE SET data = user_prefs.data || jsonb_build_object($2::text, $3::jsonb),
           updated_at = now()`, [me.id, ch.id, JSON.stringify(ch.op === 'del' ? null : ch.data)]);
        applied++; continue;
      }
      /* Projeye bağlı koleksiyonlarda yetki etkin proje rolüyle (checkScope); diğerlerinde genel izleyici salt okunur.
         Kayıtlı rapor kişiseldir: genel izleyici de kendine kaydeder (paylaşamaz; checkReport). */
      if (!WS_SCOPED.includes(ch.c) && ch.c !== 'reports' && me.role === 'viewer') { reject('salt okunur kullanıcı'); continue; }
      if (!meAdmin && ((ADMIN_ONLY.includes(ch.c) && ch.c !== 'fields') || (ch.c === 'workspaces' && ch.op === 'del'))) {
        reject('Bu değişiklik için yönetici yetkisi gerekli'); continue;
      }

      /* __proto__ / constructor / prototype anahtarları hiçbir yoldan kayda girmez. */
      const stripped = stripBadKeys(ch.data) + stripBadKeys(ch.base);

      await c.query('SAVEPOINT ch');
      try {
        const changed = ch.c === 'users' ? await applyUser(c, ctx, ch)
          : ch.c === '_settings' ? await applySetting(c, ctx, ch)
          : await applyRecord(c, ctx, ch);
        if (changed) { await logChange(c, ch.c, ch.id, ch.op, me.id, batch); applied++; }
        if (stripped && !adjusted.some(x => x.c === ch.c && x.id === ch.id)) adjusted.push({ c: ch.c, id: ch.id });
        await c.query('RELEASE SAVEPOINT ch');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT ch');
        if (e instanceof HttpError) reject(e.message);
        else if (e.code === '23505' && e.constraint === 'customers_tax_no_uq') {
          /* Eşzamanlı iki kayıt aynı vergi numarasını yazdı: diğeri işlendi, kimliğini bildir. */
          const other = ctx.taxNo ? (await c.query('SELECT id FROM customers WHERE tax_no=$1 AND id<>$2 LIMIT 1',
            [ctx.taxNo, ch.id])).rows[0]?.id : null;
          reject(taxNoTaken(other));
        }
        else if (e.code === '23505' && e.constraint === 'fields_project_bind_uq') reject(FIELD_BIND_TAKEN);
        else if (e.code === '23505') reject(/username/.test(e.constraint || '') ? 'Bu kullanıcı adı kullanılıyor' : 'Bu kayıt zaten var (benzersizlik ihlali)');
        else throw e;
      }
    }
    /* Harcanan süre her zaman süre kayıtlarının toplamıdır (eşzamanlı kayıtta kayma olmasın). */
    for (const iid of ctx.touchedIssues) await recomputeSpent(c, ctx, iid);
    await recheckGates(c, ctx);
    await checkColumns(c, ctx);
    const admins = Number((await c.query(
      `SELECT count(*) AS n FROM users WHERE active AND role IN ('admin','super')`)).rows[0].n);
    if (admins < 1) throw new HttpError(409, 'En az bir aktif yönetici kalmalı');
  });
  rejected.sort((a, b) => rejIdx.get(a) - rejIdx.get(b));
  return { applied, rejected, adjusted, seq: await maxSeq(pool) };
}

async function applyRecord(c, ctx, ch) {
  const { me, batch } = ctx;
  const table = tableOf(ch.c);
  if (ch.c === 'statuses') {
    /* Danışma kilidi satır kilidinden ÖNCE (kilit sırası hep aynı: kilitlenme olmasın); yetki kilitten de önce. */
    const pre = (await c.query('SELECT project_id FROM statuses WHERE id=$1', [ch.id])).rows[0]?.project_id;
    await colAuth(c, ctx, pre, ch.op === 'put' ? ch.data?.projectId : null);
    await lockColumns(c, ctx, [pre, ch.op === 'put' ? ch.data?.projectId : null]);
  }
  const sel = table
    ? await c.query(`SELECT data FROM ${table} WHERE id=$1 FOR UPDATE`, [ch.id])
    : await c.query('SELECT data FROM misc_records WHERE collection=$1 AND id=$2 FOR UPDATE', [ch.c, ch.id]);
  const cur = sel.rows[0]?.data;
  const meAdmin = isAdminRole(me.role);
  /* Cariler modülü kapalıyken cari ve cari özel alanı yazılmaz (veri durur; açılınca her şey geri gelir). */
  if ((ch.c === 'customers' || (ch.c === 'fields' && (cur?.scope === 'customer' || ch.data?.scope === 'customer')))
      && await customersOff(c, ctx)) throw new HttpError(409, CUSTOMERS_OFF);
  /* Erişim/salt okunur denetimi önce (kayda özgü kurallardan önce); yeni hâl ayrıca yazmadan önce denetlenir. */
  if (!ctx.system) await checkScope(c, ctx, ch.c, cur, ch.op === 'put' ? ch.data : undefined, true);
  /* Bağlı kaydın projesi/işi var olmalı; silinmiş projenin kimliği yeniden açılamaz (O-1). Sistem yolu gevşek. */
  if (!ctx.system && ch.op === 'put') await checkParent(c, ctx, ch.c, ch.data, cur);
  if (!ctx.system && ch.c === 'projects' && ch.op === 'put' && !cur) await checkProjectIdFree(c, ctx, ch.id);

  if (ch.c === 'worklogs' && !meAdmin) {
    const owner = ch.op === 'del' ? cur?.userId : (cur?.userId ?? ch.data?.userId);
    if (owner && owner !== me.id) throw new HttpError(403, 'Başkasının süre kaydını yalnızca yönetici değiştirebilir');
    if (ch.op === 'put' && ch.data?.userId && ch.data.userId !== me.id)
      throw new HttpError(403, 'Başkası adına süre kaydı yalnızca yönetici girebilir');
  }
  if (ch.c === 'worklogs') { if (cur?.issueId) ctx.touchedIssues.add(cur.issueId); if (ch.data?.issueId) ctx.touchedIssues.add(ch.data.issueId); }
  if (ch.c === 'reports') checkReportOwner(me, cur);
  if (ch.op === 'put' && (ch.c === 'transitions' || ch.c === 'history')) gateOrphan(ctx, ch, cur);
  /* Başkasının ya da yazarı olmayan eski yorum: değiştirme/silme yalnız yönetici. Kayıt yoksa silme zaten etkisiz. */
  if (ch.c === 'comments' && !meAdmin && cur && cur.userId !== me.id) throw new HttpError(403, COMMENT_FORBIDDEN);
  if (ch.c === 'history') {
    if (ch.op === 'del') { if (!cur) return goneDel(c, ctx, ch.c, ch.id); throw new HttpError(403, HIST_LOCKED); }
    if (cur) {
      const inc = { ...ch.data, id: ch.id };
      normalizeHistory(inc);
      if (same(cur, inc)) return false;               // aynı veri (yeniden gönderim) sessizce geçer
      stripHistKeys(inc);
      if (same(cur, inc)) { ctx.adjusted.push({ c: ch.c, id: ch.id }); return false; }
      /* Yeniden gönderim: sunucu bu kişinin kaydında yalnız yazarı/zamanı düzeltmişti. */
      const bare = x => ({ ...x, userId: null, at: null });
      if (!meAdmin && cur.userId === me.id && same(bare(cur), bare(inc))) { ctx.adjusted.push({ c: ch.c, id: ch.id }); return false; }
      throw new HttpError(403, HIST_LOCKED);
    }
  }

  if (ch.op === 'del') {
    if (!cur) return goneDel(c, ctx, ch.c, ch.id);
    if (!ctx.system) await checkScope(c, ctx, ch.c, cur, undefined);
    if (ch.c === 'issues') await cascadeIssueDelete(c, ctx, ch.id);
    if (ch.c === 'projects') await cascadeProjectDelete(c, ctx, ch.id);
    if (ch.c === 'workspaces') await checkWorkspaceDelete(c, ch.id);
    if (ch.c === 'sprints' && cur.state === 'active') await canManageSprint(c, ctx, cur.projectId);
    if (ch.c === 'statuses') {
      await canConfigure(c, ctx, cur.projectId);
      await lockColumns(c, ctx, [cur.projectId]);
      if ((await c.query('SELECT 1 FROM issues WHERE status_id=$1 LIMIT 1', [ch.id])).rowCount)
        throw new HttpError(409, 'Önce içindeki işleri taşıyın');
    }
    if (ch.c === 'customers') {
      /* Kişisel veri: cari çöp kutusuna gitmez, kalıcı silinir (geri alınamaz). Silinen cari yedeklerden de
         çıkarılır; yetkili kişi silmesi eski yedeklerde saklama süresi dolana kadar kalabilir. */
      /* Birleştirme (görev 11b): { op:'del', mergeInto: hedef } → bağlar ve kişiler hedefe, kaynak silinir. */
      if (ch.mergeInto !== undefined) await mergeCustomer(c, ctx, ch.id, ch.mergeInto);
      await checkCustomerDelete(c, ch.id);
      await c.query('DELETE FROM customers WHERE id=$1', [ch.id]);
      await purgeCustomerFromSnapshots(c, ch.id);
      return true;
    }
    await c.query(`INSERT INTO deleted_records (collection, record_id, data, batch_id, deleted_by)
      VALUES ($1,$2,$3::jsonb,$4,$5)`, [ch.c, ch.id, JSON.stringify(cur), batch, me.id]);
    if (table) await c.query(`DELETE FROM ${table} WHERE id=$1`, [ch.id]);
    else await c.query('DELETE FROM misc_records WHERE collection=$1 AND id=$2', [ch.c, ch.id]);
    return true;
  }

  /* Silinmiş cari eski hâliyle (base) geri gelmez; yeni cari base'siz gelir. */
  if (ch.c === 'customers' && !cur && ch.base && typeof ch.base === 'object') throw new HttpError(409, 'Cari silinmiş');
  /* Silinmiş kolon eski hâliyle (base) yeniden doğmaz. */
  if (ch.c === 'statuses' && !cur && ch.base && typeof ch.base === 'object') throw new HttpError(409, 'Kolon silinmiş');
  let data = { id: ch.id, ...ch.data };
  data.id = ch.id;
  let adjusted = false;
  if (cur && ch.base && typeof ch.base === 'object' && !same(cur, ch.base)) {
    const mine = data;
    data = merge3(ch.base, data, cur);              // başkası bu arada değiştirmiş
    if (ch.c === 'customers' && (mine.contacts === undefined || Array.isArray(mine.contacts))
        && [ch.base, mine, cur].some(x => x.contacts !== undefined))
      data.contacts = mergeContacts(ch.base.contacts, mine.contacts, cur.contacts);
    /* Proje rolleri ve yetki tablosu kişi/anahtar düzeyinde birleşir: iki yönetici aynı anda farklı kişileri değiştirirse
       ikisinin değişikliği de kalır. */
    if (ch.c === 'projects' && mine.roles && typeof mine.roles === 'object' && !Array.isArray(mine.roles))
      data.roles = mergeMap(ch.base.roles, mine.roles, cur.roles);
    if (ch.c === 'projects' && mine.perms && typeof mine.perms === 'object' && !Array.isArray(mine.perms))
      data.perms = mergePerms(ch.base.perms, mine.perms, cur.perms);
    adjusted = true;
  }
  if (ch.c === 'projects' && cur) {                 // iş sayacı geri gitmesin
    const n = Math.max(Number(cur.counter) || 0, Number(data.counter) || 0);
    if (n !== data.counter) { data.counter = n; adjusted = true; }
  }
  if (ch.c === 'issues' && normalizePriority(data)) adjusted = true;
  /* Sprint planı (başlatmadaki anlık görüntü) bir kez yazılır: alanı göndermeyen (eski) istemci onu silemez. */
  if (ch.c === 'sprints' && cur?.plan != null && data.plan === undefined) { data.plan = cur.plan; adjusted = true; }
  if ((ch.c === 'projects' || ch.c === 'workspaces') && normalizeArchived(data)) adjusted = true;
  if (ch.c === 'customers' && keepMaskedTaxNo(data, cur)) adjusted = true;
  if (ch.c === 'customers' && normalizeCustomer(data)) adjusted = true;
  if (ch.c === 'workspaces' && enforceCreatedBy(data, cur, me)) adjusted = true;
  if (ch.c === 'workspaces' && enforceOwner(data, cur, me)) adjusted = true;
  if (ch.c === 'projects' && await enforceProjectRoles(c, ctx, data, cur)) adjusted = true;
  if (ch.c === 'history' && normalizeHistory(data)) adjusted = true;
  if (ch.c === 'history' && stripHistKeys(data)) adjusted = true;
  if (ch.c === 'history' && !meAdmin && enforceHistoryAuthor(data, me)) adjusted = true;
  /* "Geri yükleme" satırını yalnız sunucu (çöp kutusu) ve yönetici yazar. */
  if (ch.c === 'history' && !meAdmin && data.kind === 'restore') { delete data.kind; adjusted = true; }
  if (ch.c === 'history' && Buffer.byteLength(JSON.stringify(data)) > HIST_MAX_BYTES) throw new HttpError(400, 'Geçmiş kaydı çok büyük');
  /* Yeni yorumda yazar oturumdur; var olan yorumun yazarı değişmez (yönetici hariç; yönetici olmayan
     yalnız kendi yorumunu düzenler, bu durumda cur.userId === me.id). */
  if (ch.c === 'comments' && !meAdmin && data.userId !== me.id) { data.userId = me.id; adjusted = true; }
  if (ch.c === 'reports' && enforceReportOwner(data, cur, me)) adjusted = true;
  validate(ch.c, data, { live: true, cur });
  /* Geçmiş kaydının işi var olmalı (aynı gönderimde oluşturulan iş dahil: gruplamada işlerden sonra gelir).
     FOR SHARE: iş aynı anda silinirse yetim kayıt kalmasın. */
  if (ch.c === 'history'
      && !(await c.query('SELECT 1 FROM issues WHERE id=$1 FOR SHARE', [data.issueId])).rowCount)
    throw new HttpError(400, 'Geçmiş kaydının işi bulunamadı');
  /* Yorumun işi var olmalı (yeni yorumda ya da işi değişince; içe aktarma gevşek kalır). */
  if (ch.c === 'comments' && (!cur || data.issueId !== cur.issueId)
      && !(await c.query('SELECT 1 FROM issues WHERE id=$1 FOR SHARE', [data.issueId])).rowCount)
    throw new HttpError(400, 'Yorumun işi bulunamadı');
  /* Atanan değiştiyse var olan, aktif bir kullanıcı olmalı ve projede "İş düzenleme" yetkisi olmalı (istemcideki memsOf
     ile aynı). Yalnız değişince denetlenir: rolü İzleyici'ye düşen kişinin var olan ataması kalır. İş başka projeye
     taşınınca orada görme yetkisi olmayan atanan boşalır. */
  if (ch.c === 'issues' && data.assignee != null && data.assignee !== '' && data.assignee !== cur?.assignee) {
    const u = typeof data.assignee === 'string'
      ? (await c.query('SELECT id, role, active, system FROM users WHERE id=$1 AND active', [data.assignee])).rows[0] : undefined;
    if (!u) throw new HttpError(400, 'Atanan kullanıcı bulunamadı ya da pasif');
    if (!(await assignable(c, ctx, u, data.projectId))) throw new HttpError(400, ASSIGNEE_NO_ACCESS);
  } else if (ch.c === 'issues' && cur && typeof data.assignee === 'string' && data.assignee && data.projectId !== cur.projectId) {
    const u = (await c.query('SELECT id, role, active, system FROM users WHERE id=$1', [data.assignee])).rows[0];
    if (u && !(await roleIn(c, u, await projById(c, data.projectId)))) { data.assignee = null; adjusted = true; }
  }
  /* Yalnız projesi değişen iş eski projenin kolonunda kalmaz: kolonu yeni projede yoksa yeni projenin ilk
     "yapılacak" kolonuna (yoksa ilk kolonuna) taşınır — istemcideki moveIssueTo ile aynı. */
  if (ch.c === 'issues' && cur && data.projectId !== cur.projectId && (data.statusId ?? '') === (cur.statusId ?? '')
      && !(typeof data.statusId === 'string' && data.statusId
        && (await c.query('SELECT 1 FROM statuses WHERE id=$1 AND project_id=$2', [data.statusId, data.projectId])).rowCount)) {
    const s0 = (await c.query(`SELECT id FROM statuses WHERE project_id=$1 ORDER BY (data->>'cat' = 'todo') DESC NULLS LAST,
        coalesce(CASE WHEN jsonb_typeof(data->'ord') = 'number' THEN (data->'ord')::text::numeric END, 0), id LIMIT 1`, [data.projectId])).rows[0]?.id;
    if (s0) { data.statusId = s0; adjusted = true; }
  }
  /* Kolonu değişen iş var olan bir kolona gider. FOR SHARE: kolon aynı anda silinirse biri bekler
     (silme, işi gördükten sonra "Önce içindeki işleri taşıyın" der). */
  if (ch.c === 'issues' && data.statusId != null && data.statusId !== '' && data.statusId !== cur?.statusId) {
    const ok = typeof data.statusId === 'string'     // kolon işin projesine ait olmalı
      && (await c.query('SELECT 1 FROM statuses WHERE id=$1 AND project_id=$2 FOR SHARE', [data.statusId, data.projectId])).rowCount > 0;
    if (!ok) throw new HttpError(400, 'Kolon bulunamadı');
  }
  if (ch.c === 'issues') await checkRequester(c, data, cur, ctx.system);
  if (ch.c === 'issues' && await ensureIssueKey(c, ctx, data, cur)) adjusted = true;
  if (ch.c === 'workspaces' && await enforceWsMembers(c, me, data, cur)) adjusted = true;
  if (ch.c === 'workspaces' && await enforceWsAdmins(c, me, data, cur)) adjusted = true;
  if (cur && same(cur, data)) { if (adjusted) ctx.adjusted.push({ c: ch.c, id: ch.id }); return false; }
  if (!ctx.system) await checkScope(c, ctx, ch.c, cur, data);
  if (ch.c === 'issues' && cur) await checkGates(c, ctx, data, cur);
  if (ch.c === 'workspaces') await checkWorkspace(c, me, ch.id, data, cur);
  if (ch.c === 'projects') await checkProjectRoles(c, data, cur);
  if (ch.c === 'projects') await checkProjectWorkspace(c, data, cur);
  if (ch.c === 'projects' && cur) await checkProjectMove(c, me, cur, data);
  if (ch.c === 'projects') await checkProjectCustomer(c, data, cur);
  if (ch.c === 'issues') await checkProjectCustomer(c, data, cur, 'Pasif cari işe bağlanamaz');
  if (ch.c === 'projects' && cur) await checkProjectType(c, ctx, ch.id, data, cur);
  /* Proje ayarları (project.settings), roller ve yetki tablosu (proje Yöneticisi), sayaç (issue.create): checkScope →
     checkProjectWrite. Sprint süresi: sprint.manage. */
  if (ch.c === 'projects' && cur && (cur.sprintWeeks ?? null) !== (data.sprintWeeks ?? null))
    await canManageSprint(c, ctx, ch.id);
  if (ch.c === 'sprints') await checkSprintState(c, ctx, data, cur);
  if (ch.c === 'sprints') await checkSprintStart(c, data, cur);
  if (ch.c === 'sprints') await checkSprintPlan(c, ctx, ch.id, data, cur, ctx.system);
  if (ch.c === 'statuses') {
    if (cur) await canConfigure(c, ctx, cur.projectId);
    await canConfigure(c, ctx, data.projectId);
    await lockColumns(c, ctx, [cur?.projectId, data.projectId]);
    if (!cur || colName(cur.name) !== colName(data.name) || cur.projectId !== data.projectId) ctx.colNamed.add(ch.id);
  }
  if (ch.c === 'customers') await checkCustomerTaxNo(c, ctx, ch.id, data, cur);
  if (ch.c === 'fields') await checkFieldKey(c, ch.id, data, cur);
  if (ch.c === 'links') await checkLinkEnds(c, ctx, data, cur, ctx.system);
  if (ch.c === 'reports') await checkReport(c, me, data, cur);

  const json = JSON.stringify(data);
  if (table && !cur && CREATE_ONCE.includes(ch.c)) {
    /* Aynı kimlikle eşzamanlı iki oluşturma: ilk yazan kazanır; ikincisi kaydın üzerine yazmaz (açan kişi
       vb. değişmesin), yeniden denemesi istenir (yeniden denemede kayıt var: güncelleme kuralları işler). */
    const ins = await c.query(`INSERT INTO ${table} (id, data, updated_by) VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (id) DO NOTHING`, [ch.id, json, me.id]);
    if (!ins.rowCount) throw new HttpError(409, 'Kayıt aynı anda oluşturuldu, yeniden deneyin');
  } else if (table) await c.query(
    `INSERT INTO ${table} AS t (id, data, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = t.version + 1,
       updated_at = now(), updated_by = EXCLUDED.updated_by`, [ch.id, json, me.id]);
  else await c.query(
    `INSERT INTO misc_records AS t (collection, id, data, updated_by) VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, version = t.version + 1,
       updated_at = now(), updated_by = EXCLUDED.updated_by`, [ch.c, ch.id, json, me.id]);
  if (adjusted) ctx.adjusted.push({ c: ch.c, id: ch.id });
  /* Okuma süzmesi: proje kişileri, sahip, alan yöneticileri ya da projenin alanı değişti → etkilenenler tam yeniden yükler;
     projeyi göremez olan atananın ataması boşalır (rol düşürmede değil: İzleyici'ye düşenin ataması kalır). */
  if (ch.c === 'workspaces') {
    const diff = wsAccessDiff(cur, data);
    await logAccess(c, ctx, diff);
    if (cur && diff.length) await clearLostAssignees(c, ctx, await wsProjectIds(c, ch.id));
  }
  if (ch.c === 'projects' && cur) {
    const diff = projAccessDiff(cur, data);
    await logAccess(c, ctx, diff);
    if (diff.length) await clearLostAssignees(c, ctx, [ch.id]);
  }

  if (ch.c === 'issues') { ctx.touchedIssues.add(ch.id); await notifyForIssue(c, me, data, cur); }
  if (ch.c === '_settings') ctx.sysPerms = undefined;
  if (ch.c === 'comments' && !cur) await notifyForComment(c, me, data);
  return true;
}

/* ---- proje türü ve kolonlar (#12) ----
   Tür proje kaydında `data.type` ('board' | 'agile'); yoksa genel sprint ayarından hesaplanır
   (settings.cfg.modules.sprint === true → agile), kayda yazılmaz. İstemcideki projType ile aynı. */
const COL_LOCK = 727276;
export const MAX_COLUMNS = 12;
/* Proje ayarları (project.settings): sayaç, tür, sprint süresi ve kişi/yetki alanları dışındaki her şey. */
const PROJECT_ACCESS_KEYS = ['roles', 'perms', 'ownerId', 'members'];
const projSettings = p => { const { counter: _c, members: _m, type: _t, sprintWeeks: _s, roles: _r, perms: _p, ownerId: _o, workspaceId: _w, ...rest } = p || {}; return rest; };
const projAccessPart = p => ({ roles: p?.roles ?? null, perms: p?.perms ?? null, ownerId: p?.ownerId ?? null });
const colName = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr');

const sprintOn = async c =>
  (await c.query(`SELECT value FROM settings WHERE key='cfg'`)).rows[0]?.value?.modules?.sprint === true;
export const projType = (p, on) => (PROJECT_TYPES.includes(p?.type) ? p.type : (on ? 'agile' : 'board'));

/* Kolonlar ve proje türü: projede "Kolonlar ve proje türü" (project.columns) yetkisi. */
async function canConfigure(c, ctx, pid) {
  if (isAdminRole(ctx.me.role)) return;
  const p = await projById(c, pid);
  if (!p) throw new HttpError(400, 'Durumun projesi yok');
  await needPerm(c, ctx, p, 'project.columns');
}

/* Kolon danışma kilidinden ÖNCE yetki (yetkisiz istek kilit alıp başkasının kolon düzenlemesini bekletemez).
   İletiler sonraki denetimlerle aynı: iki proje için de görme + project.columns. Olmayan proje burada atlanır
   (sonraki denetimler reddeder). */
async function colAuth(c, ctx, pre, next) {
  if (isAdminRole(ctx.me.role)) return;
  for (const pid of new Set([pre, next])) {
    const p = await projById(c, pid);
    if (p) await needPerm(c, ctx, p, 'project.columns');
  }
}
async function colAllowed(c, ctx, pid) {
  try { await colAuth(c, ctx, pid, null); return true; }
  catch (e) { if (e instanceof HttpError) return false; throw e; }
}

/* Tür değişimi (hesaplanan türe göre): yetki + Pano'ya geçerken aktif sprint olmamalı. Proje satırı
   FOR UPDATE ile kilitli; sprint başlatma projeyi FOR SHARE okur → ikisi sıralanır. */
async function checkProjectType(c, ctx, id, data, cur) {
  if ((cur.type ?? '') === (data.type ?? '')) return;
  const on = await sprintOn(c);
  const to = projType(data, on);
  if (projType(cur, on) === to) return;
  await canConfigure(c, ctx, id);
  if (to === 'board' && (await c.query(`SELECT 1 FROM sprints WHERE project_id=$1 AND state='active' LIMIT 1`, [id])).rowCount)
    throw new HttpError(409, 'Önce aktif sprinti tamamlayın');
}

/* Sprint başlatma (aktif olmayan → aktif, ya da aktif sprintin projesi değişir), tamamlama (aktif → kapalı), aktif
   sprint silme ve projenin sprint süresi: projede "Sprint başlatma ve bitirme" (sprint.manage). İstemcideki
   canManageProject ile aynı. */
async function canManageSprint(c, ctx, pid) {
  if (isAdminRole(ctx.me.role)) return;
  const p = await projById(c, pid);
  if (!p) throw new HttpError(400, 'Sprintin projesi yok');
  await needPerm(c, ctx, p, 'sprint.manage');
}
async function checkSprintState(c, ctx, data, cur) {
  if (data.state === 'active' && (cur?.state !== 'active' || cur?.projectId !== data.projectId))
    await canManageSprint(c, ctx, data.projectId);
  /* Aktif sprintten her çıkış (tamamlama, geri çekme, başka projeye taşıma) alan yöneticisinde. */
  if (cur?.state === 'active' && (data.state !== 'active' || cur.projectId !== data.projectId))
    await canManageSprint(c, ctx, cur.projectId);
  /* Kapalı duruma her geçiş (başlamamış sprint dahil; yeni kayıt da) ve kapalıdan her çıkış alan yöneticisinde. */
  if (data.state === 'closed' && (cur?.state !== 'closed' || cur?.projectId !== data.projectId))
    await canManageSprint(c, ctx, data.projectId);
  if (cur?.state === 'closed' && (data.state !== 'closed' || cur.projectId !== data.projectId))
    await canManageSprint(c, ctx, cur.projectId);
}

/* Türü açıkça Pano (type === 'board') olan projede sprint başlatılamaz (aktif olan ya da projesi değişen
   aktif sprint). Türsüz (eski) projelere uygulanmaz: eski veri / demo yüklemesindeki aktif sprintler düşmesin. */
async function checkSprintStart(c, data, cur) {
  if (data.state !== 'active' || (cur?.state === 'active' && cur?.projectId === data.projectId)) return;
  const p = (await c.query('SELECT data FROM projects WHERE id=$1 FOR SHARE', [data.projectId])).rows[0]?.data;
  if (p?.type === 'board') throw new HttpError(400, 'Pano türündeki projede sprint başlatılamaz');
}

/* Sprint planı (`plan`: başlatma anındaki kapsam — sayı, puan, iş kimlikleri): yalnız sprint başlatılırken
   (aktif olmayan → aktif) ve başlatabilen (canManageSprint) yazar; yazıldıktan sonra değişmez, silinmez.
   Silinmiş (başlamış) bir sprint kimliğiyle yeniden oluşturmada plan yazılamaz (sil + aynı kimlikle başlat ile plan
   yeniden yazılamasın). İçe aktarma / geri yükleme (system) eski veriyi olduğu gibi yazar. */
const SPRINT_PLAN_LOCKED = 'Sprintin başlangıç planı değiştirilemez';
async function checkSprintPlan(c, ctx, id, data, cur, system) {
  if (same(cur?.plan ?? null, data.plan ?? null)) return;
  if (system) return;
  if (cur?.plan != null) throw new HttpError(403, SPRINT_PLAN_LOCKED);
  if (data.plan == null) return;
  if (data.state !== 'active' || cur?.state === 'active') throw new HttpError(400, 'Sprint planı yalnızca sprint başlatılırken kaydedilir');
  /* Çöp kutusunda başlamış (planlı ya da aktif/kapalı) hâli duran kimlik yeniden plan alamaz; hiç başlamamış
     (gelecek) sprintin silinip yeniden oluşturulması ya da geri yüklenmesi engellenmez. */
  if ((await c.query(`SELECT 1 FROM deleted_records WHERE collection='sprints' AND record_id=$1
      AND (data->'plan' IS NOT NULL AND data->'plan' <> 'null'::jsonb OR data->>'state' IN ('active','closed')) LIMIT 1`, [id])).rowCount)
    throw new HttpError(403, SPRINT_PLAN_LOCKED);
  await canManageSprint(c, ctx, data.projectId);
}

const colStats = async (c, pid) => {
  const rows = (await c.query(`SELECT id, data->>'name' AS name, data->>'cat' AS cat FROM statuses WHERE project_id=$1`, [pid])).rows;
  return { total: rows.length, done: rows.filter(r => r.cat === 'done').length, rows };
};

/* Projenin ilk kolon değişikliğinden önce: danışma kilidi + o anki durum (gönderim sonu denetimi için). */
async function lockColumns(c, ctx, pids) {
  for (const pid of [...new Set(pids.filter(p => typeof p === 'string' && p))].sort()) {
    if (ctx.cols.has(pid)) continue;
    await c.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [COL_LOCK, pid]);
    ctx.cols.set(pid, await colStats(c, pid));
  }
}

/* Gönderim sonu bütünlük: ihlalde tüm gönderim 409 ile geri alınır. Aynı gönderimde silinen (ya da hiç
   olmayan) proje atlanır. Eski projede Bitti kolonu hiç yoksa Bitti kuralı işlemez. */
async function checkColumns(c, ctx) {
  for (const [pid, before] of ctx.cols) {
    if (!(await c.query('SELECT 1 FROM projects WHERE id=$1', [pid])).rowCount) continue;
    const after = await colStats(c, pid);
    if (before.done > 0 && after.done === 0) throw new HttpError(409, 'Projede en az bir Bitti kolonu kalmalı');
    if (before.total > 0 && after.total === 0) throw new HttpError(409, 'Projenin son kolonu silinemez');
    if (after.total > before.total && after.total > MAX_COLUMNS)
      throw new HttpError(409, `Bir projede en fazla ${MAX_COLUMNS} kolon olabilir`);
    const clash = after.rows.some(r => ctx.colNamed.has(r.id)
      && after.rows.some(o => o.id !== r.id && colName(o.name) === colName(r.name)));
    if (clash) throw new HttpError(409, 'Bu adla bir kolon zaten var');
  }
}

/* ---- iş akışı geçiş kuralları (gk, Jira "conditions/validators") ----
   Proje kaydında `gates` (validate.js gatesError): bir kolona (statusId) ya da bir kategoriye (cat) geçmek için koşullar.
   Yalnız var olan işin kolonu değişince ve yalnız canlı yazmada (/api/sync) uygulanır; kural yoksa (varsayılan) hiçbir şey
   değişmez. Muaf yollar: sistem yazması (e-postadan iş/yanıt, ctx.system), içe aktarma / geri yükleme / çöpten geri alma
   (backup.js, bu kapıdan geçmez), yeni iş oluşturma (geçiş değil) ve kolon silmede toplu taşıma (kaynak kolon aynı gönderimde
   silinir ve kişinin "Kolonlar" yetkisi var; silme olmazsa gönderim sonunda tüm gönderim reddedilir). Otomasyon kuralları
   tarayıcıda kişi adına çalıştığından muaf DEĞİL: sunucu otomasyonla elle taşımayı ayıramaz (istemci de kuralı atlar).
   Kategori kuralı kategoriye GİRİŞTE işler (Bitti → başka Bitti kolonu geçişi değil); kolon kuralı her girişte.
   Koşullar aynı gönderimdeki bekleyen değişikliklerle (süre kaydı, alt iş, bağlantı) birlikte değerlendirilir; gönderim
   sonunda gerçek durumla yeniden denetlenir (eşlik eden değişiklik reddedildiyse tüm gönderim 409). İstemcideki gateCheck
   ile aynı kural ve iletiler (public/index.html). */
const GATE_BIND = { billable: 'Faturalama', billType: 'Fatura türü', customerId: 'Cari' };
const GATE_ROLE_NAME = { admin: 'Yönetici', member: 'Üye', viewer: 'İzleyici' };
export const GATE_COLDEL = 'Kolon silinemedi: taşınan işler geçiş kuralına takılıyor';
/* "Bitti" → "Bitti'ye", "İnceleniyor" → "İnceleniyor'a"; harfle bitmeyen ad → "\"X1\" kolonuna". */
export function gateTarget(name) {
  const s = String(name ?? '').trim().slice(0, 60);
  const low = s.toLocaleLowerCase('tr'), V = 'aeıioöuü';
  const v = [...low].reverse().find(ch => V.includes(ch));
  if (!s || !/\p{L}$/u.test(s) || !v) return `"${s || 'Bu'}" kolonuna`;
  return `${s}'${V.includes(low.slice(-1)) ? 'y' : ''}${'aıou'.includes(v) ? 'a' : 'e'}`;
}
const gateAsk = (name, type) => `${String(name).trim().slice(0, 60)} ${['select', 'user', 'cari'].includes(type) ? 'seçin'
  : type === 'checkbox' ? 'işaretleyin' : 'girin'}`;
const filled = v => v != null && v !== false && !(typeof v === 'string' && !v.trim());
function gateCtx(ctx, list) {
  ctx.pending = list;
  ctx.pendingBy = new Map();
  ctx.delStatuses = new Set(list.filter(ch => ch?.c === 'statuses' && ch.op === 'del' && typeof ch.id === 'string').map(ch => ch.id));
  ctx.gateRej = new Map();
  ctx.gateLater = [];
  ctx.gateColDel = new Set();
}
/* Gönderimdeki bekleyen kayıtlar (son yazan kazanır): kimlik → veri (silme: null). */
function pendingOf(ctx, col) {
  if (ctx.pendingBy.has(col)) return ctx.pendingBy.get(col);
  const m = new Map();
  for (const ch of ctx.pending) if (ch?.c === col && typeof ch.id === 'string')
    if (ch.op === 'del') m.set(ch.id, null);
    else if (ch.op === 'put' && ch.data && typeof ch.data === 'object' && !Array.isArray(ch.data)) m.set(ch.id, { ...ch.data, id: ch.id });
  ctx.pendingBy.set(col, m);
  return m;
}
/* Kolonlar (kategori ve ad), bekleyen kolon değişiklikleri dahil. */
async function gateStatuses(c, ctx, ids, overlay) {
  const list = ids.filter(x => typeof x === 'string' && x);
  const out = new Map((await c.query('SELECT id, data FROM statuses WHERE id = ANY($1)', [list])).rows.map(r => [r.id, r.data]));
  if (overlay) for (const id of list) if (pendingOf(ctx, 'statuses').has(id)) {
    const d = pendingOf(ctx, 'statuses').get(id);
    if (d) out.set(id, d); else out.delete(id);
  }
  return out;
}
/* Kayıtlar (DB + bekleyen): where ile seçilenler; bekleyenlerden keep(d) tutanlar eklenir, tutmayanlar ve silinenler çıkar. */
async function gateRows(c, ctx, table, where, args, keep, overlay) {
  const m = new Map((await c.query(`SELECT id, data FROM ${table} WHERE ${where}`, args)).rows.map(r => [r.id, r.data]));
  if (overlay) for (const [id, d] of pendingOf(ctx, table)) { if (d && keep(d)) m.set(id, d); else m.delete(id); }
  return m;
}
async function gateIssues(c, ctx, ids, overlay) {
  const m = new Map((await c.query('SELECT id, data FROM issues WHERE id = ANY($1)', [ids])).rows.map(r => [r.id, r.data]));
  if (overlay) for (const id of ids) if (pendingOf(ctx, 'issues').has(id)) {
    const d = pendingOf(ctx, 'issues').get(id);
    if (d) m.set(id, d); else m.delete(id);
  }
  return m;
}
/* İşe uyan kurallar (yoksa null): projenin kuralları, hedef kolon ve kaynak kolonun kategorisine göre. */
async function gatesHit(c, ctx, p, to, from, overlay) {
  const gates = Array.isArray(p?.gates) ? p.gates.filter(g => g && typeof g === 'object' && !Array.isArray(g)) : [];
  if (!gates.length) return null;
  const st = await gateStatuses(c, ctx, [to, from], overlay);
  const toS = st.get(to);
  if (!toS) return null;
  const fromCat = st.get(from)?.cat ?? null;
  const hit = gates.filter(g => (typeof g.statusId === 'string' && g.statusId === to)
    || (typeof g.cat === 'string' && g.cat === toS.cat && fromCat !== toS.cat));
  return hit.length ? { hit, toS } : null;
}
/* Eksikler: { code, msg } ya da null. overlay: aynı gönderimdeki bekleyen değişiklikler sayılır. */
async function gateMissing(c, ctx, p, d, hit, toS, overlay) {
  const target = gateTarget(toS.name);
  const allow = hit.filter(g => Array.isArray(g.roles));
  if (allow.length) {
    const r = await roleIn(c, ctx.me, p);
    if (r !== 'admin' && !allow.every(g => g.roles.includes(r))) {
      const ok = ['admin', ...['member', 'viewer'].filter(x => allow.every(g => g.roles.includes(x)))];
      return { code: 403, msg: `${target} yalnız ${ok.map(x => GATE_ROLE_NAME[x]).join(' ve ')} rolündekiler taşıyabilir` };
    }
  }
  const any = k => hit.some(g => g[k] === true);
  const items = [];
  const iid = d.id;
  if (any('worklog')) {
    const w = await gateRows(c, ctx, 'worklogs', 'issue_id=$1', [iid], x => x.issueId === iid, overlay);
    if (![...w.values()].some(x => Number(x?.hours) > 0)) items.push('süre kaydı girin');
  }
  if (any('assignee') && !(typeof d.assignee === 'string' && d.assignee)) items.push('atanan seçin');
  for (const ref of [...new Set(hit.flatMap(g => Array.isArray(g.fields) ? g.fields : []))]) {
    if (typeof ref !== 'string') continue;
    if (ref.startsWith('bind:')) {
      const b = ref.slice(5);
      if (!Object.hasOwn(GATE_BIND, b)) continue;
      const rec = (await c.query(`SELECT data FROM fields WHERE project_id=$1 AND data->>'bind'=$2`, [p.id, b])).rows[0]?.data;
      if (rec?.archived === true) continue;                    // alan projede kapalı: koşul yok sayılır
      const name = (typeof rec?.name === 'string' && rec.name.trim()) || GATE_BIND[b];
      if (b === 'customerId') {
        if (await customersOff(c, ctx)) continue;
        /* İstemcideki customerIdOf ile aynı: işin carisi, yoksa projenin carisi (var olan cari kaydı). */
        const ids = [d.customerId, p.customerId].filter(x => typeof x === 'string' && x);
        const has = ids.length > 0 && (await c.query('SELECT 1 FROM customers WHERE id = ANY($1) LIMIT 1', [ids])).rowCount > 0;
        if (!has) items.push(gateAsk(name, 'cari'));
      } else if (!filled(d[b])) items.push(gateAsk(name, 'select'));
      continue;
    }
    if (!ref.startsWith('cf:')) continue;
    const fid = ref.slice(3);
    const f = (await c.query('SELECT data FROM fields WHERE id=$1', [fid])).rows[0]?.data;
    /* Silinmiş, kapalı/gizli, hazır, cari ya da başka projenin alanı: doldurulamaz, koşul yok sayılır. */
    if (!f || f.bind || f.archived === true || f.hidden === true || f.scope === 'customer' || (f.projectId && f.projectId !== p.id)) continue;
    const v = d.cf && typeof d.cf === 'object' ? d.cf[fid] : undefined;
    if (!filled(v)) items.push(gateAsk(f.name || 'Alan', f.type));
  }
  if (any('subsDone')) {
    const kids = await gateRows(c, ctx, 'issues', 'parent_id=$1', [iid], x => x.parentId === iid, overlay);
    kids.delete(iid);
    const st = await gateStatuses(c, ctx, [...new Set([...kids.values()].map(k => k.statusId))], overlay);
    const open = [...kids.values()].filter(k => st.get(k.statusId)?.cat !== 'done').length;
    if (open) items.push(`alt işleri bitirin (${open} açık)`);
  }
  if (any('noBlockers')) {
    const lk = await gateRows(c, ctx, 'links', `to_issue=$1 AND link_type='blocks'`, [iid], x => x.to === iid && x.type === 'blocks', overlay);
    const from = [...new Set([...lk.values()].map(l => l.from).filter(x => typeof x === 'string' && x && x !== iid))];
    const bl = await gateIssues(c, ctx, from, overlay);
    const st = await gateStatuses(c, ctx, [...new Set([...bl.values()].map(x => x.statusId))], overlay);
    const open = [...bl.values()].filter(x => st.get(x.statusId)?.cat !== 'done').length;
    if (open) items.push(`engelleyen işleri kapatın (${open} açık)`);
  }
  return items.length ? { code: 409, msg: `${target} geçmek için: ${items.join(', ')}` } : null;
}
async function checkGates(c, ctx, data, cur) {
  if (ctx.system || typeof data.statusId !== 'string' || !data.statusId || data.statusId === cur.statusId) return;
  const p = await projById(c, data.projectId);
  const g = await gatesHit(c, ctx, p, data.statusId, cur.statusId, true);
  if (!g) return;
  /* Kolon silmede toplu taşıma: kaynak kolon bu gönderimde siliniyor ve kişi kolonları yönetebiliyor. */
  if (ctx.delStatuses.has(cur.statusId) && cur.projectId === data.projectId && await colAllowed(c, ctx, cur.projectId)) {
    ctx.gateColDel.add(cur.statusId);
    return;
  }
  const miss = await gateMissing(c, ctx, p, data, g.hit, g.toS, true);
  if (miss) {
    ctx.gateRej.set(data.id, { to: data.statusId, reason: miss.msg });
    throw new HttpError(miss.code, miss.msg);
  }
  ctx.gateLater.push({ id: data.id, to: data.statusId, pid: data.projectId, hit: g.hit, toS: g.toS });
}
/* Reddedilen geçişin aynı gönderimdeki yeni geçiş kaydı ve "Durum" geçmiş satırı da yazılmaz (olmamış taşıma görünmesin). */
function gateOrphan(ctx, ch, cur) {
  const r = ctx.gateRej?.get(ch.data?.issueId);
  if (!r || cur) return;
  if (ch.c === 'transitions' ? ch.data.to === r.to : ch.data.field === 'Durum') throw new HttpError(409, r.reason);
}
/* Gönderim sonu: koşullar gerçek durumla (bekleyen değişiklikler uygulandıktan sonra) yeniden; ihlalde tüm gönderim 409. */
async function recheckGates(c, ctx) {
  for (const sid of ctx.gateColDel)
    if ((await c.query('SELECT 1 FROM statuses WHERE id=$1', [sid])).rowCount) throw new HttpError(409, GATE_COLDEL);
  for (const x of ctx.gateLater) {
    const d = (await c.query('SELECT data FROM issues WHERE id=$1', [x.id])).rows[0]?.data;
    if (!d || d.statusId !== x.to || d.projectId !== x.pid) continue;
    const miss = await gateMissing(c, ctx, await projById(c, x.pid), { ...d, id: x.id }, x.hit, x.toS, false);
    if (miss) throw new HttpError(409, miss.msg);
  }
}

/* ---- çalışma alanları (#22) ----
   Genel (ws1) varsayılan alandır: silinmez, arşivlenmez, adını yalnız yönetici değiştirir.
   Alanı olmayan proje Genel'de sayılır. */
export const DEFAULT_WS = 'ws1';
const WS_LOCK = 727275;
const wsName = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr');

/* Yönetici olmayanın yeni geçmiş kaydı: yazar = oturum, zaman sunucu saatine ±5 dk (yoksa/geçersizse şimdi). */
function enforceHistoryAuthor(data, me) {
  let changed = false;
  if (data.userId !== me.id) { data.userId = me.id; changed = true; }
  const now = Date.now();
  const t = typeof data.at === 'number' ? data.at : typeof data.at === 'string' ? Date.parse(data.at) : NaN;
  const at = Number.isFinite(t) ? Math.min(now + HIST_SKEW_MS, Math.max(now - HIST_SKEW_MS, t)) : now;
  if (at !== data.at) { data.at = at; changed = true; }
  return changed;
}

/* Açan kişi istemciden alınmaz: yeni alanda oturumdaki kullanıcı, var olanda kayıttaki değer. */
function enforceCreatedBy(data, cur, me) {
  const before = data.createdBy;
  if (!cur) data.createdBy = me.id;
  else if (Object.hasOwn(cur, 'createdBy')) data.createdBy = cur.createdBy;
  else delete data.createdBy;
  return !same(before, data.createdBy);
}

async function checkWorkspace(c, me, id, data, cur) {
  if (!cur && !isAdminRole(me.role)) throw new HttpError(403, WS_CREATE_FORBIDDEN);
  if (cur && !isAdminRole(me.role) && !isWsAdmin(me, cur))
    throw new HttpError(403, 'Bu çalışma alanını yalnızca alan yöneticisi değiştirebilir');
  const archiving = data.archived === true && cur?.archived !== true;
  if (archiving && id === DEFAULT_WS) throw new HttpError(400, 'Genel çalışma alanı arşivlenemez');
  const active = data.archived !== true;
  const needsName = active && (!cur || cur.archived === true || wsName(cur.name) !== wsName(data.name));
  if (!archiving && !needsName) return;
  /* Ad tekilliği ve "son etkin alan" kontrolü eşzamanlı yazmalarda da doğru kalsın. */
  await c.query('SELECT pg_advisory_xact_lock($1)', [WS_LOCK]);
  const others = (await c.query('SELECT name FROM workspaces WHERE NOT archived AND id <> $1', [id])).rows;
  if (archiving && others.length === 0) throw new HttpError(400, 'Son etkin çalışma alanı arşivlenemez');
  if (needsName && others.some(r => wsName(r.name) === wsName(data.name)))
    throw new HttpError(409, 'Bu adla etkin bir çalışma alanı zaten var');
}

async function checkWorkspaceDelete(c, id) {
  if (id === DEFAULT_WS) throw new HttpError(400, 'Genel çalışma alanı silinemez');
  const used = await c.query(
    `SELECT 1 FROM projects WHERE coalesce(nullif(workspace_id, ''), $2) = $1 LIMIT 1`, [id, DEFAULT_WS]);
  if (used.rowCount) throw new HttpError(409, 'Önce projeleri taşıyın');
}

/* Proje yeni açılıyorsa ya da alanı değiştiyse (güncel kayda göre) hedef alan var ve etkin olmalı.
   FOR SHARE: aynı anda alan silinir/arşivlenirse biri bekler. */
async function checkProjectWorkspace(c, data, cur) {
  const ws = data.workspaceId;
  if (ws == null || ws === '') return;
  if (cur && (cur.workspaceId ?? '') === ws) return;
  const row = (await c.query('SELECT archived FROM workspaces WHERE id=$1 FOR SHARE', [ws])).rows[0];
  if (!row) throw new HttpError(400, 'Çalışma alanı bulunamadı');
  if (row.archived) throw new HttpError(400, 'Arşivlenmiş çalışma alanına proje taşınamaz');
}

/* ---- çalışma alanı yöneticileri ve proje rolleri (yetki-v2) ----
   Alan yöneticisi: sahip (ownerId, yoksa createdBy) ve workspaces.data.admins (perms.js wsAdminIds). Alan üyesi / alan
   izleyicisi rolü yoktur: workspaces.data.members yalnız eski (rolü olmayan) projelerin geri uyumu için saklanır.
   Etkin proje rolü TEK yerde: perms.js projRole (istemcideki projRole ile aynı). */
export const WS_ROLES = ['admin', 'member', 'viewer'];
const WS_MAX_MEMBERS = 1000;
export const WS_CREATE_FORBIDDEN = 'Çalışma alanını yalnızca yönetici açabilir';
const WS_SCOPED = ['projects', 'statuses', 'sprints', 'issues', 'worklogs', 'comments', 'history', 'transitions', 'links', 'fields', 'workspaces'];
const ISSUE_SCOPED = ['worklogs', 'comments', 'history', 'transitions'];
export { wsOwner } from './perms.js';
export const wsLegacy = ws => !Array.isArray(ws?.members) || ws.members.length === 0;
/* Projenin alanı (olmayan alana bağlı ya da alansız proje Genel sayılır). */
const projWsId = p => (typeof p?.workspaceId === 'string' && p.workspaceId ? p.workspaceId : DEFAULT_WS);
async function wsOfProjectData(c, p) {
  const id = projWsId(p);
  const r = (await c.query(`SELECT data FROM workspaces WHERE id = $1 OR id = $2 ORDER BY (id = $1) DESC LIMIT 1`, [id, DEFAULT_WS])).rows[0];
  return r?.data;
}
const projById = async (c, pid) => typeof pid === 'string' && pid
  ? (await c.query('SELECT data FROM projects WHERE id=$1', [pid])).rows[0]?.data : undefined;
const issueProj = async (c, iid) => typeof iid === 'string' && iid
  ? (await c.query('SELECT project_id FROM issues WHERE id=$1', [iid])).rows[0]?.project_id : undefined;

/* Sistem varsayılanı yetki tablosu (settings.perms) — gönderim başına bir kez okunur (ayar değişince sıfırlanır). */
async function sysPermsOf(c, ctx) {
  if (ctx && ctx.sysPerms !== undefined) return ctx.sysPerms;
  const v = (await c.query(`SELECT value FROM settings WHERE key='perms'`)).rows[0]?.value ?? null;
  if (ctx) ctx.sysPerms = v;
  return v;
}
/* Kişinin projedeki etkin rolü (proje yoksa null). */
async function roleIn(c, u, p) { return p ? projRole(u, p, await wsOfProjectData(c, p)) : null; }
export const NO_ACCESS = 'Bu projeye erişiminiz yok';
export const permMsg = key => `Bu projede "${PERM_LABEL[key]}" yetkiniz yok`;
/* Projede anahtarlardan en az birinin yetkisi (yoksa 403). Projeyi göremeyene her yazmada aynı ileti (kayıt var/yok
   sızmasın). Olmayan proje atlanır: kaydın kendi doğrulaması reddeder (eski davranış). */
async function needPerm(c, ctx, p, ...keys) {
  if (!p || isAdminRole(ctx.me.role)) return;
  const r = await roleIn(c, ctx.me, p);
  if (!r) throw new HttpError(403, NO_ACCESS);
  const sys = await sysPermsOf(c, ctx);
  if (!keys.some(k => roleCan(r, p, sys, k))) throw new HttpError(403, permMsg(keys[0]));
}

/* ---- okuma süzmesi (18, yetki-v2) ----
   Erişim kuralı TEK yerde: projRole !== null (projeye eklenmiş, proje sahibi, alan yöneticisi ya da sistem yöneticisi).
   Yazma (needPerm) da önce bu rolü ister: okunamayan proje yazılamaz. Sistem yöneticisi süzülmez.
   Alan kaydı: alan yöneticisine, alanında görebildiği projesi olana ve yöneticisi olmayan alanlarda (Genel gibi: orada
   genel rolü Üye olan da proje açar) herkese gider.
   Projeye bağlı tablolar projectId, işe bağlılar issueId, bağlantılar iki ucundan biri üzerinden süzülür.
   Proje bağımsız tablolar (users, customers, filters, genel fields/rules, settings, misc_records) olduğu gibi gider. */
export const ACCESS_CH = '_access';
const BY_PROJECT = ['statuses', 'sprints', 'issues', 'fields', 'rules'];
const BY_ISSUE = ['worklogs', 'comments', 'history', 'transitions'];
const SCOPED_READ = ['workspaces', 'projects', ...BY_PROJECT, ...BY_ISSUE, 'links', 'reports'];
/* Görünen alan ve proje kimlikleri. */
function buildScope(me, workspaces, projects) {
  const wsMap = new Map(workspaces.filter(w => w && w.id).map(w => [w.id, w]));
  /* Olmayan alana bağlı proje Genel'e, Genel de yoksa alansız sayılır: wsOfProjectData ile aynı. */
  const wsOfP = p => wsMap.get(projWsId(p)) ?? wsMap.get(DEFAULT_WS);
  const proj = new Set(projects.filter(p => p && p.id && projRole(me, p, wsOfP(p)) !== null).map(p => p.id));
  const wsOk = new Set([...wsMap.values()].filter(w => w.id === DEFAULT_WS || isWsAdmin(me, w) || wsHasNoAdmin(w)).map(w => w.id));
  /* Alan kapsamlı paylaşılan rapor (reportVisible): yalnız alan yöneticisi (sistem yöneticisi zaten süzülmez). */
  const wsRep = new Set([...wsMap.values()].filter(w => isWsAdmin(me, w)).map(w => w.id));
  for (const p of projects) if (p && proj.has(p.id)) { const w = wsOfP(p); if (w) wsOk.add(w.id); }
  return { me, wsOk, wsRep, proj };
}
/* Kayıt görünür mü (issueOk: iş kimliği → görünür mü). */
function recordVisible(col, d, scope, issueOk) {
  if (!d || typeof d !== 'object') return true;
  if (col === 'workspaces') return scope.wsOk.has(d.id);
  if (col === 'projects') return scope.proj.has(d.id);
  if (BY_PROJECT.includes(col)) {
    /* Genel özel alan / kural (projesiz) herkese gider. */
    if ((col === 'fields' || col === 'rules') && (d.projectId == null || d.projectId === '')) return true;
    return scope.proj.has(d.projectId);
  }
  if (BY_ISSUE.includes(col)) return issueOk(d.issueId);
  if (col === 'links') return issueOk(d.from) || issueOk(d.to);
  if (col === 'reports') return reportVisible(d, scope);
  return true;
}
/* İlk yükleme: bellekteki tam veriden süz. */
export function scopeData(data, me) {
  if (!me || isAdminRole(me.role)) return data;
  const scope = buildScope(me, data.workspaces || [], data.projects || []);
  const ok = new Set((data.issues || []).filter(i => i && scope.proj.has(i.projectId)).map(i => i.id));
  const issueOk = id => ok.has(id);
  for (const col of SCOPED_READ)
    if (Array.isArray(data[col])) data[col] = data[col].filter(d => recordVisible(col, d, scope, issueOk));
  if (Array.isArray(data.workspaces)) data.workspaces = data.workspaces.map(w => wsForReader(w, me));
  return data;
}
/* Alan kaydındaki eski üye listesi (members: kişi ve eski alan rolü) yalnız alan yöneticisine gider (D-2). admins'i
   olmayan eski alanda yöneticiler üye listesinden hesaplandığı için admins okuyana hesaplanmış olarak yazılır. */
function wsForReader(w, me) {
  if (!w || typeof w !== 'object' || !Object.hasOwn(w, 'members') || isWsAdmin(me, w)) return w;
  const { members: _m, ...rest } = w;
  if (!Array.isArray(rest.admins)) { const o = wsOwner(w); rest.admins = wsAdminIds(w).filter(x => x !== o); }
  return rest;
}
/* Değişiklik akışı: yalnız görünen kayıtların güncel hâli gider; silme bildirimleri (yalnız kimlik) olduğu gibi. */
async function scopeItems(db, me, items) {
  if (!items.some(i => i.op === 'put' && SCOPED_READ.includes(i.c))) return items;
  const scope = buildScope(me, (await db.query('SELECT data FROM workspaces')).rows.map(r => r.data),
    (await db.query('SELECT data FROM projects')).rows.map(r => r.data));
  const ids = new Set();
  for (const i of items) if (i.op === 'put' && i.data) {
    if (BY_ISSUE.includes(i.c)) ids.add(i.data.issueId);
    if (i.c === 'links') { ids.add(i.data.from); ids.add(i.data.to); }
  }
  const ok = new Set();
  const list = [...ids].filter(x => typeof x === 'string');
  if (list.length) for (const r of (await db.query('SELECT id, project_id FROM issues WHERE id = ANY($1)', [list])).rows)
    if (scope.proj.has(r.project_id)) ok.add(r.id);
  /* Görünmez olan rapor (paylaşımdan çıkarıldı) silme bildirimiyle gider: önceden alan istemcide kalmasın. */
  return items.flatMap(i => i.op !== 'put' || recordVisible(i.c, i.data, scope, id => ok.has(id))
    ? [i.op === 'put' && i.c === 'workspaces' ? { ...i, data: wsForReader(i.data, me) } : i]
    : i.c === 'reports' ? [{ c: i.c, id: i.id, op: 'del', seq: i.seq }] : []);
}
/* Erişim kümesi değişti: ilgili kullanıcıya (ya da '*' herkese) tam yeniden yükleme sinyali. */
async function logAccess(c, ctx, uids) {
  for (const u of new Set(uids)) if (typeof u === 'string' && u) await logChange(c, ACCESS_CH, u, 'put', ctx.me.id, ctx.batch);
}
/* Alan kaydı değişince erişimi değişen kullanıcılar: alan yöneticisi farkı; eski üye listesi değiştiyse (yalnız rolü
   olmayan eski projeleri etkiler) herkes. */
function wsAccessDiff(cur, data) {
  if (!cur) return [];                                 // yeni alan: yöneticileri kaydı değişiklikle alır
  if (!same(cur.members ?? null, data.members ?? null)) return ['*'];
  const a = new Set(wsAdminIds(cur)), b = new Set(wsAdminIds(data));
  return [...a].filter(x => !b.has(x)).concat([...b].filter(x => !a.has(x)));
}
/* Proje kaydı değişince erişimi değişen kullanıcılar: eklenen/çıkarılan kişi ve sahip farkı; alan değiştiyse ya da
   rolü olmayan eski projeye ilk kez roles yazıldıysa herkes. Yalnız rol değişimi (Üye → İzleyici) erişimi değiştirmez. */
function projAccessDiff(cur, data) {
  if (projWsId(cur) !== projWsId(data)) return ['*'];
  if (!isObj(cur.roles) && isObj(data.roles)) return ['*'];
  const ids = p => new Set([...Object.keys(isObj(p.roles) ? p.roles : {}), p.ownerId].filter(Boolean));
  const a = ids(cur), b = ids(data);
  return [...a].filter(x => !b.has(x)).concat([...b].filter(x => !a.has(x)));
}
/* Alanın projeleri (alansız ya da olmayan alana bağlı proje Genel'de sayılır: wsOfProjectData ile aynı). */
async function wsProjectIds(c, wsId) {
  return (await c.query(`SELECT p.id FROM projects p WHERE coalesce(nullif(p.workspace_id, ''), $2) = $1
      OR ($1 = $2 AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = p.workspace_id))`, [wsId, DEFAULT_WS])).rows.map(r => r.id);
}
/* Projelerin işlerinde projeyi artık göremeyen atananı boşaltır; işin geçmişine "Atanan → —" yazılır. Değişen işler
   değişiklik akışına ve `adjusted`'a düşer. */
async function clearLostAssignees(c, ctx, pids) {
  if (!pids.length) return;
  const { me, batch } = ctx;
  const rows = (await c.query(`SELECT i.id, i.data, i.project_id, u.id AS uid, u.role, u.name, u.system FROM issues i JOIN users u ON u.id = i.assignee_id
      WHERE i.project_id = ANY($1) ORDER BY i.id FOR UPDATE OF i`, [pids])).rows;
  const projs = new Map();
  for (const r of rows) {
    if (!projs.has(r.project_id)) { const p = await projById(c, r.project_id); projs.set(r.project_id, p ? [p, await wsOfProjectData(c, p)] : null); }
    const pw = projs.get(r.project_id);
    if (!pw || projRole({ id: r.uid, role: r.role, system: r.system }, pw[0], pw[1]) !== null) continue;
    const now = Date.now();
    await c.query('UPDATE issues SET data=$2::jsonb, version=version+1, updated_at=now(), updated_by=$3 WHERE id=$1',
      [r.id, JSON.stringify({ ...r.data, assignee: null, updatedAt: now }), me.id]);
    await logChange(c, 'issues', r.id, 'put', me.id, batch);
    const h = { id: 'h_' + randomUUID().replace(/-/g, '').slice(0, 16), issueId: r.id, userId: me.id, at: now,
      field: 'Atanan', from: String(r.name || r.uid).slice(0, HIST_TEXT_MAX), to: '—' };
    await c.query('INSERT INTO history (id, data, updated_by) VALUES ($1, $2::jsonb, $3)', [h.id, JSON.stringify(h), me.id]);
    await logChange(c, 'history', h.id, 'put', me.id, batch);
    if (!ctx.adjusted.some(x => x.c === 'issues' && x.id === r.id)) ctx.adjusted.push({ c: 'issues', id: r.id });
  }
}
/* Bildirim alıcısı (notify.js): kişi projeyi görebiliyor mu (okuma süzmesiyle aynı kural). */
export async function userSeesProject(c, userId, pid) {
  const u = (await c.query('SELECT id, role, active, system FROM users WHERE id=$1', [userId])).rows[0];
  if (!u) return false;
  if (isAdminRole(u.role)) return true;
  return (await roleIn(c, u, await projById(c, pid))) !== null;
}
/* Bir işe erişim (posta yanıtı, mail.js): yoksa ya da okunamıyorsa null; varsa { data, role, write }.
   write: projede "Yorum yazma" yetkisi (e-postayla yanıt yorum ekler). */
export async function issueAccess(c, me, iid) {
  if (typeof iid !== 'string' || !iid) return null;
  const row = (await c.query('SELECT data FROM issues WHERE id=$1', [iid])).rows[0];
  if (!row) return null;
  const p = await projById(c, row.data?.projectId);
  const r = isAdminRole(me?.role) ? 'admin' : await roleIn(c, me, p);
  return r ? { data: row.data, role: r, write: roleCan(r, p, await sysPermsOf(c, null), 'comment.write') } : null;
}
/* Atanabilir kişi: projede "İş düzenleme" yetkisi olan (sistem/alan yöneticisi ve sahip dahil). */
export const ASSIGNEE_NO_ACCESS = 'Atanan kişinin bu projede iş düzenleme yetkisi yok';
async function assignable(c, ctx, u, pid) {
  const p = await projById(c, pid);
  if (!p) return true;                                  // olmayan proje: işin kendi doğrulaması reddeder
  return roleCan(await roleIn(c, u, p), p, await sysPermsOf(c, ctx), 'issue.edit');
}
/* Bildirim listesi için (notify.js): kişinin görebildiği projeler; sistem yöneticisinde null (hepsi). */
export async function visibleProjectIds(db, me) {
  if (!me || isAdminRole(me.role)) return null;
  return buildScope(me, (await db.query('SELECT data FROM workspaces')).rows.map(r => r.data),
    (await db.query('SELECT data FROM projects')).rows.map(r => r.data)).proj;
}
/* Çevrim içi listesi (app.js): kişinin görebildiği iş kimlikleri; sistem yöneticisinde null (hepsi). */
export async function visibleIssueIds(db, me, ids) {
  if (!me || isAdminRole(me.role)) return null;
  const list = [...new Set(ids)].filter(x => typeof x === 'string' && x);
  if (!list.length) return new Set();
  const rows = (await db.query('SELECT id, project_id FROM issues WHERE id = ANY($1)', [list])).rows;
  if (!rows.length) return new Set();
  const proj = await visibleProjectIds(db, me);
  return new Set(rows.filter(r => proj.has(r.project_id)).map(r => r.id));
}
/* Yalnız sayaç (iş anahtarı) değişen proje kaydı: işi açan Üye de yazar. */
const onlyCounter = (a, b) => same({ ...a, counter: 0 }, { ...b, counter: 0 });

/* Projeye bağlı kayıtta yetki (yetki-v2, §5.2): kaydın projesinde etkin proje rolü + rol tablosu. Hem güncel kayıt (cur)
   hem yeni hâl (data) denetlenir: kayıt yetkisi olmayan projeye taşınamaz. early: kayda özgü kurallardan önce yalnız
   görme (projeyi göremeyene her yazmada aynı ileti). Çalışma alanı checkWorkspace'te, kolonlar canConfigure'da. */
const ISSUE_PERMS = { comments: ['comment.write'], worklogs: ['worklog.own'], history: ['issue.edit', 'issue.create'],
  transitions: ['issue.edit', 'issue.create'], links: ['issue.edit'], sprints: ['sprint.edit', 'sprint.manage'] };
const recProj = async (c, col, d) => projById(c, ISSUE_SCOPED.includes(col) ? await issueProj(c, d.issueId)
  : col === 'links' ? await issueProj(c, d.from) : d.projectId);
async function checkScope(c, ctx, col, cur, data, early = false) {
  const { me } = ctx;
  if (!WS_SCOPED.includes(col) || col === 'workspaces' || isAdminRole(me.role)) return;
  if (early) {
    if (col === 'projects') { if (cur && !(await roleIn(c, me, cur))) throw new HttpError(403, NO_ACCESS); return; }
    /* Güncel kayıt ve (bağı değişen) yeni hâl: gizli projeye taşıma da olmayan ebeveyne bağlama (checkParent) gibi erken
       ve aynı iletiyle reddedilir (D-3). */
    for (const d of cur && data ? [cur, data] : [cur ?? data]) {
      if (!d || (col === 'fields' && !d.projectId)) continue;
      const p = await recProj(c, col, d);
      if (p && !(await roleIn(c, me, p))) throw new HttpError(403, NO_ACCESS);
    }
    return;
  }
  if (col === 'statuses') return;                            // kolon yetkisi canConfigure'da
  if (col === 'projects') return checkProjectWrite(c, ctx, cur, data);
  if (col === 'fields') {
    /* Genel özel alan sistem yöneticisinde; projeye özel alan projede "Proje alanları" yetkisinde. */
    for (const d of [cur, data]) if (d) {
      const p = await projById(c, d.projectId);
      if (!p) throw new HttpError(403, 'Bu değişiklik için yönetici yetkisi gerekli');
      await needPerm(c, ctx, p, 'project.fields');
    }
    return;
  }
  if (col === 'issues') {
    if (cur && !data) return needPerm(c, ctx, await projById(c, cur.projectId), 'issue.delete');
    if (!cur) return needPerm(c, ctx, await projById(c, data.projectId), 'issue.create');
    await needPerm(c, ctx, await projById(c, cur.projectId), 'issue.edit');
    if (data.projectId !== cur.projectId) await needPerm(c, ctx, await projById(c, data.projectId), 'issue.create');
    return;
  }
  for (const d of [cur, data]) if (d) await needPerm(c, ctx, await recProj(c, col, d), ...ISSUE_PERMS[col]);
}

/* ---- bağlı kayıt ve silinmiş kimlik (O-1, D-3) ----
   Yeni bağlı kayıtta (ya da bağı değişince) projesi/işi var olmalı. Projeyi göremeyen için olmayan ebeveyn de gizli
   ebeveynle aynı yanıtı alır (403 NO_ACCESS; kayıt var/yok sızmasın); sistem yöneticisine 400. Sistem yolu (posta) ve
   içe aktarma (replaceAll) bu denetimden geçmez. Satır kilidi alınmaz (iş anahtarı ve harcanan süre ebeveyni FOR UPDATE
   kilitler; paylaşımlı kilit eşzamanlı yazmada kilitlenmeye yol açardı). Yorum, geçmiş ve bağlantı ayrıca FOR SHARE ile
   denetlenir; silinmiş projenin kimliği yeniden açılamadığından yarışta kalan yetim kayıt kimseye açılmaz. */
export const PARENT_MISSING = 'Bağlı kayıt bulunamadı';
const PARENT_REF = { statuses: ['projectId'], sprints: ['projectId'], issues: ['projectId'], fields: ['projectId'],
  rules: ['projectId'], worklogs: ['issueId'], comments: ['issueId'], history: ['issueId'], transitions: ['issueId'],
  links: ['from', 'to'] };
const SELF_PARENT_CHECK = ['history', 'comments', 'links'];
async function checkParent(c, ctx, col, data, cur) {
  const keys = PARENT_REF[col];
  if (!keys || !data || typeof data !== 'object') return;
  /* Geçmiş, yorum ve bağlantı yöneticiye kendi iletisiyle sonra (FOR SHARE) denetlenir. */
  if (isAdminRole(ctx.me.role) && SELF_PARENT_CHECK.includes(col)) return;
  const table = keys[0] === 'projectId' ? 'projects' : 'issues';
  for (const k of keys) {
    const v = data[k];
    if (cur && cur[k] === v) continue;                        // yalnız yeni kayıtta ya da bağı değişince
    if ((col === 'fields' || col === 'rules') && (v == null || v === '')) continue;   // genel alan / kural
    if (v == null && col !== 'transitions') continue;         // eksik bağ: kaydın kendi doğrulaması reddeder
    if (typeof v === 'string' && v && (await c.query(`SELECT 1 FROM ${table} WHERE id=$1`, [v])).rowCount) continue;
    throw isAdminRole(ctx.me.role) ? new HttpError(400, PARENT_MISSING) : new HttpError(403, NO_ACCESS);
  }
}
/* Silinmiş (çöpteki) projenin kimliğiyle yeni proje açılamaz: çöpten geri yükleme yolu (backup.js) bu denetimden geçmez. */
export const PROJECT_ID_USED = 'Bu proje kimliği silinmiş bir projeye ait; çöp kutusundan geri yükleyin';
async function checkProjectIdFree(c, ctx, id) {
  if (!(await c.query(`SELECT 1 FROM deleted_records WHERE collection='projects' AND record_id=$1 LIMIT 1`, [id])).rowCount) return;
  throw isAdminRole(ctx.me.role) ? new HttpError(409, PROJECT_ID_USED) : new HttpError(403, NO_ACCESS);
}
/* Olmayan kaydı silme: projeye bağlı koleksiyonlarda, sistem yöneticisi olmayana var olan gizli kayıtla aynı yanıt
   (D-3). Çöpteki kayıt (eşzamanlı silme, proje/iş silmenin cascade'i, aynı gönderimdeki alt kayıt silmesi) sessizce geçer. */
async function goneDel(c, ctx, col, id) {
  if (ctx.system || isAdminRole(ctx.me.role) || !WS_SCOPED.includes(col) || col === 'workspaces') return false;
  if ((await c.query('SELECT 1 FROM deleted_records WHERE collection=$1 AND record_id=$2 LIMIT 1', [col, id])).rowCount) return false;
  throw new HttpError(403, NO_ACCESS);
}

/* Proje kaydı. Yeni: sistem yöneticisi, hedef alanın yöneticisi; yöneticisi olmayan alanda (Genel gibi) genel rolü Üye
   olan da (açan kişi sahip ve proje Yöneticisi olur). Silme: projenin Yöneticisi ve üstü. Güncelleme: yalnız sayaç →
   iş açma; ad ve ayarlar → project.settings; kişiler, sahip ve yetki tablosu → proje Yöneticisi (tür ve sprint süresi
   kendi denetiminde). */
export const PROJECT_CREATE_FORBIDDEN = 'Bu alana yalnızca alan yöneticisi proje açabilir';
export const PROJECT_DELETE_FORBIDDEN = 'Projeyi yalnızca proje yöneticisi silebilir';
export const PROJECT_ACCESS_FORBIDDEN = 'Projenin kişilerini ve yetkilerini yalnızca proje yöneticisi değiştirebilir';
async function checkProjectWrite(c, ctx, cur, data) {
  const { me } = ctx;
  if (!cur) {
    const ws = await wsOfProjectData(c, data);
    if (isWsAdmin(me, ws) || ((!ws || wsHasNoAdmin(ws)) && me.role === 'member')) return;
    throw new HttpError(403, PROJECT_CREATE_FORBIDDEN);
  }
  const r = await roleIn(c, me, cur);
  if (!r) throw new HttpError(403, NO_ACCESS);
  if (!data) { if (r !== 'admin') throw new HttpError(403, PROJECT_DELETE_FORBIDDEN); return; }
  if (onlyCounter(cur, data)) return needPerm(c, ctx, cur, 'issue.create');
  if (!same(projSettings(cur), projSettings(data))) await needPerm(c, ctx, cur, 'project.settings');
  if (!same(projAccessPart(cur), projAccessPart(data)) && r !== 'admin') throw new HttpError(403, PROJECT_ACCESS_FORBIDDEN);
}

/* Bağlantının iki ucu da var olan iş olmalı (yeni bağlantıda ya da ucu değişince); `from` ucunda iş düzenleme
   (checkScope), `to` ucunda görme. FOR SHARE: uç aynı anda silinirse yetim kalmasın. */
async function checkLinkEnds(c, ctx, data, cur, system = false) {
  const { me } = ctx;
  if (cur && cur.from === data.from && cur.to === data.to) return;
  for (const end of [data.from, data.to]) {
    const pid = typeof end === 'string' && end
      ? (await c.query('SELECT project_id FROM issues WHERE id=$1 FOR SHARE', [end])).rows[0]?.project_id : undefined;
    if (pid === undefined) throw new HttpError(400, 'Bağlantının işi bulunamadı');
    const p = await projById(c, pid);
    if (!system && !isAdminRole(me.role) && p && !(await roleIn(c, me, p))) throw new HttpError(403, NO_ACCESS);
  }
}

/* Projeyi başka alana taşıma: kaynak ve hedef alanın ikisinde de alan yöneticisi; iki alandan biri yöneticisiz (Genel
   gibi) ise yalnız sistem yöneticisi. İstemcideki canMoveProj ile aynı. */
const MOVE_FORBIDDEN = 'Projeyi başka alana yalnızca iki alanın da yöneticisi taşıyabilir';
async function checkProjectMove(c, me, cur, data) {
  if (isAdminRole(me.role)) return;
  const a = await wsOfProjectData(c, cur), b = await wsOfProjectData(c, data);
  if ((a?.id ?? null) === (b?.id ?? null)) return;
  for (const w of [a, b]) if (!isWsAdmin(me, w)) throw new HttpError(403, MOVE_FORBIDDEN);
}

/* Alan yöneticileri (admins): biçim, tekil, var olan etkin kullanıcı; sahip listede tutulmaz (her zaman yönetici).
   admins göndermeyen istemcide güncel liste korunur. Eski istemcinin değiştirdiği üye listesi (members) yöneticileri
   değiştirmez (D-1): yalnız eski biçimde saklanır. admins'i olmayan eski alanda üye listesi değişirse yöneticiler
   güncel (değişiklik öncesi) listeden dondurulur. Yeni alanda verilmezse üye listesinden. Değiştiyse true. */
async function enforceWsAdmins(c, me, data, cur) {
  if (cur ? !(isAdminRole(me.role) || isWsAdmin(me, cur)) : !isAdminRole(me.role)) return false;
  const before = data.admins;
  const adminsOf = mem => [...new Set((Array.isArray(mem) ? mem : [])
    .filter(m => m && m.role === 'admin' && typeof m.userId === 'string').map(m => m.userId))];
  if (data.admins == null) {
    if (Array.isArray(cur?.admins)) data.admins = cur.admins;
    else if (cur && !same(cur.members ?? null, data.members ?? null)) data.admins = adminsOf(cur.members);
    else if (!cur && adminsOf(data.members).length) data.admins = adminsOf(data.members);
    else { delete data.admins; return before !== undefined; }   // yöneticisiz eski biçim: alan eklenmez (wsAdminIds üye listesine bakar)
  } else if (!Array.isArray(data.admins)) throw new HttpError(400, 'Alan yöneticileri dizi olmalı');
  const owner = wsOwner(data);
  data.admins = data.admins.filter(x => x !== owner);
  const old = new Set(Array.isArray(cur?.admins) ? cur.admins : adminsOf(cur?.members));
  const fresh = [...new Set(data.admins.filter(x => !old.has(x)))];
  if (fresh.length) {
    if (!fresh.every(validId)) throw new HttpError(400, 'Alan yöneticileri geçersiz (tekil kişi kimlikleri, en fazla 1000)');
    const ok = new Set((await c.query(`SELECT id FROM users WHERE id = ANY($1) AND active AND (NOT system OR role IN ('admin','super'))`,
      [fresh])).rows.map(r => r.id));
    if (fresh.some(id => !ok.has(id))) throw new HttpError(400, 'Alan yöneticisi bulunamadı ya da pasif');
  }
  return !same(before, data.admins);
}

/* Sahip: istemciden yalnız sistem yöneticisi belirler (açarken başka kişi seçebilir / sonradan devreder). */
function enforceOwner(data, cur, me) {
  const before = data.ownerId;
  const sys = isAdminRole(me.role) && (typeof data.ownerId === 'string' || data.ownerId === null);
  if (!cur) { if (!sys || data.ownerId === null) data.ownerId = me.id; }
  else if (!sys) { if (Object.hasOwn(cur, 'ownerId')) data.ownerId = cur.ownerId; else delete data.ownerId; }
  return !same(before, data.ownerId);
}

/* ---- proje rolleri (yetki-v2) ----
   roles = { kullanıcı: 'admin'|'member'|'viewer' } yetkinin kaynağıdır; members eski kodla uyum için roles'taki kişilerdir
   (sunucu eşitler; istemcinin tek başına gönderdiği members yok sayılır). ownerId: yeni projede oturumdaki kullanıcı,
   sonradan yalnız sistem ya da alan yöneticisi değiştirir; sahip roles'ta her zaman 'admin'. roles bir kez yazıldıktan
   sonra silinemez (proje eski kurala düşürülüp herkese açılamaz). Değiştiyse true. */
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
async function enforceProjectRoles(c, ctx, data, cur) {
  const { me } = ctx;
  const before = cj({ roles: data.roles, members: data.members, ownerId: data.ownerId });
  if (data.roles == null) { if (isObj(cur?.roles)) data.roles = { ...cur.roles }; else delete data.roles; }
  /* Göndermeyen (eski / kısmi) istemcide yetki tablosu ve sahip korunur; sıfırlama açıkça ({} / null) yapılır. */
  if (cur && data.perms === undefined && cur.perms !== undefined) data.perms = cur.perms;
  if (cur && !Object.hasOwn(data, 'ownerId') && Object.hasOwn(cur, 'ownerId')) data.ownerId = cur.ownerId;
  if (!cur) data.ownerId = me.id;
  else if ((cur.ownerId ?? null) !== (data.ownerId ?? null)) {
    const allowed = isAdminRole(me.role) || isWsAdmin(me, await wsOfProjectData(c, cur));
    if (!allowed) { if (Object.hasOwn(cur, 'ownerId')) data.ownerId = cur.ownerId; else delete data.ownerId; }
  }
  if (!cur && data.roles === undefined) data.roles = await seedRoles(c, data);
  if (!isObj(data.roles) && cur && !same(cur.members ?? null, data.members ?? null)) {
    if (Object.hasOwn(cur, 'members')) data.members = cur.members; else delete data.members;
  }
  if (isObj(data.roles)) {
    const r = {};
    for (const [k, v] of Object.entries(data.roles)) r[k] = v;
    if (typeof data.ownerId === 'string' && data.ownerId) r[data.ownerId] = 'admin';
    data.roles = r;
    const keys = Object.keys(r), set = new Set(keys);
    const prev = Array.isArray(cur?.members) ? cur.members : Array.isArray(data.members) ? data.members : [];
    const order = [...new Set(prev.filter(x => set.has(x)))];
    for (const k of keys) if (!order.includes(k)) order.push(k);
    data.members = order;
  }
  return before !== cj({ roles: data.roles, members: data.members, ownerId: data.ownerId });
}
/* roles göndermeyen (eski) istemcinin açtığı proje: alanın eski üye listesindeki Üye/İzleyiciler (alan yöneticileri
   hariç, onlar zaten görür) ya da eski alanda projenin üye listesindekiler (genel rolle). Liste yoksa yalnız sahip:
   yeni proje kimseye kendiliğinden açılmaz. */
async function seedRoles(c, data) {
  const ws = await wsOfProjectData(c, data);
  const mem = Array.isArray(ws?.members) ? ws.members : [];
  const admins = new Set(wsAdminIds(ws));
  const want = new Map();
  if (mem.length) {
    for (const m of mem) if (m && typeof m.userId === 'string' && !want.has(m.userId) && !admins.has(m.userId)) want.set(m.userId, m.role);
  } else if (Array.isArray(data.members)) for (const id of data.members) if (validId(id)) want.set(id, null);
  const ids = [...want.keys()].filter(validId);
  const out = {};
  if (!ids.length) return out;
  for (const u of (await c.query('SELECT id, role FROM users WHERE id = ANY($1) AND NOT system', [ids])).rows) {
    const r = want.get(u.id) ?? (u.role === 'viewer' ? 'viewer' : 'member');
    if (r === 'member' || r === 'viewer') out[u.id] = r;
  }
  return out;
}

/* Rol/sahip değişikliğinin doğrulaması (yetki denetiminden SONRA: yetkisize kişi var/yok bilgisi sızmasın).
   Yeni eklenen kişi var olan, sistem kullanıcısı olmayan bir kullanıcı olmalı; yeni sahip etkin olmalı. */
async function checkProjectRoles(c, data, cur) {
  const old = isObj(cur?.roles) ? cur.roles : {};
  const admins = r => (isObj(r) ? Object.values(r).filter(v => v === 'admin').length : 0);
  if (cur && !data.ownerId && admins(old) > 0 && admins(data.roles) === 0)
    throw new HttpError(409, 'Projede en az bir yönetici kalmalı');
  const fresh = isObj(data.roles) ? Object.keys(data.roles).filter(k => !Object.hasOwn(old, k) && k !== data.ownerId) : [];
  if (fresh.length) {
    /* Sistem hesabı (e-posta) projeye eklenmez; kurulumdaki süper yönetici de system işaretlidir ve eklenebilir. */
    const ok = new Set((await c.query(`SELECT id FROM users WHERE id = ANY($1) AND (NOT system OR role IN ('admin','super'))`, [fresh])).rows.map(r => r.id));
    if (fresh.some(id => !ok.has(id))) throw new HttpError(400, 'Projeye eklenen kişi bulunamadı');
  }
  if (cur && (cur.ownerId ?? null) !== (data.ownerId ?? null) && data.ownerId != null
      && !(await c.query(`SELECT 1 FROM users WHERE id=$1 AND active AND (NOT system OR role IN ('admin','super'))`, [data.ownerId])).rowCount)
    throw new HttpError(400, 'Proje sahibi bulunamadı ya da pasif');
}

/* Üye listesi: biçim, tekil kişi, var olan kullanıcı; sahip listede ve 'admin' (kaldırılamaz, düşürülemez).
   Dolu listeyi boşaltmak (alanı herkese açmak) yalnız sistem yöneticisi. Değiştiyse true. */
async function enforceWsMembers(c, me, data, cur) {
  /* Yetkisiz yazma burada doğrulanmaz (kişi var/yok bilgisi sızmasın); checkWorkspace 403 verir. */
  if (cur ? !(isAdminRole(me.role) || isWsAdmin(me, cur)) : !isAdminRole(me.role)) return false;
  const before = data.members;
  let changed = false;
  if (data.ownerId != null && data.ownerId !== (cur ? cur.ownerId : undefined)) {
    if (!validId(data.ownerId) || !(await c.query('SELECT 1 FROM users WHERE id=$1 AND active', [data.ownerId])).rowCount)
      throw new HttpError(400, 'Alan sahibi bulunamadı ya da pasif');
  }
  if (before === undefined || before === null) { if (before === null) { delete data.members; changed = true; } }
  else {
    if (!Array.isArray(before)) throw new HttpError(400, 'Üyeler dizi olmalı');
    if (before.length > WS_MAX_MEMBERS) throw new HttpError(400, `Bir alanda en fazla ${WS_MAX_MEMBERS} üye olabilir`);
    const map = new Map();
    for (const x of before) {
      if (!x || typeof x !== 'object' || typeof x.userId !== 'string' || !validId(x.userId) || !WS_ROLES.includes(x.role))
        throw new HttpError(400, 'Üye kaydı geçersiz (userId ve rol: admin, member, viewer)');
      map.delete(x.userId); map.set(x.userId, { userId: x.userId, role: x.role });
    }
    data.members = [...map.values()];
  }
  const list = data.members || [];
  const owner = wsOwner(data);
  if (owner && list.length) {
    const o = list.find(x => x.userId === owner);
    if (!o) list.unshift({ userId: owner, role: 'admin' });
    else o.role = 'admin';
  }
  const old = new Set((cur?.members || []).map(x => x?.userId));
  const fresh = list.map(x => x.userId).filter(id => !old.has(id) && id !== owner);
  if (fresh.length) {
    const ok = new Set((await c.query('SELECT id FROM users WHERE id = ANY($1)', [fresh])).rows.map(r => r.id));
    if (fresh.some(id => !ok.has(id))) throw new HttpError(400, 'Üye bulunamadı');
  }
  if (cur && !wsLegacy(cur) && wsLegacy(data) && !isAdminRole(me.role))
    throw new HttpError(403, 'Üye listesini yalnızca sistem yöneticisi kaldırabilir');
  return changed || !same(before, data.members);
}

/* ---- kayıtlı raporlar (011) ----
   Sahip (ownerId) oluşturmada oturumdur, sonradan değişmez. Değiştirme ve silme: sahip ya da sistem yöneticisi.
   Okuma: kendi raporu ve kapsamına (tüm sistem / çalışma alanı / proje) erişebildiği paylaşılan rapor (reportVisible).
   Paylaşmak için yazanın da o kapsama erişimi olmalı (alan kapsamında alan yöneticiliği); tüm sistemle paylaşmak
   yalnız sistem yöneticisi; genel izleyici yalnız kendine kaydeder. Rapor yalnız ayardır: veriyi her okuyan kendi
   erişebildiği kayıtlarla hesaplar. */
export const REPORT_FORBIDDEN = 'Raporu yalnızca sahibi ya da sistem yöneticisi değiştirebilir';
export const REPORT_MAX_PER_USER = 200;
export const REPORT_WS_FORBIDDEN = 'Raporu çalışma alanıyla yalnızca alan yöneticisi paylaşabilir';
/* Okuma (yetki-v2): proje kapsamı → projede rolü olan (projRole: proje rolü, proje sahibi, alan/sistem yöneticisi);
   alan kapsamı → yalnız alan yöneticisi (alanda tek projede rolü olan görmez; kendi kişisel raporu sahiplikten görünür);
   tüm sistem → herkes (paylaşmayı yalnız sistem yöneticisi yapar). */
function reportVisible(d, scope) {
  if (scope.me && d.ownerId === scope.me.id) return true;
  if (d.vis !== 'shared' || !d.scope || typeof d.scope !== 'object') return false;
  const s = d.scope;
  return s.kind === 'all' || (s.kind === 'ws' && scope.wsRep.has(s.id)) || (s.kind === 'project' && scope.proj.has(s.id));
}
function checkReportOwner(me, cur) {
  if (cur && !isAdminRole(me.role) && cur.ownerId !== me.id) throw new HttpError(403, REPORT_FORBIDDEN);
}
function enforceReportOwner(data, cur, me) {
  const before = data.ownerId;
  data.ownerId = cur ? (cur.ownerId || me.id) : me.id;
  return before !== data.ownerId;
}
/* Paylaşma: okuma kuralıyla aynı erişim yazana da gerekir (paylaştığı kişileri kendisi de kapsıyor olmalı). */
async function checkReport(c, me, data, cur) {
  if (!cur && Number((await c.query('SELECT count(*) AS n FROM reports WHERE owner_id=$1', [data.ownerId])).rows[0].n) >= REPORT_MAX_PER_USER)
    throw new HttpError(400, `Bir kişi en fazla ${REPORT_MAX_PER_USER} rapor kaydedebilir`);
  if (data.vis !== 'shared' || isAdminRole(me.role)) return;
  if (me.role === 'viewer') throw new HttpError(403, 'İzleyici raporu paylaşamaz; "Yalnız ben" olarak kaydedin');
  const s = data.scope;
  if (s.kind === 'all') throw new HttpError(403, 'Raporu tüm sistemle yalnızca sistem yöneticisi paylaşabilir');
  if (s.kind === 'project') {
    const p = await projById(c, s.id);
    if (!p) throw new HttpError(400, 'Raporun kapsamı bulunamadı');
    if (await roleIn(c, me, p) === null) throw new HttpError(403, NO_ACCESS);
    return;
  }
  const ws = (await c.query('SELECT data FROM workspaces WHERE id=$1', [s.id])).rows[0]?.data;
  if (!ws) throw new HttpError(400, 'Raporun kapsamı bulunamadı');
  if (!isWsAdmin(me, ws)) throw new HttpError(403, REPORT_WS_FORBIDDEN);
}

/* ---- proje alanları (parametrik alanlar) ----
   Anahtar tekilliği: projeye özel alan aynı projedeki ve genel (tüm projeler) alanlarla, genel alan tüm alanlarla
   çakışamaz. Farklı projelerde aynı anahtar serbest (raporda tek boyutta birleşir). 005'in gizlediği eski alan
   (hidden, bind yok) sayılmaz. Yeni kayıtta ya da anahtar değişince denetlenir; aynı anahtara eşzamanlı yazmalar
   danışma kilidiyle sıralanır. Hazır alan (bind) projede bir kez: fields_project_bind_uq (008) yedek kısıttır. */
const FIELD_KEY_LOCK = 727278;
export const FIELD_KEY_TAKEN = 'Bu anahtarla bir alan zaten var';
export const FIELD_BIND_TAKEN = 'Bu projede bu hazır alan zaten var';
async function checkFieldKey(c, id, data, cur) {
  const pid = data.projectId || null;
  if (data.bind && !cur) {
    await c.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [FIELD_KEY_LOCK, 'bind:' + pid + ':' + data.bind]);
    if ((await c.query(`SELECT 1 FROM fields WHERE project_id=$1 AND data->>'bind'=$2 AND id<>$3 LIMIT 1`, [pid, data.bind, id])).rowCount)
      throw new HttpError(409, FIELD_BIND_TAKEN);
  }
  if (typeof data.key !== 'string' || !data.key || (cur && cur.key === data.key)) return;
  await c.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [FIELD_KEY_LOCK, 'key:' + data.key]);
  /* Cari alanları (scope 'customer') kendi aralarında tekil; iş alanlarının anahtarlarıyla çakışmaz. Cari alanı eski
     sürümden gizlensin diye hidden:true taşır; bu yüzden 005 gizlemesi istisnası yalnız iş alanlarında. */
  const sc = data.scope === 'customer' ? 'customer' : 'issue';
  const clash = await c.query(`SELECT 1 FROM fields WHERE field_key=$1 AND id<>$2
      AND coalesce(data->>'scope', 'issue') = $4
      AND ($4 = 'customer' OR (NOT (coalesce(data->>'hidden','') = 'true' AND data->>'bind' IS NULL)
        AND ($3::text IS NULL OR coalesce(project_id,'') = '' OR project_id = $3))) LIMIT 1`, [data.key, id, pid, sc]);
  if (clash.rowCount) throw new HttpError(409, FIELD_KEY_TAKEN);
}

/* ---- Cariler modülü (Sistem → Modüller; settings.modules.customers === false → kapalı) ----
   Kapalıyken cari kaydı, yetkili kişi ve cari özel alanı yazılmaz; okuma süzülmez (veri silinmez). Talep şablonlu
   projede "Talep eden" zorunluluğu da kalkar (seçici arayüzde yok). Gönderim içinde bir kez okunur. */
export const CUSTOMERS_OFF = 'Cariler modülü kapalı';
async function customersOff(c, ctx) {
  if (ctx && ctx.cuOff !== undefined) return ctx.cuOff;
  const off = (await c.query(`SELECT value->'customers' AS v FROM settings WHERE key='modules'`)).rows[0]?.v === false;
  if (ctx) ctx.cuOff = off;
  return off;
}

/* ---- cariler (#11) ----
   Ekle/düzenle/sil yalnız yönetici (ADMIN_ONLY). İletilerde yalnız kimlik: unvan/vergi no günlüğe ve
   başka kullanıcıların yanıtına düşmez (istemci unvanı kimlikten kendisi bulur). */
const TAX_NO_LOCK = 727277;
const taxNoTaken = id => id ? `Bu vergi numarasıyla kayıtlı cari var (#${id})` : 'Bu vergi numarasıyla kayıtlı cari var';

/* Vergi numarası (pasifler dahil) tekil. Yeni kayıtta ya da değiştiyse önceden denetlenir. Aynı vergi
   numarasına eşzamanlı yazmalar danışma kilidiyle sıralanır: ikincisi ilkinin sonucunu görür ve normal 409 alır
   (23505 ve PostgreSQL günlüğüne DETAIL satırı oluşmaz). Kilidi almayan bir yazmaya karşı yedek olarak
   customers_tax_no_uq indeksi ikincisini reddeder (applyChanges aynı iletiyle eşler). */
async function checkCustomerTaxNo(c, ctx, id, data, cur) {
  const tn = data.taxNo || null;
  ctx.taxNo = tn;
  if (!tn || (cur && (cur.taxNo || null) === tn)) return;
  await c.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [TAX_NO_LOCK, tn]);
  const other = (await c.query('SELECT id FROM customers WHERE tax_no=$1 AND id<>$2 LIMIT 1', [tn, id])).rows[0];
  if (other) throw new HttpError(409, taxNoTaken(other.id));
}

/* Yedeklerdeki (snapshots.data → customers dizisi) aynı kimlikli cariyi çıkarır; sayımı da günceller.
   Aynı işlemde çalışır: silme geri alınırsa yedekler de değişmez. */
async function purgeCustomerFromSnapshots(c, id) {
  await c.query(`WITH n AS (
      SELECT s.id, coalesce((SELECT jsonb_agg(e.x ORDER BY e.o) FROM jsonb_array_elements(s.data->'customers') WITH ORDINALITY e(x, o)
                              WHERE e.x->>'id' IS DISTINCT FROM $1), '[]'::jsonb) AS arr
        FROM snapshots s
       WHERE jsonb_typeof(s.data->'customers') = 'array'
         AND s.data->'customers' @> jsonb_build_array(jsonb_build_object('id', $1::text)))
    UPDATE snapshots s SET data = jsonb_set(s.data, '{customers}', n.arr),
      counts = CASE WHEN jsonb_typeof(s.counts) = 'object' THEN jsonb_set(s.counts, '{customers}', to_jsonb(jsonb_array_length(n.arr)))
                    ELSE s.counts END
      FROM n WHERE n.id = s.id`, [id]);
}

/* Bağlı projesi/işi (arşivliler dahil) olan cari silinmez. Cari satırı sayımdan ÖNCE burada FOR UPDATE ile
   kilitlenir (çağıran yoldan bağımsız): aynı anda bağlayan proje/iş (checkProjectCustomer, FOR SHARE) ya önce
   biter ve sayılır ya da cariyi bulamaz ("Cari bulunamadı"). */
async function checkCustomerDelete(c, id) {
  await c.query('SELECT 1 FROM customers WHERE id=$1 FOR UPDATE', [id]);
  const n = Number((await c.query('SELECT count(*) AS n FROM projects WHERE customer_id=$1', [id])).rows[0].n);
  if (n > 0) throw new HttpError(409, `Bu cariye bağlı ${n} proje var; silmek yerine pasife alın`);
  const k = Number((await c.query('SELECT count(*) AS n FROM issues WHERE customer_id=$1', [id])).rows[0].n);
  if (k > 0) throw new HttpError(409, `Bu cariye bağlı ${k} iş var; silmek yerine pasife alın`);
}

/* İki cariyi birleştirir (yönetici; customers ADMIN_ONLY): kaynağa bağlı tüm projeler ve işler (arşivliler dahil)
   hedefe taşınır, kaynağın yetkili kişileri hedefe eklenir; ardından kaynak silinir (çağıran). Hedef var ve etkin
   olmalı. Hepsi tek işlemde: bir adım reddedilirse hiçbiri yazılmaz (SAVEPOINT). */
async function mergeCustomer(c, ctx, id, to) {
  if (!validId(to) || to === id) throw new HttpError(400, 'Birleştirilecek cari geçersiz');
  const src = (await c.query('SELECT data FROM customers WHERE id=$1', [id])).rows[0]?.data;
  const tgt = (await c.query('SELECT data, active FROM customers WHERE id=$1 FOR UPDATE', [to])).rows[0];
  if (!src || !tgt) throw new HttpError(400, 'Cari bulunamadı');
  if (!tgt.active) throw new HttpError(400, 'Pasif cariye birleştirilemez');
  const { me, batch } = ctx;
  for (const table of ['projects', 'issues']) {
    const rows = (await c.query(`UPDATE ${table} SET data = data || jsonb_build_object('customerId', $2::text),
        version = version + 1, updated_at = now(), updated_by = $3 WHERE customer_id = $1 RETURNING id`, [id, to, me.id])).rows;
    for (const r of rows) { await logChange(c, table, r.id, 'put', me.id, batch); ctx.adjusted.push({ c: table, id: r.id }); }
  }
  const list = v => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : []);
  const mine = list(tgt.data.contacts), ids = new Set(mine.map(x => x.id));
  const add = list(src.contacts).map(x => {
    let nid = x.id, n = 1;
    while (ids.has(nid)) nid = `${x.id}_${++n}`;
    ids.add(nid);
    return { ...x, id: nid };
  });
  if (add.length) {
    const data = { ...tgt.data, contacts: [...mine, ...add] };
    validate('customers', data, { live: true, cur: tgt.data });
    await c.query(`UPDATE customers SET data = $2::jsonb, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1`,
      [to, JSON.stringify(data), me.id]);
  }
  await logChange(c, 'customers', to, 'put', me.id, batch);
  ctx.adjusted.push({ c: 'customers', id: to });
}

/* Projeye cari yeni bağlanıyorsa ya da değiştiyse (güncel kayda göre) cari var ve etkin olmalı.
   Bağ kaldırma serbest; pasife alınmış carinin değişmeyen bağı korunur. */
async function checkProjectCustomer(c, data, cur, passive = 'Pasif cari projeye bağlanamaz') {
  const cid = data.customerId;
  if (cid == null || cid === '') return;
  if (cur && (cur.customerId ?? '') === cid) return;
  const row = (await c.query('SELECT active FROM customers WHERE id=$1 FOR SHARE', [cid])).rows[0];
  if (!row) throw new HttpError(400, 'Cari bulunamadı');
  if (!row.active) throw new HttpError(400, passive);
}

/* Talep eden (görev 12): yalnız canlı yazmada, yeni işte ya da talep eden değişince (güncel kayda göre).
   'talep' şablonlu projede boş bırakılamaz; dolu ise cari var ve etkin, kişi o carinin yetkili kişisi olmalı.
   Değişmeyen eski bağ (pasife alınmış cari / silinmiş kişi) ve talep edeni olmayan eski iş korunur.
   İçe aktarma / geri yükleme bu yoldan geçmez. */
export const REQUESTER_REQUIRED = 'Talep eden gerekli';
const reqKey = r => (r && typeof r === 'object' ? `${r.customerId ?? ''}|${r.contactId ?? ''}` : '');
async function checkRequester(c, data, cur, system = false) {
  const r = data.requester ?? null;
  if (cur && reqKey(cur.requester) === reqKey(r)) return;
  if (!r) {
    if (system) return;                              // e-postadan: "Talep eden bekleniyor" etiketiyle havuza
    const tpl = (await c.query(`SELECT data->>'template' AS t FROM projects WHERE id=$1`, [data.projectId])).rows[0]?.t;
    if (tpl === 'talep' && !(await customersOff(c))) throw new HttpError(400, REQUESTER_REQUIRED);
    return;
  }
  const row = (await c.query('SELECT active, data FROM customers WHERE id=$1 FOR SHARE', [r.customerId])).rows[0];
  if (!row) throw new HttpError(400, 'Talep edenin carisi bulunamadı');
  if (!row.active) throw new HttpError(400, 'Pasif carinin kişisi talep eden olamaz');
  const list = Array.isArray(row.data?.contacts) ? row.data.contacts : [];
  if (!list.some(p => p && p.id === r.contactId)) throw new HttpError(400, 'Talep eden kişi bu caride bulunamadı');
}

/* Hızlı kişi ekleme (görev 12): yönetici ve üye bir cariye yalnız ad / e-posta / telefon ile yetkili kişi ekler.
   Cari kaydının geri kalanı (unvan, vergi no...) bu yoldan değişmez. changes'e 'put' yazılır (diğerleri yoklamayla alır). */
export async function addContact(pool, me, customerId, body) {
  if (!isAdminRole(me.role)) throw new HttpError(403, 'Kişi eklemeyi yalnızca yönetici yapabilir');
  if (!validId(customerId)) throw new HttpError(400, 'Geçersiz cari');
  const b = body && typeof body === 'object' ? body : {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 120) throw new HttpError(400, 'Kişinin adı gerekli (en fazla 120 karakter)');
  const p = { id: 'ct_' + randomUUID().replace(/-/g, '').slice(0, 16), name };
  for (const k of ['email', 'phone']) {
    if (b[k] == null || b[k] === '') continue;
    if (typeof b[k] !== 'string') throw new HttpError(400, k === 'email' ? 'E-posta adresi geçersiz' : 'Telefon geçersiz');
    const v = b[k].trim();
    if (v) p[k] = v;
  }
  return tx(pool, async c => {
    if (await customersOff(c)) throw new HttpError(409, CUSTOMERS_OFF);
    const row = (await c.query('SELECT data, active FROM customers WHERE id=$1 FOR UPDATE', [customerId])).rows[0];
    if (!row) throw new HttpError(404, 'Cari bulunamadı. Yöneticinize cari ekletin.');
    if (!row.active) throw new HttpError(400, 'Pasif cariye kişi eklenemez');
    const data = { ...row.data, contacts: [...(Array.isArray(row.data.contacts) ? row.data.contacts : []), p] };
    validate('customers', data, { live: true, cur: row.data });
    await c.query(`UPDATE customers SET data=$2::jsonb, version=version+1, updated_at=now(), updated_by=$3 WHERE id=$1`,
      [customerId, JSON.stringify(data), me.id]);
    await logChange(c, 'customers', customerId, 'put', me.id, randomUUID());
    return { contact: p, customer: data };
  });
}

/* Yetkili kişiler kimliğe göre üç yönlü birleşir: başkasının sildiği kişi silinmiş kalır (eski base ile geri
   gelmez), benim sildiğim çıkar, benim eklediğim eklenir, benim değiştirdiğim kişide benimki kazanır. */
export function mergeContacts(base, mine, theirs) {
  const arr = v => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : []);
  const B = new Map(arr(base).map(x => [x.id, x])), M = new Map(arr(mine).map(x => [x.id, x]));
  const out = [], seen = new Set();
  for (const t of arr(theirs)) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (B.has(t.id) && !M.has(t.id)) continue;                 // ben sildim
    const m = M.get(t.id);
    out.push(m && !same(m, B.get(t.id)) ? m : t);
  }
  for (const m of arr(mine)) if (!B.has(m.id) && !seen.has(m.id)) { seen.add(m.id); out.push(m); }
  return out;
}

/* İş silinince yorumları, süre kayıtları, geçmişi ve bağlantıları da çöp kutusuna gider
   (aynı batch → birlikte geri yüklenir); alt işlerin ve epik çocuklarının bağı kopar. */
async function moveToTrash(c, ctx, table, where, params) {
  const { me, batch } = ctx;
  const rows = (await c.query(`DELETE FROM ${table} WHERE ${where} RETURNING id, data`, params)).rows;
  for (const r of rows) {
    await c.query(`INSERT INTO deleted_records (collection, record_id, data, batch_id, deleted_by)
      VALUES ($1,$2,$3::jsonb,$4,$5)`, [table, r.id, JSON.stringify(r.data), batch, me.id]);
    await logChange(c, table, r.id, 'del', me.id, batch);
  }
}
/* Silinen işlere (ids) bağlı, silinmeyen işlerin üst iş / epik bağı kopar. */
async function unlinkIssues(c, ctx, ids) {
  const { me, batch } = ctx;
  for (const [col, key] of [['parent_id', 'parentId'], ['epic_id', 'epicId']]) {
    const rows = (await c.query(`UPDATE issues SET data = jsonb_set(data, '{${key}}', 'null'::jsonb), version = version + 1,
      updated_at = now() WHERE ${col} = ANY($1) AND NOT (id = ANY($1)) RETURNING id`, [ids])).rows;
    for (const r of rows) { await logChange(c, 'issues', r.id, 'put', me.id, batch); ctx.adjusted.push({ c: 'issues', id: r.id }); }
  }
}
async function cascadeIssueDelete(c, ctx, id) {
  for (const t of ISSUE_CHILDREN) await moveToTrash(c, ctx, t, 'issue_id = $1', [id]);
  await moveToTrash(c, ctx, 'links', 'from_issue = $1 OR to_issue = $1', [id]);
  await unlinkIssues(c, ctx, [id]);
}
/* Proje silinince bağlı kayıtlar (işler ve onların yorum, süre, geçmiş, geçiş ve bağlantıları; kolonlar, sprintler,
   projeye özel alanlar ve kurallar) aynı batch'le çöp kutusuna gider: proje ile birlikte geri yüklenir, istemci ne
   gönderirse göndersin (ham API, yarım silme) yetim kayıt kalmaz (O-1). Yetki proje silme yetkisidir (checkScope). */
const PROJECT_CHILDREN = ['statuses', 'sprints', 'fields', 'rules'];
async function cascadeProjectDelete(c, ctx, pid) {
  await lockColumns(c, ctx, [pid]);
  const ids = (await c.query('SELECT id FROM issues WHERE project_id=$1 ORDER BY id FOR UPDATE', [pid])).rows.map(r => r.id);
  if (ids.length) {
    for (const t of ISSUE_CHILDREN) await moveToTrash(c, ctx, t, 'issue_id = ANY($1)', [ids]);
    await moveToTrash(c, ctx, 'links', 'from_issue = ANY($1) OR to_issue = ANY($1)', [ids]);
    await unlinkIssues(c, ctx, ids);
    await moveToTrash(c, ctx, 'issues', 'id = ANY($1)', [ids]);
  }
  for (const t of PROJECT_CHILDREN) await moveToTrash(c, ctx, t, 'project_id = $1', [pid]);
}

async function recomputeSpent(c, ctx, iid) {
  const r = (await c.query(`SELECT i.data, coalesce((SELECT sum((w.data->>'hours')::numeric) FROM worklogs w WHERE w.issue_id = i.id), 0) AS s
    FROM issues i WHERE i.id = $1 FOR UPDATE`, [iid])).rows[0];
  if (!r) return;
  const spent = Number(r.s);
  if (Number(r.data.spent || 0) === spent) return;
  const est = Number(r.data.estimate) || 0;
  const d = { ...r.data, spent };
  if (r.data.remainingEst == null || Number(r.data.remainingEst) === Math.max(0, est - Number(r.data.spent || 0)))
    d.remainingEst = Math.max(0, est - spent);         // kalan, elle değiştirilmediyse otomatik
  await c.query('UPDATE issues SET data=$2::jsonb, version=version+1, updated_at=now() WHERE id=$1', [iid, JSON.stringify(d)]);
  await logChange(c, 'issues', iid, 'put', ctx.me.id, ctx.batch);
  ctx.adjusted.push({ c: 'issues', id: iid });
}

/* İş anahtarı (PANO-12) projede benzersiz olmalı. İki kişi aynı anda iş açarsa
   ikisi de aynı numarayı üretir; sonra gelene sunucu bir sonraki numarayı verir. */
async function ensureIssueKey(c, ctx, data, cur) {
  const pid = data.projectId;
  if (!pid || (cur && cur.key === data.key && cur.projectId === pid)) return false;
  const proj = (await c.query('SELECT data FROM projects WHERE id=$1 FOR UPDATE', [pid])).rows[0]?.data;
  const num = k => { const m = /-(\d+)$/.exec(k || ''); return m ? Number(m[1]) : 0; };
  let changed = false;
  if (data.key) {
    const clash = await c.query('SELECT 1 FROM issues WHERE project_id=$1 AND issue_key=$2 AND id<>$3 LIMIT 1',
      [pid, data.key, data.id]);
    if (clash.rowCount) {
      const max = Number((await c.query(
        `SELECT coalesce(max((substring(issue_key from '-(\\d+)$'))::int),0) AS m FROM issues WHERE project_id=$1`,
        [pid])).rows[0].m);
      const n = Math.max(max, Number(proj?.counter) || 0) + 1;
      const prefix = proj?.key || data.key.replace(/-\d+$/, '') || 'IS';
      data.key = `${prefix}-${n}`;
      changed = true;
    }
  } else if (!cur && proj) {
    /* Anahtarsız yeni iş (API ile): istemcideki gibi proje anahtarı + bir sonraki numara. */
    const max = Number((await c.query(
      `SELECT coalesce(max((substring(issue_key from '-(\\d+)$'))::int),0) AS m FROM issues WHERE project_id=$1`,
      [pid])).rows[0].m);
    data.key = `${proj.key || 'IS'}-${Math.max(max, Number(proj.counter) || 0) + 1}`;
    changed = true;
  }
  /* Proje sayacını en büyük numaraya çek. */
  if (proj && num(data.key) > (Number(proj.counter) || 0)) {
    const np = { ...proj, counter: num(data.key) };
    await c.query(`UPDATE projects SET data=$2::jsonb, version=version+1, updated_at=now() WHERE id=$1`,
      [pid, JSON.stringify(np)]);
    await logChange(c, 'projects', pid, 'put', ctx.me.id, ctx.batch);
    if (changed) ctx.adjusted.push({ c: 'projects', id: pid });
  }
  return changed;
}

async function applySetting(c, ctx, ch) {
  const { me } = ctx;
  if (PREF_KEYS.includes(ch.id) || IGNORED_KEYS.includes(ch.id) || ch.id === 'users' || tableOf(ch.id)
      || reservedName(ch.id) || !/^[A-Za-z][\w]{0,39}$/.test(ch.id))
    throw new HttpError(400, 'geçersiz ayar anahtarı');
  if (ch.op === 'put' && JSON.stringify(ch.data).length > 512 * 1024) throw new HttpError(400, 'Ayar çok büyük');
  const cur = (await c.query('SELECT value FROM settings WHERE key=$1 FOR UPDATE', [ch.id])).rows[0]?.value;
  if (ch.id === 'modules') delete ctx.cuOff;          // aynı gönderimdeki sonraki cari yazmaları yeni ayarı görsün
  if (ch.op === 'del') return (await c.query('DELETE FROM settings WHERE key=$1', [ch.id])).rowCount > 0;
  let val = ch.data;
  if (cur !== undefined && ch.base !== undefined && !same(cur, ch.base)
      && val && typeof val === 'object' && !Array.isArray(val) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
    val = ch.id === 'perms' ? mergePerms(ch.base, val, cur) : merge3(ch.base, val, cur);
    ctx.adjusted.push({ c: '_settings', id: ch.id });
  }
  if (ch.id === 'cfg') validateCfg(val);
  if (ch.id === 'navDefault') validateNavDefault(val);
  if (ch.id === 'perms') validatePerms(val);
  if (ch.id === 'modules') validateModules(val);
  if (cur !== undefined && same(cur, val)) return false;
  await c.query(
    `INSERT INTO settings AS s (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [ch.id, JSON.stringify(val), me.id]);
  return true;
}

async function applyUser(c, ctx, ch) {
  const { me, batch } = ctx;
  const meAdmin = isAdminRole(me.role), meSuper = me.role === 'super';
  const cur = (await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [ch.id])).rows[0];

  if (ch.op === 'del') {
    if (!cur) return false;
    if (!meAdmin) throw new HttpError(403, 'Kullanıcı silmek için yönetici olmalısınız');
    if (cur.id === me.id) throw new HttpError(400, 'Kendi hesabınızı silemezsiniz');
    if ((cur.system || cur.role === 'super') && !meSuper) throw new HttpError(403, 'Bu kullanıcıyı yalnızca süper yönetici silebilir');
    await c.query(`INSERT INTO deleted_records (collection, record_id, data, batch_id, deleted_by)
      VALUES ('users',$1,$2::jsonb,$3,$4)`, [cur.id, JSON.stringify(publicUser(cur)), batch, me.id]);
    await c.query('DELETE FROM users WHERE id=$1', [ch.id]);
    await removeUserFromProjects(c, ctx, cur.id);
    return true;
  }

  const d = { ...ch.data };
  for (const k of SECRET_USER_KEYS) delete d[k];
  const username = String(d.username || cur?.username || '').trim().toLowerCase();
  if (username && !/^[a-z0-9._-]{2,40}$/.test(username))
    throw new HttpError(400, 'Kullanıcı adı 2-40 karakter; yalnızca küçük harf, rakam, nokta, tire');
  const name = String(d.name ?? cur?.name ?? '').slice(0, 200);
  let role = ROLES.includes(d.role) ? d.role : (cur?.role || 'member');
  const active = d.active === undefined ? (cur?.active ?? true) : !!d.active;
  const extra = { ...d }; for (const k of USER_COLS) delete extra[k];
  if (extra.ini != null && (typeof extra.ini !== 'string' || !/^[\p{L}\p{N}]{1,3}$/u.test(extra.ini)))
    throw new HttpError(400, 'Baş harfler en fazla 3 harf/rakam olmalı');
  if (extra.color != null && !/^#[0-9a-f]{3,8}$/i.test(String(extra.color))) throw new HttpError(400, 'Geçersiz renk');
  if (extra.capacity != null && !(typeof extra.capacity === 'number' && extra.capacity >= 0 && extra.capacity <= 168))
    throw new HttpError(400, 'Kapasite 0-168 saat olmalı');
  if (extra.email != null && extra.email !== '' && !(typeof extra.email === 'string' && extra.email.length <= 200
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(extra.email))) throw new HttpError(400, 'E-posta adresi geçersiz');
  if (extra.title != null && !(typeof extra.title === 'string' && extra.title.length <= 120)) throw new HttpError(400, 'Unvan en fazla 120 karakter');

  if (!cur) {
    if (!meAdmin) throw new HttpError(403, 'Kullanıcı eklemek için yönetici olmalısınız');
    if (role === 'super' && !meSuper) role = 'admin';
    if (!username) throw new HttpError(400, 'Kullanıcı adı gerekli');
    const hash = await bcrypt.hash(DEFAULT_USER_PASSWORD(), 10);
    await c.query(
      `INSERT INTO users (id, username, name, role, active, password_hash, must_change, system, data)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8::jsonb)`,
      [ch.id, username, name, role, active, hash, !!d.system && meSuper, JSON.stringify(extra)]);
    return true;
  }

  if (!meAdmin) {
    /* Üye yalnızca kendi görünen bilgilerini (ad, renk, baş harf ...) değiştirebilir. */
    if (cur.id !== me.id) return false;
    const r = await c.query(
      `UPDATE users SET name=$2, data=$3::jsonb, updated_at=now() WHERE id=$1
       AND (name IS DISTINCT FROM $2 OR data IS DISTINCT FROM $3::jsonb)`, [cur.id, name, JSON.stringify(extra)]);
    return r.rowCount > 0;
  }
  if (cur.role === 'super' && !meSuper) throw new HttpError(403, 'Süper yöneticiyi yalnızca süper yönetici değiştirebilir');
  if (role === 'super' && !meSuper) role = cur.role;
  if (cur.id === me.id) role = cur.role;                    // kendi rolünü/aktifliğini değiştiremez
  const act = cur.id === me.id ? true : active;
  if (!username) throw new HttpError(400, 'Kullanıcı adı gerekli');
  const r = await c.query(
    `UPDATE users SET username=$2, name=$3, role=$4, active=$5, data=$6::jsonb, updated_at=now()
     WHERE id=$1 AND (username, name, role, active, data) IS DISTINCT FROM ($2, $3, $4, $5, $6::jsonb)`,
    [cur.id, username, name, role, act, JSON.stringify(extra)]);
  if (!act) await c.query('DELETE FROM sessions WHERE user_id=$1', [cur.id]);
  /* Yönetici olup/olmaktan çıkınca görebildiği veri değişir (18). */
  if (r.rowCount && isAdminRole(cur.role) !== isAdminRole(role)) await logAccess(c, ctx, [cur.id]);
  return r.rowCount > 0;
}

/* Silinen kullanıcı projelerin rollerinden/üye listesinden ve alanların yönetici listesinden çıkar; sahibi olduğu
   projenin sahibi boşalır. Rolü olmayan eski projede üye listesi boşalacaksa dokunulmaz (boş liste eski kuralda
   "herkes" demektir). */
async function removeUserFromProjects(c, ctx, uid) {
  const { me, batch } = ctx;
  const rows = (await c.query(`SELECT id, data FROM projects WHERE data->'roles' ? $1 OR data->>'ownerId' = $1 OR data->'members' ? $1
      ORDER BY id FOR UPDATE`, [uid])).rows;
  for (const r of rows) {
    const d = { ...r.data };
    if (isObj(d.roles)) { d.roles = { ...d.roles }; delete d.roles[uid]; }
    if (Array.isArray(d.members) && (isObj(d.roles) || d.members.filter(x => x !== uid).length > 0)) d.members = d.members.filter(x => x !== uid);
    if (d.ownerId === uid) d.ownerId = null;
    if (same(d, r.data)) continue;
    await c.query('UPDATE projects SET data=$2::jsonb, version=version+1, updated_at=now(), updated_by=$3 WHERE id=$1', [r.id, JSON.stringify(d), me.id]);
    await logChange(c, 'projects', r.id, 'put', me.id, batch);
    ctx.adjusted.push({ c: 'projects', id: r.id });
  }
  const ws = (await c.query(`SELECT id, data FROM workspaces WHERE data->'admins' ? $1 ORDER BY id FOR UPDATE`, [uid])).rows;
  for (const r of ws) {
    const d = { ...r.data, admins: r.data.admins.filter(x => x !== uid) };
    await c.query('UPDATE workspaces SET data=$2::jsonb, version=version+1, updated_at=now(), updated_by=$3 WHERE id=$1', [r.id, JSON.stringify(d), me.id]);
    await logChange(c, 'workspaces', r.id, 'put', me.id, batch);
    ctx.adjusted.push({ c: 'workspaces', id: r.id });
  }
}

/* ---- ilk kurulum: yönetici ve boş bir proje ---- */
export async function bootstrap(pool, log = console.log) {
  const username = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  let password = process.env.ADMIN_PASSWORD;
  const n = Number((await pool.query('SELECT count(*) AS n FROM users')).rows[0].n);
  if (n === 0) {
    let generated = false;
    if (!password) { password = randomPassword(); generated = true; }
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (id, username, name, role, active, password_hash, must_change, system, data)
       VALUES ('u_admin', $1, 'Yönetici', 'super', true, $2, $3, true, $4::jsonb)`,
      [username, hash, generated, JSON.stringify({ ini: 'YN', color: '#4F46E5', capacity: 30 })]);
    log(`[kurulum] Yönetici oluşturuldu: kullanıcı adı "${username}"` +
      (generated ? `, geçici parola: ${password} (ilk girişte değiştirilecek)` : ' (parola ADMIN_PASSWORD değişkeninden)'));
  } else if (process.env.ADMIN_RESET_PASSWORD === 'true' && password) {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `UPDATE users SET password_hash=$2, active=true, must_change=false WHERE lower(username)=$1`, [username, hash]);
    if (r.rowCount) log(`[kurulum] "${username}" parolası ADMIN_PASSWORD ile sıfırlandı. ADMIN_RESET_PASSWORD değişkenini kaldırın.`);
  }

  await ensureDefaultWorkspace(pool);
  const p = Number((await pool.query('SELECT count(*) AS n FROM projects')).rows[0].n);
  if (p === 0) {
    const admin = (await pool.query(`SELECT id FROM users WHERE role IN ('super','admin') ORDER BY ord LIMIT 1`)).rows[0];
    await tx(pool, async c => {
      await c.query(`INSERT INTO projects (id, data) VALUES ('p1', $1::jsonb)`, [JSON.stringify({
        id: 'p1', key: 'GEN', code: 'GEN', name: 'Genel', lead: admin?.id || null, counter: 0,
        members: admin ? [admin.id] : [], archived: false, workspaceId: DEFAULT_WS,
        ...(admin ? { ownerId: admin.id, roles: { [admin.id]: 'admin' } } : {}) })]);
      const st = [['Yapılacak', 'todo'], ['Devam ediyor', 'inprogress'], ['Beklemede', 'inprogress'], ['Bitti', 'done']];
      for (const [i, [name, cat]] of st.entries()) {
        await c.query(`INSERT INTO statuses (id, data) VALUES ($1, $2::jsonb)`,
          [`p1_s${i}`, JSON.stringify({ id: `p1_s${i}`, projectId: 'p1', name, cat, wip: 0, ord: i })]);
      }
      await c.query(`INSERT INTO changes (collection, record_id, op) VALUES ('projects','p1','put')`);
    });
    log('[kurulum] Başlangıç projesi "Genel" oluşturuldu.');
  }
}

/* Varsayılan "Genel" alanı yoksa oluştur (ilk kurulum, içe aktarma / geri yükleme sonrası). */
export async function ensureDefaultWorkspace(db) {
  const r = await db.query(
    `INSERT INTO workspaces (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [DEFAULT_WS, JSON.stringify({ id: DEFAULT_WS, name: 'Genel', color: '#64748B', description: '', archived: false, createdBy: null })]);
  if (r.rowCount) await db.query(`INSERT INTO changes (collection, record_id, op) VALUES ('workspaces', $1, 'put')`, [DEFAULT_WS]);
  return r.rowCount > 0;
}

export function randomPassword(len = 14) {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = new Uint32Array(len); crypto.getRandomValues(b);
  return Array.from(b, x => a[x % a.length]).join('');
}

export { cj };
