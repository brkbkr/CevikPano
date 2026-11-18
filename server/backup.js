import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { TABLES, IGNORED_KEYS, PREF_KEYS, tx, tableOf, reservedName } from './db.js';
import { HttpError } from './util.js';
import { readAll, publicUser, logChange, DEFAULT_USER_PASSWORD, ensureDefaultWorkspace, DEFAULT_WS } from './store.js';
import { validate, normalizePriority, normalizeArchived, normalizeCustomer, normalizeHistory, validId, stripBadKeys } from './validate.js';

const KEEP_AUTO = 14, KEEP_OTHER = 30;

const countsOf = d => Object.fromEntries(Object.entries(d).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));

/* ---- yedek al ---- */
export async function createSnapshot(db, kind, userId, label) {
  const data = await readAll(db);
  const json = JSON.stringify(data);
  const r = await db.query(
    `INSERT INTO snapshots (kind, label, data, size_bytes, counts, created_by)
     VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6) RETURNING id, created_at`,
    [kind, label || null, json, Buffer.byteLength(json), JSON.stringify(countsOf(data)), userId || null]);
  /* Eski yedekleri temizle. */
  await db.query(`DELETE FROM snapshots WHERE kind='auto' AND id NOT IN
    (SELECT id FROM snapshots WHERE kind='auto' ORDER BY created_at DESC LIMIT ${KEEP_AUTO})`);
  await db.query(`DELETE FROM snapshots WHERE kind<>'auto' AND id NOT IN
    (SELECT id FROM snapshots WHERE kind<>'auto' ORDER BY created_at DESC LIMIT ${KEEP_OTHER})`);
  return r.rows[0];
}

export async function listSnapshots(pool) {
  return (await pool.query(
    `SELECT s.id, s.kind, s.label, s.size_bytes, s.counts, s.created_at, u.name AS created_by_name
       FROM snapshots s LEFT JOIN users u ON u.id = s.created_by ORDER BY s.created_at DESC`)).rows;
}

export async function getSnapshot(pool, id) {
  const r = (await pool.query('SELECT data, created_at FROM snapshots WHERE id=$1', [id])).rows[0];
  if (!r) throw new HttpError(404, 'Yedek bulunamadı');
  return r;
}

/* Günde bir otomatik yedek. */
export function startAutoBackup(pool, log = console.log) {
  const run = async () => {
    try {
      const last = (await pool.query(`SELECT max(created_at) AS t FROM snapshots WHERE kind='auto'`)).rows[0].t;
      const changed = Number((await pool.query(
        `SELECT count(*) AS n FROM changes WHERE at > coalesce($1, '-infinity'::timestamptz)`, [last])).rows[0].n);
      if ((!last || Date.now() - new Date(last).getTime() > 23 * 3600e3) && (changed > 0 || !last)) {
        await createSnapshot(pool, 'auto', null, 'Günlük otomatik yedek');
        log('[yedek] otomatik yedek alındı');
      }
    } catch (e) { log('[yedek] otomatik yedek alınamadı: ' + e.message); }
  };
  setTimeout(run, 60e3).unref();
  setInterval(run, 3600e3).unref();
}

/* ---- tüm veriyi bir JSON ile değiştir (içe aktarma ve yedekten geri yükleme) ----
   Kullanıcı hesapları SİLİNMEZ: dosyadaki kullanıcılar eklenir/güncellenir, mevcut
   parolalar korunur, yeni kullanıcılar başlangıç parolasını alır. */
