/* Posta kutusu bağlantısı (görev 11, E2): Gmail ve Outlook (Microsoft Graph) OAuth, gelen kutusunu çekme,
   e-postadan iş / yorum ve yönlendirme kuralları. Bağımlılık yok: fetch + node:crypto.

   Güvenlik:
   - Yalnız sabit sağlayıcı adreslerine istek gider (HOSTS); Graph'ın verdiği sonraki/delta bağlantıları da
     aynı denetimden geçer (SSRF yok). İleti kimlikleri yola encodeURIComponent ile girer.
   - OAuth: tek kullanımlık state (10 dk, başlatan yöneticiye bağlı) + PKCE (S256).
   - Jetonlar AES-256-GCM ile şifreli (MAIL_TOKEN_KEY, 32 bayt base64). Hiçbir uçta, istemcide ya da günlükte yok.
   - HTML hiçbir zaman saklanmaz/basılmaz: düz metne çevrilir (text/plain tercih edilir); istemci yalnız esc().
   - KVKK: yalnız yeni gelen kutusu iletileri; ham ileti saklanmaz; günlüğe adres/gövde yazılmaz. */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpError, isAdminRole } from './util.js';
import { applyChanges, logChange, issueAccess } from './store.js';
import { validId } from './validate.js';

export const NOT_CONFIGURED = 'Sunucu yapılandırılmamış';
export const PROVIDERS = ['google', 'microsoft'];
export const SYS_USER = 'u_posta';
export const LABEL_WAITING = 'Talep eden bekleniyor';
const ROUND_MAX = 50;                       // tur başına en fazla ileti
const DESC_MAX = 20000;
const HOSTS = new Set(['accounts.google.com', 'oauth2.googleapis.com', 'gmail.googleapis.com',
  'login.microsoftonline.com', 'graph.microsoft.com']);
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = {
  google: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
  microsoft: 'openid email offline_access User.Read Mail.Read Mail.Send',
};

/* ---- yapılandırma (her çağrıda ortamdan okunur) ---- */
const env = k => String(process.env[k] || '').trim();
function tokenKey() {
  const k = env('MAIL_TOKEN_KEY'); if (!k) return null;
  const b = Buffer.from(k, 'base64');
  return b.length === 32 ? b : null;
}
const tenant = () => (/^[A-Za-z0-9.-]{1,100}$/.test(env('MS_TENANT')) ? env('MS_TENANT') : 'common');
const client = p => (p === 'google' ? { id: env('GOOGLE_CLIENT_ID'), secret: env('GOOGLE_CLIENT_SECRET') }
  : { id: env('MS_CLIENT_ID'), secret: env('MS_CLIENT_SECRET') });
export const providerConfigured = p => PROVIDERS.includes(p) && !!tokenKey() && !!client(p).id && !!client(p).secret;
export const mailConfigured = () => PROVIDERS.some(providerConfigured);
export const pollingEnabled = () => mailConfigured() && env('MAIL_ENABLED') === 'true';
export const pollSec = () => Math.max(30, Math.min(3600, Number(env('MAIL_POLL_SEC')) || 120));
const AUTH_URL = p => (p === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth'
  : `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`);
const TOKEN_URL = p => (p === 'google' ? 'https://oauth2.googleapis.com/token'
  : `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`);
export const redirectUri = (p, origin) =>
  `${(env('PUBLIC_URL') || origin || '').replace(/\/+$/, '')}/api/mail/oauth/${p}/callback`;

