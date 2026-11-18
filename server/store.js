import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { TABLES, PREF_KEYS, IGNORED_KEYS, tx, tableOf, reservedName } from './db.js';
import { HttpError, cj, same, merge3, isAdminRole } from './util.js';
import { validate, normalizePriority, normalizeArchived, normalizeCustomer, validId, validateCfg, stripBadKeys } from './validate.js';
import { notifyForIssue, notifyForComment } from './notify.js';

export { HttpError };

export const DEFAULT_USER_PASSWORD = () => process.env.DEFAULT_USER_PASSWORD || 'Pano2026!';
const SECRET_USER_KEYS = ['pw', 'salt', 'mustChange', 'password', 'password_hash', 'passwordHash'];
const USER_COLS = ['id', 'username', 'name', 'role', 'active', 'system'];
const ROLES = ['super', 'admin', 'member', 'viewer'];
/* Proje yapılandırması ve cariler: yalnızca yönetici değiştirir. Üye projeyi oluşturup düzenleyebilir
   (projeye etkin cari bağlamak dahil) ama silemez. */
export const ADMIN_ONLY = ['statuses', 'fields', 'rules', '_settings', 'customers'];
const ISSUE_CHILDREN = ['comments', 'worklogs', 'history', 'transitions'];
/* Yeni kaydı yalnız ekleyerek oluşturan koleksiyonlar (eşzamanlı oluşturmada üzerine yazılmaz). */
const CREATE_ONCE = ['workspaces'];

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
    const data = await readAll(c);
    const pr = (await c.query('SELECT data FROM user_prefs WHERE user_id=$1', [me.id])).rows[0];
    for (const k of PREF_KEYS) if (pr?.data?.[k] !== undefined && pr.data[k] !== null) data[k] = pr.data[k];
    if (me.role === 'viewer' && Array.isArray(data.customers)) data.customers = data.customers.map(maskCustomer);
    return { seq, data };
  });
}

/* İzleyiciye 11 haneli vergi numarası (T.C. kimlik no) maskeli gider: 123******01.
   10 haneli vergi numarası (tüzel kişi) maskelenmez. Yedek / dışa aktarma maskesizdir (yalnız yönetici). */
export function maskCustomer(d) {
  if (!d || typeof d.taxNo !== 'string' || !/^\d{11}$/.test(d.taxNo)) return d;
  return { ...d, taxNo: d.taxNo.slice(0, 3) + '******' + d.taxNo.slice(-2) };
}

