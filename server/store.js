import bcrypt from 'bcryptjs';
import { TABLES, PREF_KEYS, IGNORED_KEYS, tx } from './db.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const DEFAULT_USER_PASSWORD = () => process.env.DEFAULT_USER_PASSWORD || 'Pano2026!';
const SECRET_USER_KEYS = ['pw', 'salt', 'mustChange', 'password', 'password_hash', 'passwordHash'];
const USER_COLS = ['id', 'username', 'name', 'role', 'active', 'system'];
const isAdminRole = r => r === 'admin' || r === 'super';
const ROLES = ['super', 'admin', 'member', 'viewer'];

/* ---- kullanıcıyı istemciye gönderilecek biçime çevir (parola özeti yok) ---- */
export function publicUser(row) {
  return {
    ...row.data,
    id: row.id, username: row.username, name: row.name, role: row.role,
    active: row.active, system: row.system, mustChange: row.must_change,
  };
}

/* ---- tüm durumu oku (tek tutarlı anlık görüntü) ---- */
export async function readState(pool, me) {
  return tx(pool, async c => {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const seq = Number((await c.query('SELECT coalesce(max(seq),0) AS s FROM changes')).rows[0].s);
    const data = {};
    data.users = (await c.query('SELECT * FROM users ORDER BY ord')).rows.map(publicUser);
    for (const [col, table] of Object.entries(TABLES)) {
      data[col] = (await c.query(`SELECT data FROM ${table} ORDER BY ord`)).rows.map(r => r.data);
    }
    for (const r of (await c.query('SELECT collection, data FROM misc_records ORDER BY ord')).rows) {
      (data[r.collection] ||= []).push(r.data);
    }
    for (const r of (await c.query('SELECT key, value FROM settings')).rows) data[r.key] = r.value;
    const pr = (await c.query('SELECT data FROM user_prefs WHERE user_id=$1', [me.id])).rows[0];
    for (const k of PREF_KEYS) if (pr?.data?.[k] !== undefined) data[k] = pr.data[k];
    return { seq, data };
  });
}

