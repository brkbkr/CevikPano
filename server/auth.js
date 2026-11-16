import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_USER_PASSWORD } from './store.js';
import { HttpError } from './util.js';

export const COOKIE = 'pano_sid';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const sha = t => createHash('sha256').update(t).digest('hex');

function parseCookies(h = '') {
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(value, maxAgeSec, secure) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

const isSecure = req => req.secure || req.headers['x-forwarded-proto'] === 'https';

/* ---- kaba kuvvet koruması: IP+kullanıcı adı başına 15 dakikada 10 deneme ---- */
const attempts = new Map();
function throttle(key) {
  const now = Date.now(), win = 15 * 60 * 1000;
  const a = (attempts.get(key) || []).filter(t => now - t < win);
  if (a.length >= 10) throw new HttpError(429, 'Çok fazla hatalı deneme. 15 dakika sonra tekrar deneyin.');
  a.push(now); attempts.set(key, a);
  if (attempts.size > 10000) attempts.clear();
}

export function authRoutes(app, pool) {
  /* Her istekte oturumu çöz. */
  app.use(async (req, _res, next) => {
    try {
      const tok = parseCookies(req.headers.cookie)[COOKIE];
      if (tok) {
        const r = await pool.query(
          `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`, [sha(tok)]);
        if (r.rows[0]) { req.user = r.rows[0]; req.sessionHash = sha(tok); }
      }
      next();
    } catch (e) { next(e); }
  });

  app.post('/api/auth/login', async (req, res) => {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    throttle(`${req.ip}|${username}`);
    const u = (await pool.query('SELECT * FROM users WHERE lower(username)=$1', [username])).rows[0];
    const ok = u && u.active && u.password_hash && await bcrypt.compare(password, u.password_hash);
    if (!ok) throw new HttpError(401, 'Kullanıcı adı veya parola hatalı.');
    attempts.delete(`${req.ip}|${username}`);
    const tok = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
       VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)`,
      [sha(tok), u.id, String(SESSION_DAYS), String(req.headers['user-agent'] || '').slice(0, 300)]);
    await pool.query('UPDATE users SET last_login_at = now() WHERE id=$1', [u.id]);
    await pool.query('DELETE FROM sessions WHERE expires_at < now()');
    res.setHeader('Set-Cookie', cookieHeader(tok, SESSION_DAYS * 86400, isSecure(req)));
    res.json(meOf(u));
  });

  app.post('/api/auth/logout', async (req, res) => {
    if (req.sessionHash) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [req.sessionHash]);
    res.setHeader('Set-Cookie', cookieHeader('', 0, isSecure(req)));
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireUser, (req, res) => res.json(meOf(req.user)));

  /* Parola değiştir. İlk girişte (must_change) eski parola sorulmaz. */
  app.post('/api/auth/password', requireUser, async (req, res) => {
    const u = req.user;
    const next = String(req.body?.newPassword || '');
    if (!u.must_change) {
      const ok = await bcrypt.compare(String(req.body?.oldPassword || ''), u.password_hash || '');
      if (!ok) throw new HttpError(400, 'Mevcut parola hatalı.');
    }
    if (next.length < 8) throw new HttpError(400, 'Parola en az 8 karakter olmalı.');
    if (next === DEFAULT_USER_PASSWORD()) throw new HttpError(400, 'Başlangıç parolası kullanılamaz.');
    if (u.password_hash && await bcrypt.compare(next, u.password_hash))
      throw new HttpError(400, 'Yeni parola mevcut parolayla aynı olamaz.');
    await pool.query('UPDATE users SET password_hash=$2, must_change=false, updated_at=now() WHERE id=$1',
      [u.id, await bcrypt.hash(next, 10)]);
    /* Diğer cihazlardaki oturumları kapat. */
    await pool.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [u.id, req.sessionHash]);
    await pool.query(`INSERT INTO changes (collection, record_id, op, user_id) VALUES ('users',$1,'put',$1)`, [u.id]);
    res.json({ ok: true });
  });

  /* Yönetici: kullanıcının parolasını belirle / sıfırla. */
  app.post('/api/users/:id/password', requireUser, async (req, res) => {
    const me = req.user;
    if (me.role !== 'admin' && me.role !== 'super') throw new HttpError(403, 'Yalnızca yöneticiler parola sıfırlayabilir.');
    const t = (await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0];
    if (!t) throw new HttpError(404, 'Kullanıcı bulunamadı.');
    if (t.role === 'super' && me.role !== 'super') throw new HttpError(403, 'Süper yöneticinin parolasını yalnızca süper yönetici sıfırlayabilir.');
    const pw = req.body?.password ? String(req.body.password) : DEFAULT_USER_PASSWORD();
    if (pw.length < 8) throw new HttpError(400, 'Parola en az 8 karakter olmalı.');
    await pool.query('UPDATE users SET password_hash=$2, must_change=true, updated_at=now() WHERE id=$1',
      [t.id, await bcrypt.hash(pw, 10)]);
    if (t.id !== me.id) await pool.query('DELETE FROM sessions WHERE user_id=$1', [t.id]);
    await pool.query(`INSERT INTO changes (collection, record_id, op, user_id) VALUES ('users',$1,'put',$2)`, [t.id, me.id]);
    res.json({ ok: true });
  });
}

export function meOf(u) {
  const admin = u.role === 'admin' || u.role === 'super';
  return {
    id: u.id, username: u.username, name: u.name, role: u.role, mustChange: u.must_change,
    /* Başlangıç parolasını yalnızca yöneticiler görür (yeni kullanıcıya iletmek için). */
    defaultPassword: admin ? DEFAULT_USER_PASSWORD() : null,
  };
}

export function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Oturum açmanız gerekiyor.'));
  /* İlk girişte parola değiştirilmeden hiçbir veriye erişilemez. */
  if (req.user.must_change && !req.path.startsWith('/api/auth/'))
    return next(new HttpError(403, 'Devam etmek için önce parolanızı değiştirmelisiniz.'));
  next();
}