/* ---- son okunan sıra numarasından beri değişenler ---- */
export async function readChanges(pool, since, me) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (collection, record_id) seq, collection, record_id, op
       FROM changes WHERE seq > $1 ORDER BY collection, record_id, seq DESC`, [since]);
  const max = await maxSeq(pool);
  const items = [];
  for (const r of rows) {
    const it = { c: r.collection, id: r.record_id, op: r.op, seq: Number(r.seq) };
    if (r.collection === '_reload') { items.push(it); continue; }
    if (r.op === 'put') {
      const d = await readOne(pool, r.collection, r.record_id);
      if (d === undefined) it.op = 'del';
      else it.data = r.collection === 'customers' && me?.role === 'viewer' ? maskCustomer(d) : d;
    }
    items.push(it);
  }
  items.sort((a, b) => a.seq - b.seq);
  /* Toplu değişiklik (geri yükleme / içe aktarma) olduysa istemci her şeyi yeniden yüklesin. */
  if (items.some(i => i.c === '_reload')) return { seq: max, reload: true, items: [] };
  return { seq: max, items };
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
export async function applyChanges(pool, me, changes) {
  if (!Array.isArray(changes)) throw new HttpError(400, 'changes dizi olmalı');
  if (changes.length > 5000) throw new HttpError(413, 'Tek seferde en fazla 5000 değişiklik gönderilebilir');
  const rejected = [], adjusted = [];
  let applied = 0;
  const canEdit = me.role !== 'viewer';
  const batch = randomUUID();
  const ctx = { me, batch, adjusted, touchedIssues: new Set() };
  const meAdmin = isAdminRole(me.role);

  await tx(pool, async c => {
    for (const ch of changes) {
      const reject = reason => rejected.push({ c: ch?.c, id: ch?.id, reason });
      if (!ch || typeof ch.c !== 'string' || typeof ch.id !== 'string'
          || ch.c.length > 60 || !/^[\w$-]+$/.test(ch.c) || !['put', 'del'].includes(ch.op)) { reject('geçersiz'); continue; }
      /* Kimlikler HTML özniteliklerine basılır: yalnız güvenli karakterler (XSS'e karşı kalıcı çözüm). */
      if (!validId(ch.id)) { reject('geçersiz kimlik'); continue; }
      if (ch.op === 'put' && ch.data === undefined) { reject('veri yok'); continue; }
      if (ch.op === 'put' && !['_prefs', '_settings'].includes(ch.c)
          && (ch.data === null || typeof ch.data !== 'object' || Array.isArray(ch.data))) { reject('veri nesne olmalı'); continue; }
      if (IGNORED_KEYS.includes(ch.c) || ch.c === '_reload') continue;
      if (reservedName(ch.c)) { reject('geçersiz koleksiyon'); continue; }

      if (ch.c === '_prefs') {                       // herkes kendi tercihini yazar
        if (!PREF_KEYS.includes(ch.id)) { reject('geçersiz tercih'); continue; }
        await c.query(
          `INSERT INTO user_prefs (user_id, data) VALUES ($1, jsonb_build_object($2::text, $3::jsonb))
           ON CONFLICT (user_id) DO UPDATE SET data = user_prefs.data || jsonb_build_object($2::text, $3::jsonb),
           updated_at = now()`, [me.id, ch.id, JSON.stringify(ch.op === 'del' ? null : ch.data)]);
        applied++; continue;
      }
      if (!canEdit) { reject('salt okunur kullanıcı'); continue; }
      if (!meAdmin && (ADMIN_ONLY.includes(ch.c) || (['projects', 'workspaces'].includes(ch.c) && ch.op === 'del'))) {
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
        else if (e.code === '23505') reject(/username/.test(e.constraint || '') ? 'Bu kullanıcı adı kullanılıyor' : 'Bu kayıt zaten var (benzersizlik ihlali)');
        else throw e;
      }
    }
    /* Harcanan süre her zaman süre kayıtlarının toplamıdır (eşzamanlı kayıtta kayma olmasın). */
    for (const iid of ctx.touchedIssues) await recomputeSpent(c, ctx, iid);
    const admins = Number((await c.query(
      `SELECT count(*) AS n FROM users WHERE active AND role IN ('admin','super')`)).rows[0].n);
    if (admins < 1) throw new HttpError(409, 'En az bir aktif yönetici kalmalı');
  });
  return { applied, rejected, adjusted, seq: await maxSeq(pool) };
}

async function applyRecord(c, ctx, ch) {
  const { me, batch } = ctx;
  const table = tableOf(ch.c);
  const sel = table
    ? await c.query(`SELECT data FROM ${table} WHERE id=$1 FOR UPDATE`, [ch.id])
    : await c.query('SELECT data FROM misc_records WHERE collection=$1 AND id=$2 FOR UPDATE', [ch.c, ch.id]);
  const cur = sel.rows[0]?.data;
  const meAdmin = isAdminRole(me.role);

  if (ch.c === 'worklogs' && !meAdmin) {
    const owner = ch.op === 'del' ? cur?.userId : (cur?.userId ?? ch.data?.userId);
    if (owner && owner !== me.id) throw new HttpError(403, 'Başkasının süre kaydını yalnızca yönetici değiştirebilir');
    if (ch.op === 'put' && ch.data?.userId && ch.data.userId !== me.id)
      throw new HttpError(403, 'Başkası adına süre kaydı yalnızca yönetici girebilir');
  }
  if (ch.c === 'worklogs') { if (cur?.issueId) ctx.touchedIssues.add(cur.issueId); if (ch.data?.issueId) ctx.touchedIssues.add(ch.data.issueId); }

  if (ch.op === 'del') {
    if (!cur) return false;
    if (ch.c === 'issues') await cascadeIssueDelete(c, ctx, ch.id);
    if (ch.c === 'workspaces') await checkWorkspaceDelete(c, ch.id);
    if (ch.c === 'customers') {
      /* Kişisel veri: cari çöp kutusuna gitmez, kalıcı silinir (geri alınamaz). */
      await checkCustomerDelete(c, ch.id);
      await c.query('DELETE FROM customers WHERE id=$1', [ch.id]);
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
  let data = { id: ch.id, ...ch.data };
  data.id = ch.id;
  let adjusted = false;
  if (cur && ch.base && typeof ch.base === 'object' && !same(cur, ch.base)) {
    const mine = data;
    data = merge3(ch.base, data, cur);              // başkası bu arada değiştirmiş
    if (ch.c === 'customers' && (mine.contacts === undefined || Array.isArray(mine.contacts))
        && [ch.base, mine, cur].some(x => x.contacts !== undefined))
      data.contacts = mergeContacts(ch.base.contacts, mine.contacts, cur.contacts);
    adjusted = true;
  }
  if (ch.c === 'projects' && cur) {                 // iş sayacı geri gitmesin
    const n = Math.max(Number(cur.counter) || 0, Number(data.counter) || 0);
    if (n !== data.counter) { data.counter = n; adjusted = true; }
  }
  if (ch.c === 'issues' && normalizePriority(data)) adjusted = true;
  if ((ch.c === 'projects' || ch.c === 'workspaces') && normalizeArchived(data)) adjusted = true;
  if (ch.c === 'customers' && normalizeCustomer(data)) adjusted = true;
  if (ch.c === 'workspaces' && enforceCreatedBy(data, cur, me)) adjusted = true;
  validate(ch.c, data);
  /* Atanan değiştiyse var olan, aktif bir kullanıcı olmalı. */
  if (ch.c === 'issues' && data.assignee != null && data.assignee !== '' && data.assignee !== cur?.assignee) {
    const ok = typeof data.assignee === 'string'
      && (await c.query('SELECT 1 FROM users WHERE id=$1 AND active', [data.assignee])).rowCount > 0;
    if (!ok) throw new HttpError(400, 'Atanan kullanıcı bulunamadı ya da pasif');
  }
  if (ch.c === 'issues' && await ensureIssueKey(c, ctx, data, cur)) adjusted = true;
  if (cur && same(cur, data)) { if (adjusted) ctx.adjusted.push({ c: ch.c, id: ch.id }); return false; }
  if (ch.c === 'workspaces') await checkWorkspace(c, me, ch.id, data, cur);
  if (ch.c === 'projects') await checkProjectWorkspace(c, data, cur);
  if (ch.c === 'projects') await checkProjectCustomer(c, data, cur);
  if (ch.c === 'customers') await checkCustomerTaxNo(c, ctx, ch.id, data, cur);

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

  if (ch.c === 'issues') { ctx.touchedIssues.add(ch.id); await notifyForIssue(c, me, data, cur); }
  if (ch.c === 'comments' && !cur) await notifyForComment(c, me, data);
  return true;
}

/* ---- çalışma alanları (#22) ----
   Genel (ws1) varsayılan alandır: silinmez, arşivlenmez, adını yalnız yönetici değiştirir.
   Alanı olmayan proje Genel'de sayılır. */
export const DEFAULT_WS = 'ws1';
const WS_LOCK = 727275;
const wsName = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr');

/* Açan kişi istemciden alınmaz: yeni alanda oturumdaki kullanıcı, var olanda kayıttaki değer. */
function enforceCreatedBy(data, cur, me) {
  const before = data.createdBy;
  if (!cur) data.createdBy = me.id;
  else if (Object.hasOwn(cur, 'createdBy')) data.createdBy = cur.createdBy;
  else delete data.createdBy;
  return !same(before, data.createdBy);
}

async function checkWorkspace(c, me, id, data, cur) {
  if (cur && !isAdminRole(me.role) && (cur.createdBy == null || cur.createdBy !== me.id))
    throw new HttpError(403, 'Bu çalışma alanını yalnızca açan kişi ya da yönetici değiştirebilir');
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

/* ---- cariler (#11) ----
   Ekle/düzenle/sil yalnız yönetici (ADMIN_ONLY). İletilerde yalnız kimlik: unvan/vergi no günlüğe ve
   başka kullanıcıların yanıtına düşmez (istemci unvanı kimlikten kendisi bulur). */
const taxNoTaken = id => id ? `Bu vergi numarasıyla kayıtlı cari var (#${id})` : 'Bu vergi numarasıyla kayıtlı cari var';

/* Vergi numarası (pasifler dahil) tekil. Yeni kayıtta ya da değiştiyse önceden denetlenir; eşzamanlı yazmada
   customers_tax_no_uq indeksi ikincisini reddeder (applyChanges aynı iletiyle eşler). */
async function checkCustomerTaxNo(c, ctx, id, data, cur) {
  const tn = data.taxNo || null;
  ctx.taxNo = tn;
  if (!tn || (cur && (cur.taxNo || null) === tn)) return;
  const other = (await c.query('SELECT id FROM customers WHERE tax_no=$1 AND id<>$2 LIMIT 1', [tn, id])).rows[0];
  if (other) throw new HttpError(409, taxNoTaken(other.id));
}

/* Bağlı projesi (arşivliler dahil) olan cari silinmez. Satır FOR UPDATE ile kilitli: aynı anda bağlayan
   proje (FOR SHARE) ya önce biter ve sayılır ya da cariyi bulamaz. */
async function checkCustomerDelete(c, id) {
  const n = Number((await c.query('SELECT count(*) AS n FROM projects WHERE customer_id=$1', [id])).rows[0].n);
  if (n > 0) throw new HttpError(409, `Bu cariye bağlı ${n} proje var; silmek yerine pasife alın`);
}

/* Projeye cari yeni bağlanıyorsa ya da değiştiyse (güncel kayda göre) cari var ve etkin olmalı.
   Bağ kaldırma serbest; pasife alınmış carinin değişmeyen bağı korunur. */
async function checkProjectCustomer(c, data, cur) {
  const cid = data.customerId;
  if (cid == null || cid === '') return;
  if (cur && (cur.customerId ?? '') === cid) return;
  const row = (await c.query('SELECT active FROM customers WHERE id=$1 FOR SHARE', [cid])).rows[0];
  if (!row) throw new HttpError(400, 'Cari bulunamadı');
  if (!row.active) throw new HttpError(400, 'Pasif cari projeye bağlanamaz');
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
async function cascadeIssueDelete(c, ctx, id) {
  const { me, batch } = ctx;
  const move = async (table, where, params) => {
    const rows = (await c.query(`DELETE FROM ${table} WHERE ${where} RETURNING id, data`, params)).rows;
    for (const r of rows) {
      await c.query(`INSERT INTO deleted_records (collection, record_id, data, batch_id, deleted_by)
        VALUES ($1,$2,$3::jsonb,$4,$5)`, [table, r.id, JSON.stringify(r.data), batch, me.id]);
      await logChange(c, table, r.id, 'del', me.id, batch);
    }
  };
  for (const t of ISSUE_CHILDREN) await move(t, 'issue_id = $1', [id]);
  await move('links', 'from_issue = $1 OR to_issue = $1', [id]);
  for (const [col, key] of [['parent_id', 'parentId'], ['epic_id', 'epicId']]) {
    const rows = (await c.query(`UPDATE issues SET data = jsonb_set(data, '{${key}}', 'null'::jsonb), version = version + 1,
      updated_at = now() WHERE ${col} = $1 RETURNING id`, [id])).rows;
    for (const r of rows) { await logChange(c, 'issues', r.id, 'put', me.id, batch); ctx.adjusted.push({ c: 'issues', id: r.id }); }
  }
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
  if (ch.op === 'del') return (await c.query('DELETE FROM settings WHERE key=$1', [ch.id])).rowCount > 0;
  let val = ch.data;
  if (cur !== undefined && ch.base !== undefined && !same(cur, ch.base)
      && val && typeof val === 'object' && !Array.isArray(val) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
    val = merge3(ch.base, val, cur);
    ctx.adjusted.push({ c: '_settings', id: ch.id });
  }
  if (ch.id === 'cfg') validateCfg(val);
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
  return r.rowCount > 0;
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
        members: admin ? [admin.id] : [], archived: false, workspaceId: DEFAULT_WS })]);
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