/* ---- son okunan sıra numarasından beri değişenler ---- */
export async function readChanges(pool, since) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (collection, record_id) seq, collection, record_id, op
       FROM changes WHERE seq > $1 ORDER BY collection, record_id, seq DESC`, [since]);
  const max = Number((await pool.query('SELECT coalesce(max(seq),0) AS s FROM changes')).rows[0].s);
  const items = [];
  for (const r of rows) {
    const it = { c: r.collection, id: r.record_id, op: r.op, seq: Number(r.seq) };
    if (r.op === 'put') {
      const d = await readOne(pool, r.collection, r.record_id);
      if (d === undefined) it.op = 'del'; else it.data = d;
    }
    items.push(it);
  }
  items.sort((a, b) => a.seq - b.seq);
  return { seq: max, items };
}

async function readOne(db, c, id) {
  if (c === 'users') {
    const r = (await db.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
    return r ? publicUser(r) : undefined;
  }
  if (c === '_settings') return (await db.query('SELECT value FROM settings WHERE key=$1', [id])).rows[0]?.value;
  if (TABLES[c]) return (await db.query(`SELECT data FROM ${TABLES[c]} WHERE id=$1`, [id])).rows[0]?.data;
  return (await db.query('SELECT data FROM misc_records WHERE collection=$1 AND id=$2', [c, id])).rows[0]?.data;
}

const logChange = (c, collection, id, op, uid) =>
  c.query('INSERT INTO changes (collection, record_id, op, user_id) VALUES ($1,$2,$3,$4)', [collection, id, op, uid]);

/* ---- istemciden gelen değişiklikleri uygula ----
   changes: [{ c: 'issues', id: 'i_x', op: 'put'|'del', data: {...} }]
   c === '_settings' → genel ayar (id = anahtar), c === '_prefs' → kişisel tercih.
   Yetkisiz ya da geçersiz değişiklikler atlanır ve `rejected` içinde döner. */
export async function applyChanges(pool, me, changes) {
  if (!Array.isArray(changes)) throw new HttpError(400, 'changes dizi olmalı');
  if (changes.length > 5000) throw new HttpError(413, 'Tek seferde en fazla 5000 değişiklik gönderilebilir');
  const rejected = [];
  let applied = 0;
  const canEdit = me.role !== 'viewer';

  await tx(pool, async c => {
    for (const ch of changes) {
      const reject = reason => rejected.push({ c: ch?.c, id: ch?.id, reason });
      if (!ch || typeof ch.c !== 'string' || typeof ch.id !== 'string' || !ch.id || ch.id.length > 200
          || ch.c.length > 60 || !['put', 'del'].includes(ch.op)) { reject('geçersiz'); continue; }
      if (ch.op === 'put' && ch.data === undefined) { reject('veri yok'); continue; }
      if (ch.op === 'put' && !['_prefs', '_settings'].includes(ch.c)
          && (ch.data === null || typeof ch.data !== 'object' || Array.isArray(ch.data))) { reject('veri nesne olmalı'); continue; }
      if (IGNORED_KEYS.includes(ch.c)) continue;

      if (ch.c === '_prefs') {                       // herkes kendi tercihini yazar
        if (!PREF_KEYS.includes(ch.id)) { reject('geçersiz tercih'); continue; }
        await c.query(
          `INSERT INTO user_prefs (user_id, data) VALUES ($1, jsonb_build_object($2::text, $3::jsonb))
           ON CONFLICT (user_id) DO UPDATE SET data = user_prefs.data || jsonb_build_object($2::text, $3::jsonb),
           updated_at = now()`, [me.id, ch.id, JSON.stringify(ch.op === 'del' ? null : ch.data)]);
        applied++; continue;
      }
      if (!canEdit) { reject('salt okunur kullanıcı'); continue; }

      await c.query('SAVEPOINT ch');
      try {
        const changed = ch.c === 'users' ? await applyUser(c, me, ch)
          : ch.c === '_settings' ? await applySetting(c, me, ch)
          : await applyRecord(c, me, ch);
        if (changed) { await logChange(c, ch.c, ch.id, ch.op, me.id); applied++; }
        await c.query('RELEASE SAVEPOINT ch');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT ch');
        if (e instanceof HttpError) reject(e.message);
        else if (e.code === '23505') reject('benzersizlik ihlali (ör. kullanıcı adı kullanılıyor)');
        else throw e;
      }
    }
    const admins = Number((await c.query(
      `SELECT count(*) AS n FROM users WHERE active AND role IN ('admin','super')`)).rows[0].n);
    if (admins < 1) throw new HttpError(409, 'En az bir aktif yönetici kalmalı');
  });
  const seq = Number((await pool.query('SELECT coalesce(max(seq),0) AS s FROM changes')).rows[0].s);
  return { applied, rejected, seq };
}

async function applyRecord(c, me, ch) {
  const table = TABLES[ch.c];
  if (ch.op === 'del') {
    const r = table
      ? await c.query(`DELETE FROM ${table} WHERE id=$1`, [ch.id])
      : await c.query('DELETE FROM misc_records WHERE collection=$1 AND id=$2', [ch.c, ch.id]);
    return r.rowCount > 0;
  }
  const data = { id: ch.id, ...ch.data };
  const json = JSON.stringify(data);
  const r = table
    ? await c.query(
      `INSERT INTO ${table} AS t (id, data, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = t.version + 1,
         updated_at = now(), updated_by = EXCLUDED.updated_by
       WHERE t.data IS DISTINCT FROM EXCLUDED.data`, [ch.id, json, me.id])
    : await c.query(
      `INSERT INTO misc_records AS t (collection, id, data, updated_by) VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, version = t.version + 1,
         updated_at = now(), updated_by = EXCLUDED.updated_by
       WHERE t.data IS DISTINCT FROM EXCLUDED.data`, [ch.c, ch.id, json, me.id]);
  return r.rowCount > 0;
}

async function applySetting(c, me, ch) {
  if (PREF_KEYS.includes(ch.id) || IGNORED_KEYS.includes(ch.id) || ch.id === 'users' || TABLES[ch.id])
    throw new HttpError(400, 'geçersiz ayar anahtarı');
  if (ch.op === 'del') return (await c.query('DELETE FROM settings WHERE key=$1', [ch.id])).rowCount > 0;
  const r = await c.query(
    `INSERT INTO settings AS s (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by
     WHERE s.value IS DISTINCT FROM EXCLUDED.value`, [ch.id, JSON.stringify(ch.data), me.id]);
  return r.rowCount > 0;
}

async function applyUser(c, me, ch) {
  const meAdmin = isAdminRole(me.role), meSuper = me.role === 'super';
  const cur = (await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [ch.id])).rows[0];

  if (ch.op === 'del') {
    if (!cur) return false;
    if (!meAdmin) throw new HttpError(403, 'Kullanıcı silmek için yönetici olmalısınız');
    if (cur.id === me.id) throw new HttpError(400, 'Kendi hesabınızı silemezsiniz');
    if ((cur.system || cur.role === 'super') && !meSuper) throw new HttpError(403, 'Bu kullanıcıyı yalnızca süper yönetici silebilir');
    await c.query('DELETE FROM users WHERE id=$1', [ch.id]);
    return true;
  }

  const d = { ...ch.data };
  for (const k of SECRET_USER_KEYS) delete d[k];
  const username = String(d.username || cur?.username || '').trim().toLowerCase();
  const name = String(d.name ?? cur?.name ?? '').slice(0, 200);
  let role = ROLES.includes(d.role) ? d.role : (cur?.role || 'member');
  const active = d.active === undefined ? (cur?.active ?? true) : !!d.active;
  const extra = { ...d }; for (const k of USER_COLS) delete extra[k];

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
  if (cur.id === me.id) { role = cur.role; }                 // kendi rolünü/aktifliğini değiştiremez
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
      [username, hash, generated, JSON.stringify({ ini: 'YN', color: '#14161A', capacity: 30 })]);
    log(`[kurulum] Yönetici oluşturuldu: kullanıcı adı "${username}"` +
      (generated ? `, geçici parola: ${password} (ilk girişte değiştirilecek)` : ' (parola ADMIN_PASSWORD değişkeninden)'));
  } else if (process.env.ADMIN_RESET_PASSWORD === 'true' && password) {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `UPDATE users SET password_hash=$2, active=true, must_change=false WHERE lower(username)=$1`, [username, hash]);
    if (r.rowCount) log(`[kurulum] "${username}" parolası ADMIN_PASSWORD ile sıfırlandı. ADMIN_RESET_PASSWORD değişkenini kaldırın.`);
  }

  const p = Number((await pool.query('SELECT count(*) AS n FROM projects')).rows[0].n);
  if (p === 0) {
    const admin = (await pool.query(`SELECT id FROM users WHERE role IN ('super','admin') ORDER BY ord LIMIT 1`)).rows[0];
    await tx(pool, async c => {
      await c.query(`INSERT INTO projects (id, data) VALUES ('p1', $1::jsonb)`, [JSON.stringify({
        id: 'p1', key: 'GEN', code: 'GEN', name: 'Genel', lead: admin?.id || null, counter: 0,
        members: admin ? [admin.id] : [], archived: false })]);
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

export function randomPassword() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = new Uint32Array(14); crypto.getRandomValues(b);
  return Array.from(b, x => a[x % a.length]).join('');
}