export async function replaceAll(pool, me, data, kind) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.issues) || !Array.isArray(data.projects))
    throw new HttpError(400, 'Geçerli bir Pano verisi değil (projects ve issues dizileri gerekli)');
  const meSuper = me.role === 'super';
  const stats = {};
  await tx(pool, async c => {
    await createSnapshot(c, kind === 'restore' ? 'pre-restore' : 'pre-import', me.id,
      kind === 'restore' ? 'Geri yükleme öncesi otomatik yedek' : 'İçe aktarma öncesi otomatik yedek');

    /* Kullanıcılar */
    const defHash = await bcrypt.hash(DEFAULT_USER_PASSWORD(), 10);
    let nu = 0;
    for (const u of Array.isArray(data.users) ? data.users : []) {
      if (!u || !u.id || !u.username || !validId(String(u.id))) continue;
      const username = String(u.username).trim().toLowerCase();
      if (!/^[a-z0-9._-]{2,40}$/.test(username)) continue;
      let role = ['super', 'admin', 'member', 'viewer'].includes(u.role) ? u.role : 'member';
      if (role === 'super' && !meSuper) role = 'admin';
      const extra = { ...u };
      for (const k of ['id', 'username', 'name', 'role', 'active', 'system', 'pw', 'salt', 'mustChange', 'password_hash']) delete extra[k];
      const cur = (await c.query('SELECT id FROM users WHERE id=$1 OR lower(username)=$2 LIMIT 1', [String(u.id), username])).rows[0];
      if (cur) {
        if (cur.id === me.id) continue;                  // kendi hesabına dokunma
        await c.query(`UPDATE users SET name=$2, role=$3, active=$4, data=$5::jsonb, updated_at=now() WHERE id=$1`,
          [cur.id, String(u.name || username).slice(0, 200), role, u.active !== false, JSON.stringify(extra)]);
      } else {
        await c.query(`INSERT INTO users (id, username, name, role, active, password_hash, must_change, system, data)
          VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8::jsonb)`,
          [String(u.id), username, String(u.name || username).slice(0, 200), role, u.active !== false, defHash,
            !!u.system, JSON.stringify(extra)]);
        nu++;
      }
    }
    stats.newUsers = nu;

    /* Kayıtlar */
    for (const table of Object.values(TABLES)) await c.query(`DELETE FROM ${table}`);
    await c.query('DELETE FROM misc_records');
    await c.query('DELETE FROM settings');
    for (const [k, v] of Object.entries(data)) {
      if (k === 'users' || IGNORED_KEYS.includes(k) || PREF_KEYS.includes(k) || v === undefined) continue;
      if (reservedName(k)) { stats.skipped = (stats.skipped || 0) + 1; continue; }   // __proto__ / constructor
      if (Array.isArray(v)) {
        const table = tableOf(k);
        const seen = new Set(), taxNos = new Set();
        /* İş anahtarları: projede çift olanlara projedeki en büyük numaradan sonrakini ver. */
        const keyNum = s => { const m = /-(\d+)$/.exec(s || ''); return m ? Number(m[1]) : 0; };
        const maxKey = {}, usedKey = new Set();
        if (k === 'issues') for (const r of v) if (r?.projectId) maxKey[r.projectId] = Math.max(maxKey[r.projectId] || 0, keyNum(r.key));
        let n = 0;
        for (const rec of v) {
          if (!rec || typeof rec !== 'object' || rec.id == null) continue;
          const id = String(rec.id);
          if (!validId(id)) { stats.skipped = (stats.skipped || 0) + 1; continue; }   // HTML'e basılır: güvenli kimlik
          if (seen.has(id)) continue; seen.add(id);
          const d = { ...rec, id };
          stripBadKeys(d);
          if (k === 'issues' && typeof d.key === 'string' && d.key && d.projectId) {
            if (usedKey.has(d.projectId + '|' + d.key)) {
              d.key = d.key.replace(/-\d+$/, '') + '-' + (maxKey[d.projectId] = (maxKey[d.projectId] || 0) + 1);
              stats.fixedKeys = (stats.fixedKeys || 0) + 1;
            }
            usedKey.add(d.projectId + '|' + d.key);
          }
          if (k === 'issues') normalizePriority(d);    // eski yedekte metin/geçersiz öncelik atlanmasın
          if (k === 'projects' || k === 'workspaces') normalizeArchived(d);   // "true"/"false" metni atlanmasın
          if (k === 'customers') normalizeCustomer(d);   // "123 456-7890" → "1234567890"
          if (k === 'history') normalizeHistory(d);      // eski uzun geçmiş metni 200'e kırpılır, atlanmaz
          try { validate(k, d); } catch (e) { stats.skipped = (stats.skipped || 0) + 1; continue; }
          /* Vergi numarası tekil: dosyada ikinci kez geçen cari atlanır (geri yükleme 500 vermesin). */
          if (k === 'customers' && d.taxNo) {
            if (taxNos.has(d.taxNo)) { stats.skipped = (stats.skipped || 0) + 1; continue; }
            taxNos.add(d.taxNo);
          }
          if (table) await c.query(`INSERT INTO ${table} (id, data, updated_by) VALUES ($1,$2::jsonb,$3)`, [id, JSON.stringify(d), me.id]);
          else await c.query(`INSERT INTO misc_records (collection, id, data, updated_by) VALUES ($1,$2,$3::jsonb,$4)`, [k, id, JSON.stringify(d), me.id]);
          n++;
        }
        stats[k] = n;
      } else {
        await c.query(`INSERT INTO settings (key, value, updated_by) VALUES ($1,$2::jsonb,$3)`, [k, JSON.stringify(v), me.id]);
      }
    }
    /* Proje sayaçlarını en büyük iş numarasına çek. */
    await c.query(`UPDATE projects p SET data = jsonb_set(p.data, '{counter}', to_jsonb(m.n))
      FROM (SELECT project_id, max((substring(issue_key from '-(\\d+)$'))::int) n FROM issues GROUP BY project_id) m
      WHERE m.project_id = p.id AND coalesce((p.data->>'counter')::int, 0) < m.n`);
    stats.fixedKeys ||= 0;
    /* Dosyada çalışma alanı yoksa (eski yedek) varsayılan "Genel" yeniden oluşur. Genel arşivlenemez:
       dosyada arşivliyse arşivden çıkar. Olmayan alana bağlı projenin bağı kalkar (Genel'de sayılır). */
    await ensureDefaultWorkspace(c);
    await c.query(`UPDATE workspaces SET data = data || '{"archived":false}'::jsonb WHERE id=$1 AND archived`, [DEFAULT_WS]);
    await c.query(`UPDATE projects p SET data = p.data - 'workspaceId'
      WHERE p.data ? 'workspaceId' AND coalesce(p.workspace_id, '') <> ''
        AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = p.workspace_id)`);
    /* Silinmiş cariye işaret eden bağ (cari silinince yedekten çıkarılır, bağlı kayıt kalabilir): bağ kalkar. */
    await dropOrphanCustomerLinks(c);
    await c.query('DELETE FROM user_prefs');            // eski ekran seçimleri artık geçersiz olabilir
    await logChange(c, '_reload', kind, 'put', me.id);
  });
  return stats;
}