/* ---- jeton şifreleme: v1:base64(iv[12] | etiket[16] | şifreli) ---- */
export function encrypt(text) {
  const key = tokenKey(); if (!key) throw new HttpError(409, NOT_CONFIGURED);
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function decrypt(enc) {
  const key = tokenKey(); if (!key || typeof enc !== 'string' || !enc.startsWith('v1:')) return null;
  try {
    const b = Buffer.from(enc.slice(3), 'base64');
    const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }                 // anahtar değişmiş: yeniden bağlanılmalı
}
const b64url = b => b.toString('base64url');

/* ---- sağlayıcı çağrısı (testte taklit edilir) ---- */
let FETCH = (...a) => globalThis.fetch(...a);
export function setMailFetch(f) { FETCH = f || ((...a) => globalThis.fetch(...a)); }

export class ProviderError extends Error {
  constructor(status, message, { retryAfter = null, code = '' } = {}) { super(message); this.status = status; this.retryAfter = retryAfter; this.code = code; }
}
class ReconnectError extends Error {}

function safeUrl(u) {
  let x; try { x = new URL(u); } catch { throw new ProviderError(0, 'Geçersiz sağlayıcı adresi'); }
  if (x.protocol !== 'https:' || !HOSTS.has(x.hostname) || x.username || x.password || x.port)
    throw new ProviderError(0, 'Sağlayıcı adresi izinli değil');
  return x.toString();
}
async function call(url, { method = 'GET', token, form, json, headers = {} } = {}) {
  const h = { accept: 'application/json', ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  let body;
  if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  else if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
  let r;
  try { r = await FETCH(safeUrl(url), { method, headers: h, body, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch (e) { if (e instanceof ProviderError) throw e; throw new ProviderError(503, 'Sağlayıcıya ulaşılamadı'); }
  if (r.status === 429 || r.status >= 500) {
    const ra = Number(r.headers?.get?.('retry-after'));
    throw new ProviderError(r.status, r.status === 429 ? 'Sağlayıcı istek sınırı (429)' : `Sağlayıcı hatası (${r.status})`,
      { retryAfter: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) : null });
  }
  let j = null; try { j = await r.json(); } catch { j = null; }
  if (!r.ok) {
    const code = typeof j?.error === 'string' ? j.error : (j?.error?.code || '');
    const msg = j?.error_description || j?.error?.message || code || `HTTP ${r.status}`;
    throw new ProviderError(r.status, String(msg).replace(/\s+/g, ' ').slice(0, 160), { code: String(code).slice(0, 60) });
  }
  return j || {};
}

/* ---- OAuth ---- */
export async function oauthStart(pool, me, provider, origin) {
  if (!PROVIDERS.includes(provider)) throw new HttpError(404, 'Bilinmeyen sağlayıcı');
  if (!providerConfigured(provider)) throw new HttpError(409, NOT_CONFIGURED);
  const state = b64url(randomBytes(24)), verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  await pool.query(`DELETE FROM mail_oauth_states WHERE created_at < now() - interval '10 minutes'`);
  await pool.query('INSERT INTO mail_oauth_states (state, provider, verifier, user_id) VALUES ($1,$2,$3,$4)',
    [state, provider, verifier, me.id]);
  const q = new URLSearchParams({ client_id: client(provider).id, redirect_uri: redirectUri(provider, origin),
    response_type: 'code', scope: SCOPES[provider], state, code_challenge: challenge, code_challenge_method: 'S256' });
  if (provider === 'google') { q.set('access_type', 'offline'); q.set('prompt', 'consent'); }
  else { q.set('response_mode', 'query'); q.set('prompt', 'select_account'); }
  return `${AUTH_URL(provider)}?${q}`;
}

const EMAIL_RE = /^[^\s\0-\x1f\x7f@<>()",;:]+@[^\s\0-\x1f\x7f@<>()",;:]+\.[^\s\0-\x1f\x7f@<>()",;:]+$/;
export class OAuthFail extends Error { constructor(reason) { super(reason); this.reason = reason; } }

/* Dönüş: state doğrula (tek kullanım, 10 dk, aynı yönetici, aynı sağlayıcı) → kod + PKCE ile jeton → adres. */
export async function oauthCallback(pool, me, provider, q, origin) {
  if (!PROVIDERS.includes(provider)) throw new OAuthFail('saglayici');
  if (!providerConfigured(provider)) throw new OAuthFail('yapilandirma');
  const state = typeof q.state === 'string' ? q.state.slice(0, 200) : '';
  const row = state ? (await pool.query(
    `DELETE FROM mail_oauth_states WHERE state=$1 RETURNING provider, verifier, user_id,
       created_at > now() - interval '10 minutes' AS fresh`, [state])).rows[0] : null;
  if (!row || !row.fresh || row.provider !== provider || row.user_id !== me.id) throw new OAuthFail('state');
  if (q.error) throw new OAuthFail('izin');
  const code = typeof q.code === 'string' ? q.code : '';
  if (!code || code.length > 4096) throw new OAuthFail('izin');
  let tok, address, cursor = null;
  try {
    tok = await call(TOKEN_URL(provider), { method: 'POST', form: { grant_type: 'authorization_code', code,
      redirect_uri: redirectUri(provider, origin), client_id: client(provider).id, client_secret: client(provider).secret,
      code_verifier: row.verifier } });
    if (!tok.access_token) throw new OAuthFail('jeton');
    if (provider === 'google') {
      const p = await call(GMAIL + '/profile', { token: tok.access_token });
      address = p.emailAddress; cursor = p.historyId ? String(p.historyId) : null;
    } else {
      const u = await call(GRAPH + '/me?$select=mail,userPrincipalName', { token: tok.access_token });
      address = u.mail || u.userPrincipalName;
    }
  } catch (e) { if (e instanceof OAuthFail) throw e; throw new OAuthFail('saglayici'); }
  if (!tok.refresh_token) throw new OAuthFail('yenileme');
  address = String(address || '').trim();
  if (!EMAIL_RE.test(address) || address.length > 200) throw new OAuthFail('adres');
  const exp = new Date(Date.now() + Math.max(60, Number(tok.expires_in) || 3600) * 1000);
  const r = await pool.query(
    `INSERT INTO mail_accounts (id, provider, address, refresh_token_enc, access_token_enc, access_expires_at, cursor, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (provider, lower(address)) DO UPDATE SET refresh_token_enc=EXCLUDED.refresh_token_enc,
       access_token_enc=EXCLUDED.access_token_enc, access_expires_at=EXCLUDED.access_expires_at,
       cursor=coalesce(mail_accounts.cursor, EXCLUDED.cursor), status='ok', last_error=NULL, fail_count=0,
       backoff_until=NULL, active=true, updated_at=now()
     RETURNING id`,
    ['mb_' + randomUUID().replace(/-/g, '').slice(0, 16), provider, address, encrypt(tok.refresh_token),
      encrypt(tok.access_token), exp, cursor, me.id]);
  return { id: r.rows[0].id };
}

/* ---- erişim jetonu (gerekirse yenile) ---- */
async function accessToken(pool, acc) {
  if (acc.access_token_enc && acc.access_expires_at && new Date(acc.access_expires_at).getTime() - Date.now() > 60e3) {
    const t = decrypt(acc.access_token_enc); if (t) return t;
  }
  const rt = decrypt(acc.refresh_token_enc);
  if (!rt) throw new ReconnectError();
  let tok;
  try {
    tok = await call(TOKEN_URL(acc.provider), { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: rt,
      client_id: client(acc.provider).id, client_secret: client(acc.provider).secret,
      ...(acc.provider === 'microsoft' ? { scope: SCOPES.microsoft } : {}) } });
  } catch (e) {
    if (e instanceof ProviderError && (e.status === 400 || e.status === 401) ) throw new ReconnectError();
    throw e;
  }
  if (!tok.access_token) throw new ReconnectError();
  const exp = new Date(Date.now() + Math.max(60, Number(tok.expires_in) || 3600) * 1000);
  await pool.query(`UPDATE mail_accounts SET access_token_enc=$2, access_expires_at=$3,
      refresh_token_enc=coalesce($4, refresh_token_enc), updated_at=now() WHERE id=$1`,
    [acc.id, encrypt(tok.access_token), exp, tok.refresh_token ? encrypt(tok.refresh_token) : null]);
  return tok.access_token;
}

/* ---- metin yardımcıları ---- */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', euro: '€', bull: '•' };
const decodeEntities = s => s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  }
  return ENT[e.toLowerCase()] ?? m;
});
/* HTML → düz metin. Çıktı yalnız metindir; istemci yine esc() ile basar. */
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|template|noscript|svg|object|iframe)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(blockquote)\b[^>]*>/gi, '\n[[ALINTI]]\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|h[1-6]|tr|ul|ol|table|section|article|header|footer|pre)\s*>/gi, '\n')
    .replace(/<(p|div|h[1-6]|tr|table|pre)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, '\t')
    .replace(/<[^>]*>/g, '')
    .replace(/</g, '');
  s = decodeEntities(s).replace(/ /g, ' ');
  return tidy(s);
}
const tidy = s => s.replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ')
  .replace(/\n{3,}/g, '\n\n').trim();
/* Alıntı kırpma: yanıt üstü metin kalır. Kırpınca boş kalırsa özgün metin döner. */
const QUOTE_HEAD = [
  /^\s*\[\[ALINTI\]\]\s*$/,
  /^\s*-{2,}\s*(Original Message|Orijinal İleti|Özgün İleti|Forwarded message|İletilen ileti)\s*-{2,}/i,
  /^\s*On .{4,200} wrote:\s*$/i,
  /^.{4,200}(tarihinde|zamanında).{0,200}(şunu yazdı|yazdı):\s*$/i,
  /^\s*_{10,}\s*$/,
  /^\s*(From|Kimden|Gönderen)\s*:\s.+$/i,
];
export function stripQuotes(text) {
  const lines = String(text || '').split('\n'), out = [];
  for (const l of lines) {
    if (QUOTE_HEAD.some(r => r.test(l))) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  const t = tidy(out.join('\n'));
  return t || tidy(String(text || '').replace(/^\s*\[\[ALINTI\]\]\s*$/gm, ''));
}
/* RFC 2047 başlık çözme (=?utf-8?B?...?= / Q). */
export function decodeHeader(v) {
  return String(v || '').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=(\s+(?==\?))?/gi, (m, cs, enc, data) => {
    try {
      const bytes = enc.toLowerCase() === 'b' ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return new TextDecoder(cs.toLowerCase()).decode(bytes);
    } catch { return m; }
  }).replace(/[\r\n]+/g, ' ').trim();
}
const ADDR_RE = /[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+\.[^\s<>,;:"'()[\]]+/g;
const addrsOf = v => [...String(v || '').matchAll(ADDR_RE)].map(m => m[0].toLowerCase());
function parseFrom(v) {
  const s = decodeHeader(v), a = addrsOf(s)[0] || '';
  const name = s.replace(/<[^>]*>/, '').replace(a, '').replace(/["']/g, '').trim();
  return { addr: a, name: name.slice(0, 120) };
}
const msgIds = v => [...String(v || '').matchAll(/<[^<>\s]{1,250}>/g)].map(m => m[0]);
function decodePart(data, ct) {
  const buf = Buffer.from(String(data || ''), 'base64url');
  const cs = /charset="?([\w.:-]+)"?/i.exec(ct || '')?.[1] || 'utf-8';
  try { return new TextDecoder(cs.toLowerCase()).decode(buf); } catch { return buf.toString('utf8'); }
}

/* ---- sağlayıcı iletisini ortak biçime çevir ---- */
export function parseGmail(m) {
  const H = new Map();
  for (const h of m?.payload?.headers || []) { const k = String(h.name || '').toLowerCase(); if (!H.has(k)) H.set(k, String(h.value || '')); }
  let plain = '', html = '', attachments = 0;
  const walk = (p, depth = 0) => {
    if (!p || depth > 20) return;
    const type = String(p.mimeType || '').toLowerCase();
    const ct = (p.headers || []).find(h => String(h.name).toLowerCase() === 'content-type')?.value || '';
    if (p.filename) { attachments++; return; }
    if (type === 'text/plain' && p.body?.data && !plain) plain = decodePart(p.body.data, ct);
    else if (type === 'text/html' && p.body?.data && !html) html = decodePart(p.body.data, ct);
    for (const c of p.parts || []) walk(c, depth + 1);
  };
  walk(m?.payload);
  return {
    providerId: String(m?.id || ''), labels: Array.isArray(m?.labelIds) ? m.labelIds : [],
    threadId: typeof m?.threadId === 'string' ? m.threadId.slice(0, 200) : '',
    messageId: msgIds(H.get('message-id'))[0] || '', inReplyTo: msgIds(H.get('in-reply-to')),
    references: msgIds(H.get('references')), subject: decodeHeader(H.get('subject')),
    from: parseFrom(H.get('from')), to: [...addrsOf(H.get('to')), ...addrsOf(H.get('cc')), ...addrsOf(H.get('delivered-to'))],
    autoSubmitted: (H.get('auto-submitted') || '').toLowerCase(), precedence: (H.get('precedence') || '').toLowerCase(),
    receivedAt: Number(m?.internalDate) ? new Date(Number(m.internalDate)) : new Date(),
    text: plain ? tidy(plain) : htmlToText(html), attachments,
  };
}
export function parseGraph(m) {
  const H = new Map();
  for (const h of m?.internetMessageHeaders || []) { const k = String(h.name || '').toLowerCase(); if (!H.has(k)) H.set(k, String(h.value || '')); }
  const rcp = l => (Array.isArray(l) ? l : []).map(x => String(x?.emailAddress?.address || '').toLowerCase()).filter(Boolean);
  const body = m?.body || {};
  return {
    providerId: String(m?.id || ''), labels: [],
    messageId: msgIds(m?.internetMessageId)[0] || '', inReplyTo: msgIds(H.get('in-reply-to')),
    references: msgIds(H.get('references')), subject: String(m?.subject || '').replace(/[\r\n]+/g, ' ').trim(),
    from: { addr: String(m?.from?.emailAddress?.address || '').toLowerCase(), name: String(m?.from?.emailAddress?.name || '').slice(0, 120) },
    to: [...rcp(m?.toRecipients), ...rcp(m?.ccRecipients)],
    autoSubmitted: (H.get('auto-submitted') || '').toLowerCase(), precedence: (H.get('precedence') || '').toLowerCase(),
    receivedAt: m?.receivedDateTime ? new Date(m.receivedDateTime) : new Date(),
    text: String(body.contentType || '').toLowerCase() === 'html' ? htmlToText(body.content) : tidy(String(body.content || '')),
    attachments: m?.hasAttachments ? -1 : 0,
  };
}

/* ---- yönlendirme kuralları: sırayla, ilk eşleşen ---- */
const low = s => String(s || '').toLocaleLowerCase('tr').trim();
const lowA = s => String(s || '').toLowerCase().trim();          // adresler: ASCII küçük harf (İ/ı tuzağı yok)
export function matchRule(rules, accId, msg) {
  for (const r of rules) {
    if (r.active === false) continue;
    if (r.account_id && r.account_id !== accId) continue;
    if (r.to_match && !msg.to.some(a => a.includes(lowA(r.to_match)))) continue;
    if (r.subject_contains && !low(msg.subject).includes(low(r.subject_contains))) continue;
    if (r.from_domain) {
      const d = lowA(r.from_domain).replace(/^@/, ''), fd = msg.from.addr.split('@')[1] || '';
      if (!(fd === d || fd.endsWith('.' + d))) continue;
    }
    return r;
  }
  return null;
}

/* ---- sistem kullanıcısı: e-postadan gelen işlerin yazarı (giriş yapamaz: parolası yok) ---- */
async function ensureSysUser(pool) {
  const r = await pool.query(`INSERT INTO users (id, username, name, role, active, password_hash, must_change, system, data)
    VALUES ($1, 'posta-sistemi', 'E-posta', 'member', true, NULL, false, true, '{"ini":"EP","color":"#64748B"}'::jsonb)
    ON CONFLICT DO NOTHING RETURNING id`, [SYS_USER]);
  if (r.rowCount) await logChange(pool, 'users', SYS_USER, 'put', null, null);
  return { id: SYS_USER, role: 'member' };
}

const colKey = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr');
const KEY_IN_SUBJECT = /\[([A-Z][A-Z0-9]{0,15}-\d{1,9})\]/;

async function findThreadIssue(pool, msg) {
  const refs = [...msg.inReplyTo, ...msg.references].filter(Boolean).slice(0, 50);
  if (refs.length) {
    const r = (await pool.query(`SELECT m.issue_id FROM mail_messages m JOIN issues i ON i.id = m.issue_id
      WHERE m.message_id = ANY($1) ORDER BY m.id LIMIT 1`, [refs])).rows[0];
    if (r) return r.issue_id;
  }
  const k = KEY_IN_SUBJECT.exec(msg.subject || '')?.[1];
  if (k) {
    const r = (await pool.query('SELECT id FROM issues WHERE issue_key=$1 ORDER BY updated_at DESC LIMIT 1', [k])).rows[0];
    if (r) return r.id;
  }
  return null;
}

async function findRequester(pool, addr) {
  if (!addr) return null;
  const r = (await pool.query(`SELECT c.id AS customer_id, ct->>'id' AS contact_id FROM customers c,
      jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'contacts')='array' THEN c.data->'contacts' ELSE '[]'::jsonb END) ct
    WHERE c.active AND lower(ct->>'email') = lower($1) ORDER BY c.ord LIMIT 1`, [addr])).rows[0];
  return r && validId(r.contact_id) ? { customerId: r.customer_id, contactId: r.contact_id } : null;
}

const hid = () => 'h_' + randomUUID().replace(/-/g, '').slice(0, 16);
function applied(res) {
  if (res.rejected?.length) throw new Error('reddedildi: ' + res.rejected.map(x => x.reason).join(', ').slice(0, 160));
}

async function addReply(pool, sys, issueId, msg) {
  const cur = (await pool.query('SELECT data FROM issues WHERE id=$1', [issueId])).rows[0]?.data;
  if (!cur) return null;
  const cid = 'c_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const who = msg.from.name ? `${msg.from.name} <${msg.from.addr}>` : msg.from.addr;
  const body = `${who} e-postayla yanıtladı:\n\n${stripQuotes(msg.text) || '(boş ileti)'}${attNote(msg)}`.slice(0, DESC_MAX);
  const changes = [{ c: 'comments', id: cid, op: 'put',
    data: { issueId, userId: sys.id, at: Date.now(), body, source: { kind: 'email', from: msg.from.addr } } }];
  /* "Talep edenden yanıt bekleniyor" → "İnceleniyor" (aynı projede o adlı kolon varsa). */
  const st = (await pool.query('SELECT id, data FROM statuses WHERE project_id=$1', [cur.projectId])).rows;
  const now = st.find(s => s.id === cur.statusId);
  const to = st.find(s => colKey(s.data?.name) === colKey('İnceleniyor'));
  if (now && to && colKey(now.data?.name) === colKey('Talep edenden yanıt bekleniyor')) {
    changes.push({ c: 'issues', id: issueId, op: 'put', data: { ...cur, statusId: to.id, updatedAt: Date.now() }, base: cur });
    changes.push({ c: 'history', id: hid(), op: 'put', data: { issueId, userId: sys.id, at: Date.now(), field: 'Durum', from: now.data.name, to: to.data.name } });
  }
  applied(await applyChanges(pool, sys, changes, { system: true }));
  return cid;
}
const attNote = m => (m.attachments > 0 ? `\n\n(${m.attachments} ek vardı; ekler aktarılmadı.)`
  : m.attachments < 0 ? '\n\n(İletide ek vardı; ekler aktarılmadı.)' : '');

async function createFromMail(pool, sys, acc, msg) {
  const rules = (await pool.query('SELECT * FROM mail_rules WHERE active ORDER BY ord, created_at')).rows;
  const rule = matchRule(rules, acc.id, msg);
  const projOf = async id => (id ? (await pool.query('SELECT data FROM projects WHERE id=$1', [id])).rows[0]?.data : null);
  let proj = await projOf(rule?.project_id);
  let assignee = proj ? rule.assignee_id || null : null;
  if (!proj) proj = await projOf(acc.default_project_id);
  if (!proj) throw new Error('Varsayılan proje seçilmemiş ya da silinmiş; ileti atlandı');
  const st = (await pool.query(`SELECT id, data FROM statuses WHERE project_id=$1`, [proj.id])).rows
    .sort((a, b) => (Number(a.data?.ord) || 0) - (Number(b.data?.ord) || 0));
  const s0 = st.find(s => s.data?.cat === 'todo') || st[0];
  const cfg = (await pool.query(`SELECT value FROM settings WHERE key='cfg'`)).rows[0]?.value;
  const rank = Number((await pool.query(`SELECT coalesce(max((data->>'rank')::numeric),0) AS r FROM issues
    WHERE data->>'rank' ~ '^[0-9]+(\\.[0-9]+)?$'`)).rows[0].r) + 100;
  const requester = await findRequester(pool, msg.from.addr);
  const id = 'i_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const key = `${proj.key || 'IS'}-${(Number(proj.counter) || 0) + 1}`;
  const now = Date.now();
  const data = {
    key, projectId: proj.id, type: (Array.isArray(cfg?.types) && typeof cfg.types[0]?.id === 'string' && cfg.types[0].id) || 'task',
    summary: (msg.subject || '(Konu yok)').slice(0, 500), description: (stripQuotes(msg.text) + attNote(msg)).slice(0, DESC_MAX),
    statusId: s0?.id || null, assignee, reporter: sys.id, priority: 3, points: null, estimate: 0, remainingEst: 0, spent: 0,
    labels: requester ? [] : [LABEL_WAITING], cf: {}, sprintId: null, epicId: null, parentId: null, start: '', due: '',
    created: now, updatedAt: now, billable: 'Faturalanacak', billType: 'Kişi/Saat', rank,
    source: { kind: 'email', provider: acc.provider, from: msg.from.addr, fromName: msg.from.name, at: msg.receivedAt.getTime() },
  };
  if (requester) data.requester = requester; else if (EMAIL_RE.test(msg.from.addr) && msg.from.addr.length <= 200) data.requesterEmail = msg.from.addr;
  const hist = k => ({ c: 'history', id: hid(), op: 'put', data: { issueId: id, userId: sys.id, at: now, field: 'Oluşturma', from: '', to: k, kind: 'create', key: k } });
  let res = await applyChanges(pool, sys, [{ c: 'issues', id, op: 'put', data }, hist(key)], { system: true });
  if (res.rejected?.length && assignee) {      // kuraldaki atanan pasifleşmişse atanmadan aç
    res = await applyChanges(pool, sys, [{ c: 'issues', id, op: 'put', data: { ...data, assignee: null } }, hist(key)], { system: true });
  }
  applied(res);
  return id;
}

/* Bir ileti: döngü önleme → Message-ID tekilliği → konu/yanıt eşlemesi → yorum ya da yeni iş. */
export async function processMessage(pool, acc, msg) {
  const own = String(acc.address).toLowerCase();
  const mid = msg.messageId || `<${acc.provider}.${msg.providerId}@cevikpano.invalid>`;
  const skip = (msg.from.addr === own) || !msg.from.addr
    || (msg.autoSubmitted && msg.autoSubmitted !== 'no')
    || ['bulk', 'junk', 'list'].includes(msg.precedence)
    || msg.labels.some(l => ['SPAM', 'TRASH', 'SENT', 'DRAFT'].includes(l));
  const claim = await pool.query(`INSERT INTO mail_messages (message_id, account_id, provider_msg_id, direction, from_addr, received_at, subject, thread_id)
    VALUES ($1,$2,$3,'in',$4,$5,$6,$7) ON CONFLICT (message_id) DO NOTHING RETURNING id`,
    [mid.slice(0, 300), acc.id, msg.providerId.slice(0, 200), skip ? null : msg.from.addr.slice(0, 200), msg.receivedAt,
      skip ? null : String(msg.subject || '').slice(0, 500), msg.threadId || null]);
  if (!claim.rowCount) return 'duplicate';
  if (skip) return 'skipped';
  const rowId = claim.rows[0].id;
  try {
    const sys = await ensureSysUser(pool);
    const thread = await findThreadIssue(pool, msg);
    if (thread) {
      const cid = await addReply(pool, sys, thread, msg);
      if (cid) { await pool.query('UPDATE mail_messages SET issue_id=$2, comment_id=$3 WHERE id=$1', [rowId, thread, cid]); return 'comment'; }
    }
    const iid = await createFromMail(pool, sys, acc, msg);
    await pool.query('UPDATE mail_messages SET issue_id=$2 WHERE id=$1', [rowId, iid]);
    return 'issue';
  } catch (e) {
    await pool.query('DELETE FROM mail_messages WHERE id=$1', [rowId]);
    throw e;
  }
}

/* ---- yeni iletileri listele ---- */
async function seen(pool, acc, ids) {
  if (!ids.length) return new Set();
  return new Set((await pool.query('SELECT provider_msg_id FROM mail_messages WHERE account_id=$1 AND provider_msg_id = ANY($2)',
    [acc.id, ids])).rows.map(r => r.provider_msg_id));
}
async function gmailRound(pool, acc, token) {
  const ids = [];
  let next = acc.cursor, page = '', latest = null;
  if (!acc.cursor) {
    const p = await call(GMAIL + '/profile', { token });
    return { msgs: [], cursor: p.historyId ? String(p.historyId) : null };
  }
  try {
    for (let i = 0; i < 10; i++) {
      const q = new URLSearchParams({ startHistoryId: acc.cursor, historyTypes: 'messageAdded', labelId: 'INBOX', maxResults: '100' });
      if (page) q.set('pageToken', page);
      const h = await call(`${GMAIL}/history?${q}`, { token });
      for (const x of h.history || []) for (const a of x.messagesAdded || []) {
        const lb = a.message?.labelIds || [];
        if (a.message?.id && lb.includes('INBOX') && !lb.includes('SPAM') && !ids.includes(a.message.id)) ids.push(String(a.message.id));
      }
      latest = h.historyId ? String(h.historyId) : latest;
      page = h.nextPageToken || '';
      if (!page) break;
    }
    next = page ? acc.cursor : (latest || acc.cursor);
  } catch (e) {
    if (!(e instanceof ProviderError && e.status === 404)) throw e;
    /* Geçmiş kimliği eskimiş: son 1 günün gelen kutusu, imleç bugüne. */
    const l = await call(`${GMAIL}/messages?${new URLSearchParams({ q: 'in:inbox -in:spam newer_than:1d', maxResults: '100' })}`, { token });
    for (const m of l.messages || []) if (m?.id) ids.push(String(m.id));
    next = String((await call(GMAIL + '/profile', { token })).historyId || '') || null;
  }
  const done = await seen(pool, acc, ids);
  const todo = ids.filter(x => !done.has(x));
  const take = todo.slice(0, ROUND_MAX);
  if (todo.length > ROUND_MAX) next = acc.cursor;          // kalanlar sonraki turda (tekrarlar elenir)
  const msgs = [];
  for (const id of take) {
    try { msgs.push(parseGmail(await call(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`, { token }))); }
    catch (e) { if (!(e instanceof ProviderError && e.status === 404)) throw e; }
  }
  return { msgs, cursor: next };
}
const GRAPH_SEL = 'id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,internetMessageHeaders';
async function graphRound(pool, acc, token) {
  const pref = { prefer: 'odata.maxpagesize=50' };
  let url = acc.cursor;
  if (!url) {                                   // ilk bağlantı: yalnız bundan sonra gelenler
    url = `${GRAPH}/me/mailFolders/inbox/messages/delta?$select=id&$filter=${encodeURIComponent(`receivedDateTime ge ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`)}`;
    for (let i = 0; i < 20; i++) {
      const j = await call(url, { token, headers: pref });
      if (j['@odata.deltaLink']) return { msgs: [], cursor: j['@odata.deltaLink'] };
      if (!j['@odata.nextLink']) break;
      url = j['@odata.nextLink'];
    }
    return { msgs: [], cursor: null };
  }
  const ids = []; let next = url;
  for (let i = 0; i < 20; i++) {
    const j = await call(url, { token, headers: pref });
    for (const m of j.value || []) if (m?.id && !m['@removed'] && !ids.includes(m.id)) ids.push(String(m.id));
    if (j['@odata.deltaLink']) { next = j['@odata.deltaLink']; break; }
    if (!j['@odata.nextLink']) break;
    next = url = j['@odata.nextLink'];
    if (ids.length >= ROUND_MAX) break;               // kalanlar sonraki turda (nextLink'ten devam)
  }
  const done = await seen(pool, acc, ids);
  const msgs = [];
  for (const id of ids.filter(x => !done.has(x)).slice(0, ROUND_MAX * 2)) {
    try {
      msgs.push(parseGraph(await call(`${GRAPH}/me/messages/${encodeURIComponent(id)}?$select=${GRAPH_SEL}`,
        { token, headers: { prefer: 'outlook.body-content-type="text"' } })));
    } catch (e) { if (!(e instanceof ProviderError && e.status === 404)) throw e; }
  }
  return { msgs, cursor: next };
}

/* ---- yöneticilere bildirim: kutu yeniden bağlanmalı ---- */
async function notifyReconnect(pool, acc) {
  const admins = (await pool.query(`SELECT id FROM users WHERE active AND role IN ('admin','super') AND NOT (id = $1)`, [SYS_USER])).rows;
  for (const a of admins) await pool.query(`INSERT INTO notifications (user_id, kind, issue_id, actor_id, meta) VALUES ($1,'mail',NULL,NULL,$2::jsonb)`,
    [a.id, JSON.stringify({ address: acc.address, provider: acc.provider, reason: 'reconnect' })]);
}

/* ---- bir kutuyu çek (kutu başına danışma kilidi; aynı anda iki tur olmaz) ---- */
export async function pollAccount(pool, id, log = () => {}) {
  const c = await pool.connect();
  let locked = false;
  try {
    locked = (await c.query('SELECT pg_try_advisory_lock(727290, hashtext($1)) AS ok', [id])).rows[0].ok;
    if (!locked) return { skipped: true };
    const acc = (await pool.query('SELECT * FROM mail_accounts WHERE id=$1', [id])).rows[0];
    if (!acc || !acc.active || acc.status !== 'ok') return { skipped: true };
    const out = { issues: 0, comments: 0, skipped: 0, duplicate: 0, errors: 0 };
    try {
      const token = await accessToken(pool, acc);
      const r = acc.provider === 'google' ? await gmailRound(pool, acc, token) : await graphRound(pool, acc, token);
      let lastErr = null;
      for (const m of r.msgs.sort((a, b) => a.receivedAt - b.receivedAt)) {
        try {
          const k = await processMessage(pool, acc, m);
          if (k === 'issue') out.issues++; else if (k === 'comment') out.comments++; else if (k === 'duplicate') out.duplicate++; else out.skipped++;
        } catch (e) { out.errors++; lastErr = String(e.message || 'İleti işlenemedi').slice(0, 200); }
      }
      await pool.query(`UPDATE mail_accounts SET cursor=coalesce($2, cursor), last_poll_at=now(), last_error=$3, fail_count=0,
        backoff_until=NULL, updated_at=now() WHERE id=$1`, [id, r.cursor, lastErr]);
      if (out.issues || out.comments || out.errors) log(`[posta] ${id}: ${out.issues} iş, ${out.comments} yorum, ${out.errors} hata`);
      return out;
    } catch (e) {
      if (e instanceof ReconnectError) {
        const u = await pool.query(`UPDATE mail_accounts SET status='reconnect', access_token_enc=NULL, refresh_token_enc=NULL,
          access_expires_at=NULL, last_error='Yeniden bağlanın: posta kutusunun izni sona erdi ya da geri alındı',
          last_poll_at=now(), updated_at=now() WHERE id=$1 AND status='ok' RETURNING id`, [id]);
        if (u.rowCount) await notifyReconnect(pool, acc);
        log(`[posta] ${id}: yeniden bağlanılmalı`);
        return { ...out, reconnect: true };
      }
      const n = (acc.fail_count || 0) + 1;
      const wait = e instanceof ProviderError && e.retryAfter ? e.retryAfter : Math.min(3600, pollSec() * 2 ** Math.min(n - 1, 6));
      const msg = e instanceof ProviderError
        ? `${e.message}; ${wait} sn sonra yeniden denenecek` : 'Çekme başarısız; yeniden denenecek';
      await pool.query(`UPDATE mail_accounts SET fail_count=$2, backoff_until=now() + make_interval(secs => $3),
        last_error=$4, last_poll_at=now(), updated_at=now() WHERE id=$1`, [id, n, wait, msg.slice(0, 200)]);
      log(`[posta] ${id}: çekme başarısız (${e instanceof ProviderError ? e.status : 'iç hata'})`);
      return { ...out, error: true, retryIn: wait };
    }
  } finally {
    if (locked) await c.query('SELECT pg_advisory_unlock(727290, hashtext($1))', [id]).catch(() => {});
    c.release();
  }
}

export async function pollAll(pool, log = () => {}) {
  const ids = (await pool.query(`SELECT id FROM mail_accounts WHERE active AND status='ok'
    AND (backoff_until IS NULL OR backoff_until <= now()) ORDER BY created_at`)).rows.map(r => r.id);
  for (const id of ids) await pollAccount(pool, id, log);
}

export function startMailPoller(pool, log = console.log) {
  let running = false;
  const run = async () => {
    if (running || !pollingEnabled()) return;
    running = true;
    try { await pollAll(pool, log); } catch (e) { log('[posta] tur başarısız: ' + (e.code || e.message)); } finally { running = false; }
  };
  setTimeout(run, 15e3).unref();
  setInterval(run, pollSec() * 1000).unref();
}

/* ---- kart içinden e-postayla yanıt (madde 21, E3) ----
   Alıcı, konu ve zincir başlıkları yalnız sunucuda, işin kaynağı olan gelen iletiden (mail_messages) belirlenir;
   istemci yalnız düz metin gövde gönderir. Başlık değerlerinde CR/LF olamaz (assertHeader); konu RFC 2047 ile,
   gövde base64 ile kodlanır. Yetki: işe Üye ya da Yönetici rolüyle erişen (izleyici 403, erişimi olmayan 404). */
export const RECONNECT_MSG = 'Posta kutusunu yeniden bağlayın (Sistem → Posta kutuları): gönderme izni yok ya da bağlantının süresi doldu';
export const REPLY_BODY_MAX = 10000;
/* Hız sınırları (bellekte): kullanıcı başına dakikada 10; ayrıca posta kutusu başına saatte 100 ve iş başına saatte 20
   (çok hesapla toplam gönderim sınırsız olmasın). Üçü birlikte denetlenir; biri doluysa hiçbirine yazılmaz. */
export const REPLY_LIMITS = {
  user: { max: 10, windowMs: 60e3, msg: 'Çok fazla e-posta yanıtı; bir dakika sonra yeniden deneyin' },
  account: { max: 100, windowMs: 3600e3, msg: 'Bu posta kutusundan saatlik e-posta yanıtı sınırına ulaşıldı; daha sonra yeniden deneyin' },
  issue: { max: 20, windowMs: 3600e3, msg: 'Bu işe saatlik e-posta yanıtı sınırına ulaşıldı; daha sonra yeniden deneyin' },
};
export const REPLY_RATE = REPLY_LIMITS.user;
const replyHits = new Map();                     // 'u:'/'a:'/'i:' + kimlik → son gönderim zamanları
export function resetReplyLimit() { replyHits.clear(); replyIdem.clear(); }
function takeReplySlot(uid, accId, issueId) {
  const now = Date.now();
  if (replyHits.size > 5000) for (const [k, l] of replyHits) if (!l.some(t => now - t < 3600e3)) replyHits.delete(k);
  const slots = [['u:' + uid, REPLY_LIMITS.user], ['a:' + accId, REPLY_LIMITS.account], ['i:' + issueId, REPLY_LIMITS.issue]]
    .map(([k, lim]) => [k, lim, (replyHits.get(k) || []).filter(t => now - t < lim.windowMs)]);
  for (const [k, lim, l] of slots) if (l.length >= lim.max) { replyHits.set(k, l); throw new HttpError(429, lim.msg); }
  for (const [k, , l] of slots) { l.push(now); replyHits.set(k, l); }
}
/* Çift gönderim önleme: istemci her taslak için bir istek kimliği (requestId) üretir; sunucu 15 dk saklar.
   Aynı kimlikle gelen ikinci istek e-posta göndermez: gönderim sürüyorsa 409, gitmişse ilk sonucu (duplicate) döner.
   Gönderim başarısızsa kimlik silinir (yeniden denenebilir); gönderim başarılı olup kayıt adımı hata verse de kimlik kalır. */
export const REPLY_IDEM_MS = 15 * 60e3;
export const REPLY_PENDING_MSG = 'Bu yanıt zaten gönderiliyor; birkaç saniye sonra yeniden deneyin';
const replyIdem = new Map();                     // kullanıcı|iş|requestId → { at, sig, state: 'pending'|'sent', result }
const REQ_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
/* Sağlayıcı ileti kimliği yol parçası olarak kullanılır: '/', '\\', '..' ya da denetim karakteri içeren kimlik kullanılmaz. */
const validPid = v => (typeof v === 'string' && v.length > 0 && v.length <= 300 && !/[\/\\\0-\x1f\x7f]/.test(v) && !v.includes('..') ? v : '');
const CRLF = /[\r\n\u2028\u2029]/;
function assertHeader(name, v) {
  const s = String(v ?? '');
  if (CRLF.test(s) || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) throw new HttpError(400, `Geçersiz e-posta başlığı (${name})`);
  return s;
}
const cleanSubject = s => String(s || '').replace(/[\0-\x1f\x7f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
export function replySubject(orig, key) {
  let s = cleanSubject(orig);
  for (let i = 0; i < 5; i++) s = s.replace(/^(re|ynt|yanıt|aw|sv|fw|fwd|ilt)\s*:\s*/i, '');
  if (key) s = s.split(`[${key}]`).join('').replace(/\s+/g, ' ').trim();
  s = s.slice(0, 200) || '(Konu yok)';
  return `Re: ${s}${key ? ` [${key}]` : ''}`;
}
const encWord = s => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
const validMid = v => (/^<[^<>\s]{1,250}>$/.test(String(v || '')) ? String(v) : '');
/* RFC 5322 düz metin ileti (Gmail raw). Her başlık değeri CR/LF denetiminden geçer. */
export function buildMime({ from, to, subject, messageId, inReplyTo, references, body }) {
  const H = [['From', from], ['To', to], ['Subject', encWord(subject)], ['Date', new Date().toUTCString()], ['Message-ID', messageId]];
  if (inReplyTo) H.push(['In-Reply-To', inReplyTo]);
  if (references?.length) H.push(['References', references.join(' ')]);
  H.push(['MIME-Version', '1.0'], ['Content-Type', 'text/plain; charset=UTF-8'], ['Content-Transfer-Encoding', 'base64']);
  const b64 = Buffer.from(String(body).replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return H.map(([k, v]) => `${k}: ${assertHeader(k, v)}`).join('\r\n') + '\r\n\r\n' + b64 + '\r\n';
}

/* İşin kaynağı olan gelen ileti + bağlı kutu. Uygun değilse { reason } döner (409 metni). */
async function replyContext(pool, me, issueId) {
  const acc0 = await issueAccess(pool, me, issueId);
  if (!acc0) throw new HttpError(404, 'İş bulunamadı');
  if (!acc0.write) throw new HttpError(403, 'Bu projede "Yorum yazma" yetkiniz yok (e-postayla yanıt yorum ekler)');
  if (!pollingEnabled()) return { reason: mailConfigured() ? 'E-posta kapalı (sunucuda MAIL_ENABLED=true değil)' : NOT_CONFIGURED, issue: acc0.data };
  /* Alıcı yalnız işi oluşturan özgün ileti (comment_id IS NULL) ve işin kaynağı e-postaysa; sonradan "[ANAHTAR]" konusuyla
     zincire eklenen dış iletiler alıcı belirleyemez. */
  const src = acc0.data?.source?.kind === 'email' ? (await pool.query(`SELECT * FROM mail_messages WHERE issue_id=$1 AND direction='in'
    AND from_addr IS NOT NULL AND comment_id IS NULL ORDER BY id LIMIT 1`, [issueId])).rows[0] : null;
  if (!src) return { reason: 'Bu iş bir e-postadan oluşmadı', issue: acc0.data };
  const acc = src.account_id ? (await pool.query('SELECT * FROM mail_accounts WHERE id=$1', [src.account_id])).rows[0] : null;
  if (!acc || !acc.active) return { reason: 'İletinin geldiği posta kutusu bağlı değil', issue: acc0.data };
  if (acc.status !== 'ok') return { reason: RECONNECT_MSG, issue: acc0.data };
  if (!providerConfigured(acc.provider)) return { reason: NOT_CONFIGURED, issue: acc0.data };
  const to = String(src.from_addr || '').trim().toLowerCase();
  if (!EMAIL_RE.test(to) || to.length > 200 || CRLF.test(to) || /[\0-\x1f\x7f]/.test(to)) return { reason: 'Talep edenin e-posta adresi geçersiz', issue: acc0.data };
  return { issue: acc0.data, src, acc, to };
}

export async function replyInfo(pool, me, issueId) {
  const x = await replyContext(pool, me, issueId);
  if (x.reason) return { available: false, reason: x.reason };
  return { available: true, to: x.to, subject: replySubject(x.src.subject || x.issue.summary, x.issue.key), provider: x.acc.provider };
}

const REPLY_FIELDS = new Set(['body', 'requestId']);
async function markReconnect(pool, acc) {
  const u = await pool.query(`UPDATE mail_accounts SET status='reconnect',
    last_error='Yeniden bağlanın: gönderme izni yok ya da bağlantının süresi doldu', updated_at=now()
    WHERE id=$1 AND status='ok' RETURNING id`, [acc.id]);
  if (u.rowCount) await notifyReconnect(pool, acc);
}
export async function sendReply(pool, me, issueId, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Geçersiz istek');
  if (Object.keys(b).some(k => !REPLY_FIELDS.has(k))) throw new HttpError(400, 'Alıcı, konu ve başlıklar sunucuda belirlenir; yalnız ileti metni gönderilir');
  const text = typeof b.body === 'string' ? b.body.replace(/\r\n?/g, '\n').trim() : '';
  if (!text) throw new HttpError(400, 'Yanıt metni gerekli');
  if (text.length > REPLY_BODY_MAX) throw new HttpError(400, `Yanıt en fazla ${REPLY_BODY_MAX.toLocaleString('tr-TR')} karakter`);
  if (/\0/.test(text)) throw new HttpError(400, 'Yanıt metni geçersiz karakter içeriyor');
  if (b.requestId !== undefined && (typeof b.requestId !== 'string' || !REQ_ID_RE.test(b.requestId))) throw new HttpError(400, 'Geçersiz istek kimliği');
  /* Denetim ile "gönderiliyor" kaydı arasında await yok: eşzamanlı aynı kimlikli iki istekten yalnız biri geçer. */
  let ik = null;
  if (b.requestId) {
    const now = Date.now();
    for (const [k, v] of replyIdem) if (now - v.at > REPLY_IDEM_MS) replyIdem.delete(k);
    ik = `${me.id}|${issueId}|${b.requestId}`;
    const prev = replyIdem.get(ik);
    if (prev) {
      if (prev.sig !== text) throw new HttpError(409, 'Bu istek kimliği başka bir metinle kullanıldı');
      if (prev.state !== 'sent') throw new HttpError(409, REPLY_PENDING_MSG);
      return { ...prev.result, duplicate: true };
    }
    if (replyIdem.size >= 10000) replyIdem.delete(replyIdem.keys().next().value);
    replyIdem.set(ik, { at: now, sig: text, state: 'pending', result: null });
  }
  let out;
  try { out = await deliverReply(pool, me, issueId, text); }
  catch (e) { if (ik) replyIdem.delete(ik); throw e; }
  const result = { ok: true, to: out.to, subject: out.subject, commentId: out.cid, recorded: false };
  if (ik) replyIdem.set(ik, { at: Date.now(), sig: text, state: 'sent', result });
  result.recorded = await recordReply(pool, me, issueId, text, out);
  return result;
}

async function deliverReply(pool, me, issueId, text) {
  const x = await replyContext(pool, me, issueId);
  if (x.reason) throw new HttpError(409, x.reason);
  const { src, acc, to, issue } = x;
  takeReplySlot(me.id, acc.id, issueId);
  const srcPid = validPid(src.provider_msg_id);
  const domain = String(acc.address).split('@')[1] || 'cevikpano.invalid';
  let subject = replySubject(src.subject || issue.summary, issue.key);
  const parent = validMid(src.message_id) && !/@cevikpano\.invalid>$/.test(src.message_id) ? src.message_id : '';
  let sentMid = `<cp.${randomUUID().replace(/-/g, '')}@${domain}>`, providerId = null;
  try {
    const token = await accessToken(pool, acc);
    if (acc.provider === 'google') {
      let threadId = src.thread_id || '', refs = [];
      if (srcPid) {
        try {
          const q = new URLSearchParams([['format', 'metadata'], ...['Subject', 'Message-ID', 'References'].map(h => ['metadataHeaders', h])]);
          const m = await call(`${GMAIL}/messages/${encodeURIComponent(srcPid)}?${q}`, { token });
          const p = parseGmail(m);
          threadId = threadId || p.threadId;
          refs = p.references.map(validMid).filter(Boolean);
          if (!src.subject && p.subject) subject = replySubject(p.subject, issue.key);
        } catch (e) { if (!(e instanceof ProviderError && e.status === 404)) throw e; }
      }
      const references = [...refs.filter(r => r !== parent), ...(parent ? [parent] : [])].slice(-20);
      const raw = Buffer.from(buildMime({ from: acc.address, to, subject, messageId: sentMid, inReplyTo: parent, references, body: text }), 'utf8').toString('base64url');
      const r = await call(`${GMAIL}/messages/send`, { method: 'POST', token, json: threadId ? { raw, threadId } : { raw } });
      providerId = typeof r.id === 'string' ? r.id.slice(0, 200) : null;
    } else {
      /* Graph: createReply zinciri (In-Reply-To/References) sağlayıcı kurar; kimlik taşınmışsa internetMessageId ile bulunur. */
      const create = id => call(`${GRAPH}/me/messages/${encodeURIComponent(id)}/createReply`, { method: 'POST', token, json: {} });
      let draft;
      try {
        if (!srcPid) throw new ProviderError(404, 'Geçersiz ileti kimliği');
        draft = await create(srcPid);
      }
      catch (e) {
        if (!(e instanceof ProviderError && (e.status === 404 || e.status === 400)) || !parent) throw e;
        const f = `internetMessageId eq '${parent.replace(/'/g, "''")}'`;
        const l = await call(`${GRAPH}/me/messages?$select=id&$top=1&$filter=${encodeURIComponent(f)}`, { token });
        const id = validPid(l.value?.[0]?.id);
        if (!id) throw new HttpError(409, 'Özgün ileti posta kutusunda bulunamadı (silinmiş ya da taşınmış olabilir)');
        draft = await create(id);
      }
      if (!validPid(draft?.id)) throw new ProviderError(502, 'Taslak oluşturulamadı');
      const did = encodeURIComponent(String(draft.id));
      try {
        await call(`${GRAPH}/me/messages/${did}`, { method: 'PATCH', token, json: {
          subject: assertHeader('Subject', subject), body: { contentType: 'text', content: text },
          toRecipients: [{ emailAddress: { address: assertHeader('To', to) } }], ccRecipients: [], bccRecipients: [] } });
        await call(`${GRAPH}/me/messages/${did}/send`, { method: 'POST', token });
      } catch (e) {
        await call(`${GRAPH}/me/messages/${did}`, { method: 'DELETE', token }).catch(() => {});
        throw e;
      }
      if (validMid(draft.internetMessageId)) sentMid = draft.internetMessageId;
      providerId = String(draft.id).slice(0, 200);
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof ReconnectError || (e instanceof ProviderError && (e.status === 401 || e.status === 403))) {
      await markReconnect(pool, acc).catch(() => {});
      throw new HttpError(409, RECONNECT_MSG);
    }
    if (e instanceof ProviderError && e.status === 404) throw new HttpError(409, 'Özgün ileti posta kutusunda bulunamadı (silinmiş ya da taşınmış olabilir)');
    console.error('[posta] yanıt gönderilemedi:', e instanceof ProviderError ? e.status : 'iç hata');
    throw new HttpError(424, e instanceof ProviderError && e.status === 429
      ? 'E-posta sağlayıcısı istek sınırına ulaştı; biraz sonra yeniden deneyin' : 'E-posta gönderilemedi (sağlayıcı hatası); biraz sonra yeniden deneyin');
  }
  return { to, subject, sentMid, providerId, acc, src, cid: 'c_' + randomUUID().replace(/-/g, '').slice(0, 16) };
}

/* Kayıt: giden ileti (yanıt gelirse aynı işe bağlanır), yorum + geçmiş (gönderen kullanıcı adına). */
async function recordReply(pool, me, issueId, text, { to, subject, sentMid, providerId, acc, src, cid }) {
  const now = Date.now();
  await pool.query(`INSERT INTO mail_messages (message_id, account_id, provider_msg_id, issue_id, comment_id, direction, from_addr, received_at, subject, thread_id)
    VALUES ($1,$2,$3,$4,$5,'out',$6,now(),$7,$8) ON CONFLICT (message_id) DO NOTHING`,
    [sentMid.slice(0, 300), acc.id, providerId, issueId, cid, String(acc.address).slice(0, 200), subject.slice(0, 500), src.thread_id || null]);
  const res = await applyChanges(pool, me, [
    { c: 'comments', id: cid, op: 'put', data: { issueId, userId: me.id, at: now,
      body: `✉ E-postayla yanıtlandı (${to}):\n\n${text}`, source: { kind: 'email', dir: 'out', to } } },
    { c: 'history', id: hid(), op: 'put', data: { issueId, userId: me.id, at: now, field: 'E-posta', from: '', to: `${to} · ${subject}`, kind: 'reply' } },
  ]);
  return !res.rejected?.length;
}

/* ---- yönetici uçları ---- */
const pubAccount = r => ({ id: r.id, provider: r.provider, address: r.address, defaultProjectId: r.default_project_id,
  active: r.active, status: r.status, lastPollAt: r.last_poll_at, lastError: r.last_error, backoffUntil: r.backoff_until,
  createdAt: r.created_at });
const pubRule = r => ({ id: r.id, ord: r.ord, accountId: r.account_id, toMatch: r.to_match || '', subjectContains: r.subject_contains || '',
  fromDomain: r.from_domain || '', projectId: r.project_id, assigneeId: r.assignee_id, active: r.active });

async function statusOf(pool, origin) {
  const accounts = (await pool.query('SELECT * FROM mail_accounts ORDER BY created_at')).rows.map(pubAccount);
  const rules = (await pool.query('SELECT * FROM mail_rules ORDER BY ord, created_at')).rows.map(pubRule);
  return { configured: mailConfigured(), providers: { google: providerConfigured('google'), microsoft: providerConfigured('microsoft') },
    polling: pollingEnabled(), pollSec: pollSec(),
    redirect: { google: redirectUri('google', origin), microsoft: redirectUri('microsoft', origin) }, accounts, rules };
}

const optText = (v, n, label) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.trim().length > n) throw new HttpError(400, `${label} en fazla ${n} karakter`);
  return v.trim() || null;
};

export function mailRoutes(app, pool, requireUser, requireAdmin) {
  const origin = req => `${req.protocol}://${req.get('host')}`;
  const admin = [requireUser, requireAdmin];
  const noStore = (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); };

  app.get('/api/mail/status', ...admin, noStore, async (req, res) => res.json(await statusOf(pool, origin(req))));

  /* Kart içinden e-postayla yanıt (madde 21): işe Üye/Yönetici rolüyle erişen; yönetici şartı yok. */
  app.get('/api/mail/reply/:issueId', requireUser, noStore, async (req, res) => res.json(await replyInfo(pool, req.user, req.params.issueId)));
  app.post('/api/mail/reply/:issueId', requireUser, async (req, res) => res.json(await sendReply(pool, req.user, req.params.issueId, req.body)));

  app.get('/api/mail/oauth/:provider/start', ...admin, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, await oauthStart(pool, req.user, req.params.provider, origin(req)));
  });
  /* Sağlayıcıdan dönüş: sonuç Sistem → Posta kutuları ekranında gösterilir (neden kodu; sağlayıcı metni yansıtılmaz). */
  app.get('/api/mail/oauth/:provider/callback', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const back = q => res.redirect(302, `/?posta=${q}#system`);
    if (!req.user || req.user.must_change) return back('hata&neden=oturum');
    if (!isAdminRole(req.user.role)) return back('hata&neden=yetki');
    try { await oauthCallback(pool, req.user, req.params.provider, req.query || {}, origin(req)); return back('bagli'); }
    catch (e) {
      if (e instanceof OAuthFail) return back('hata&neden=' + encodeURIComponent(e.reason));
      console.error('[posta] bağlantı tamamlanamadı:', e?.code || 'iç hata');
      return back('hata&neden=sunucu');
    }
  });

  app.post('/api/mail/accounts/:id', ...admin, async (req, res) => {
    const b = req.body || {};
    const acc = (await pool.query('SELECT * FROM mail_accounts WHERE id=$1', [req.params.id])).rows[0];
    if (!acc) throw new HttpError(404, 'Posta kutusu bulunamadı');
    let pid = acc.default_project_id, active = acc.active;
    if (b.defaultProjectId !== undefined) {
      pid = b.defaultProjectId || null;
      if (pid) {
        const t = (await pool.query(`SELECT data->>'template' AS t FROM projects WHERE id=$1`, [pid])).rows[0];
        if (!t) throw new HttpError(400, 'Proje bulunamadı');
        if (t.t !== 'talep') throw new HttpError(400, 'Varsayılan proje yalnız Talep şablonlu bir proje olabilir');
      }
    }
    if (b.active !== undefined) active = b.active === true;
    const r = await pool.query(`UPDATE mail_accounts SET default_project_id=$2, active=$3, updated_at=now() WHERE id=$1 RETURNING *`,
      [acc.id, pid, active]);
    res.json(pubAccount(r.rows[0]));
  });

  /* Bağlantıyı kes: jetonlar silinir (Google'da izin de geri alınır), kutunun kuralları silinir. */
  app.post('/api/mail/accounts/:id/delete', ...admin, async (req, res) => {
    const acc = (await pool.query('SELECT * FROM mail_accounts WHERE id=$1', [req.params.id])).rows[0];
    if (!acc) throw new HttpError(404, 'Posta kutusu bulunamadı');
    let revoked = false;
    const rt = decrypt(acc.refresh_token_enc);
    if (rt && acc.provider === 'google') {
      try { await call('https://oauth2.googleapis.com/revoke', { method: 'POST', form: { token: rt } }); revoked = true; } catch { revoked = false; }
    }
    await pool.query('UPDATE mail_messages SET account_id=NULL WHERE account_id=$1', [acc.id]);
    await pool.query('DELETE FROM mail_accounts WHERE id=$1', [acc.id]);
    res.json({ ok: true, revoked });
  });

  app.post('/api/mail/accounts/:id/poll', ...admin, async (req, res) => {
    if (!pollingEnabled()) throw new HttpError(409, mailConfigured() ? 'Çekme kapalı (sunucuda MAIL_ENABLED=true değil)' : NOT_CONFIGURED);
    const acc = (await pool.query('SELECT id FROM mail_accounts WHERE id=$1', [req.params.id])).rows[0];
    if (!acc) throw new HttpError(404, 'Posta kutusu bulunamadı');
    const r = await pollAccount(pool, acc.id);
    const a = (await pool.query('SELECT * FROM mail_accounts WHERE id=$1', [acc.id])).rows[0];
    res.json({ result: r, account: a ? pubAccount(a) : null });
  });

  /* Kurallar: listenin tamamı sırasıyla yazılır (sıra = dizideki yer). */
  app.post('/api/mail/rules', ...admin, async (req, res) => {
    const list = req.body?.rules;
    if (!Array.isArray(list) || list.length > 100) throw new HttpError(400, 'Kurallar en fazla 100 öğelik bir dizi olmalı');
    const rows = [];
    for (const [i, r] of list.entries()) {
      if (!r || typeof r !== 'object') throw new HttpError(400, 'Geçersiz kural');
      const id = r.id && validId(r.id) ? String(r.id) : 'mr_' + randomUUID().replace(/-/g, '').slice(0, 16);
      const pid = typeof r.projectId === 'string' ? r.projectId : '';
      if (!pid || !(await pool.query('SELECT 1 FROM projects WHERE id=$1', [pid])).rowCount) throw new HttpError(400, `Kural ${i + 1}: hedef proje bulunamadı`);
      const aid = r.assigneeId || null;
      if (aid && !(typeof aid === 'string' && (await pool.query('SELECT 1 FROM users WHERE id=$1 AND active AND NOT system', [aid])).rowCount))
        throw new HttpError(400, `Kural ${i + 1}: atanan kullanıcı bulunamadı ya da pasif`);
      const acc = r.accountId || null;
      if (acc && !(typeof acc === 'string' && (await pool.query('SELECT 1 FROM mail_accounts WHERE id=$1', [acc])).rowCount))
        throw new HttpError(400, `Kural ${i + 1}: posta kutusu bulunamadı`);
      rows.push([id, i, acc, optText(r.toMatch, 200, 'Alıcı'), optText(r.subjectContains, 200, 'Konu metni'),
        optText(r.fromDomain, 200, 'Gönderen alan adı'), pid, aid, r.active !== false]);
    }
    if (new Set(rows.map(r => r[0])).size !== rows.length) throw new HttpError(400, 'Kural kimlikleri tekrar ediyor');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM mail_rules');
      for (const r of rows) await c.query(`INSERT INTO mail_rules (id, ord, account_id, to_match, subject_contains, from_domain,
        project_id, assignee_id, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, r);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    res.json((await statusOf(pool, origin(req))).rules);
  });
}