/* Olmayan cariye bağlı proje/iş: customerId (işte ayrıca o carinin talep edeni) kaldırılır. Yalnız geri yükleme yollarında. */
const ORPHAN = cid => `coalesce(${cid}, '') <> '' AND NOT EXISTS (SELECT 1 FROM customers cu WHERE cu.id = ${cid})`;
async function dropOrphanCustomerLinks(c) {
  for (const t of ['projects', 'issues'])
    await c.query(`UPDATE ${t} r SET data = r.data - 'customerId' WHERE ${ORPHAN(`r.data->>'customerId'`)}`);
  await c.query(`UPDATE issues r SET data = r.data - 'requester'
    WHERE jsonb_typeof(r.data->'requester') = 'object' AND ${ORPHAN(`r.data->'requester'->>'customerId'`)}`);
}
async function customerGone(c, id) {
  return typeof id === 'string' && id !== '' && !(await c.query('SELECT 1 FROM customers WHERE id=$1', [id])).rowCount;
}

/* ---- çöp kutusu ---- */
export async function listTrash(pool, limit = 200) {
  return (await pool.query(
    `SELECT d.id, d.collection, d.record_id, d.batch_id, d.deleted_at, u.name AS deleted_by_name,
            d.data->>'key' AS key, coalesce(d.data->>'summary', d.data->>'name', d.data->>'body') AS title,
            (SELECT count(*) FROM deleted_records x WHERE x.batch_id = d.batch_id) AS batch_size
       FROM deleted_records d LEFT JOIN users u ON u.id = d.deleted_by
      WHERE d.collection NOT IN ('history','transitions')
        AND (d.collection NOT IN ('worklogs','comments','links')
             OR NOT EXISTS (SELECT 1 FROM deleted_records y WHERE y.batch_id = d.batch_id
                              AND y.collection NOT IN ('worklogs','comments','links','history','transitions')))
      ORDER BY d.deleted_at DESC LIMIT $1`, [limit])).rows;
}

/* Bir silinmiş kaydı ve aynı işlemde silinen bağlı kayıtlarını (yorum, süre kaydı ...) geri getir. */
export async function restoreTrash(pool, me, id) {
  return tx(pool, async c => {
    const r = (await c.query('SELECT * FROM deleted_records WHERE id=$1', [id])).rows[0];
    if (!r) throw new HttpError(404, 'Kayıt bulunamadı');
    const rows = r.batch_id
      ? (await c.query('SELECT * FROM deleted_records WHERE batch_id=$1 ORDER BY id', [r.batch_id])).rows
      : [r];
    let n = 0;
    const issues = [];
    for (const x of rows) {
      if (x.collection === 'users') {
        const u = x.data;
        const ex = await c.query('SELECT 1 FROM users WHERE id=$1 OR lower(username)=lower($2)', [x.record_id, u.username]);
        if (ex.rowCount) continue;
        const extra = { ...u }; for (const k of ['id', 'username', 'name', 'role', 'active', 'system', 'mustChange']) delete extra[k];
        await c.query(`INSERT INTO users (id, username, name, role, active, password_hash, must_change, data)
          VALUES ($1,$2,$3,$4,true,$5,true,$6::jsonb)`,
          [x.record_id, u.username, u.name || u.username, u.role === 'super' && me.role !== 'super' ? 'admin' : (u.role || 'member'),
            await bcrypt.hash(DEFAULT_USER_PASSWORD(), 10), JSON.stringify(extra)]);
      } else {
        const table = tableOf(x.collection);
        /* Çöpteyken carisi silinmiş proje/iş: bağsız geri gelir (yetim customerId kalmaz). */
        if (['projects', 'issues'].includes(x.collection) && x.data && typeof x.data === 'object') {
          if (await customerGone(c, x.data.customerId)) delete x.data.customerId;
          if (x.collection === 'issues' && x.data.requester && typeof x.data.requester === 'object'
              && await customerGone(c, x.data.requester.customerId)) delete x.data.requester;
        }
        const q = table
          ? await c.query(`INSERT INTO ${table} (id, data, updated_by) VALUES ($1,$2::jsonb,$3) ON CONFLICT (id) DO NOTHING`,
            [x.record_id, JSON.stringify(x.data), me.id])
          : await c.query(`INSERT INTO misc_records (collection, id, data, updated_by) VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING`,
            [x.collection, x.record_id, JSON.stringify(x.data), me.id]);
        if (!q.rowCount) continue;
        if (x.collection === 'issues') issues.push(x.record_id);
      }
      await logChange(c, x.collection, x.record_id, 'put', me.id);
      await c.query('DELETE FROM deleted_records WHERE id=$1', [x.id]);
      n++;
    }
    /* Geri yüklenen her işin geçmişine "Geri yükleme" satırı (B2; sayıya katılmaz). */
    const at = Date.now();
    for (const issueId of issues) {
      const id = 'h_' + randomUUID().replace(/-/g, '').slice(0, 16);
      const data = { id, issueId, userId: me.id, at, field: 'Geri yükleme', kind: 'restore', from: 'Çöp kutusu', to: 'Geri yüklendi' };
      await c.query('INSERT INTO history (id, data, updated_by) VALUES ($1,$2::jsonb,$3)', [id, JSON.stringify(data), me.id]);
      await logChange(c, 'history', id, 'put', me.id);
    }
    return { restored: n };
  });
}

/* ---- etkinlik günlüğü ---- */
export async function activity(pool, limit = 200) {
  return (await pool.query(
    `SELECT ch.seq, ch.collection, ch.record_id, ch.op, ch.at, u.name AS user_name,
            coalesce(i.issue_key, d.data->>'key') AS key,
            coalesce(i.summary, d.data->>'summary', p.name, us.name) AS title
       FROM changes ch
       LEFT JOIN users u ON u.id = ch.user_id
       LEFT JOIN issues i ON ch.collection='issues' AND i.id = ch.record_id
       LEFT JOIN projects p ON ch.collection='projects' AND p.id = ch.record_id
       LEFT JOIN users us ON ch.collection='users' AND us.id = ch.record_id
       LEFT JOIN LATERAL (SELECT data FROM deleted_records dr WHERE ch.op='del' AND dr.collection=ch.collection
                          AND dr.record_id=ch.record_id ORDER BY dr.id DESC LIMIT 1) d ON true
      WHERE ch.collection NOT IN ('_settings','transitions','history','_reload')
      ORDER BY ch.seq DESC LIMIT $1`, [limit])).rows;
}

export { publicUser };
