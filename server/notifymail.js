/* E-posta bildirimleri ve sabah özeti (PO önerisi: "E-posta bildirimleri ve sabah özeti").
   Bağımlılık yok: gönderim Sistem → Posta kutuları'nda "Bildirim gönderici" seçilen bağlı kutudan (mail.js → sendSystemMail).

   Akış:
   - Uygulama içi bildirim üretilirken (notify.js → add, aynı işlem) kişinin e-posta tercihi açıksa olay kuyruğa yazılır
     (mail_notify_queue). Özellik kapalıysa (MAIL_ENABLED=true değil, sağlayıcı yapılandırılmamış ya da gönderici kutu yok)
     kuyruğa hiç yazılmaz: sessizce kapalı.
   - Zamanlayıcı (dakikada bir) kişi başına bekleyen olayları birleştirip TEK e-posta gönderir: son olaydan sonra 2 dk sessizlik
     ya da ilk olaydan bu yana 10 dk (toplama penceresi). Hız sınırı: kişi başına saatte 6, gönderici kutudan saatte 200 e-posta;
     sınır doluysa olaylar bekler (sonraki e-postada birleşir), 24 saatten eski bekleyen olay düşer.
   - Gönderim anında her olay yeniden denetlenir: kişi etkin, e-posta adresi geçerli, tercih hâlâ açık, iş var ve kişi işin
     projesini görüyor (userSeesProject: okuma süzmesiyle aynı kural). Tutmayan olay e-postaya girmez ("dropped").
   - Bitiş hatırlatması: iş günü 08:30'dan (İstanbul) sonra, atanana; bitişi bir sonraki iş gününe kadar olan (yaklaşıyor) ve
     son 7 günde geçmiş (geçti) açık işler. Aynı iş ve aynı bitiş tarihi için kişiye bir kez (tekil dizin).
   - Sabah özeti: her iş günü (Pzt-Cum; resmî tatiller dikkate alınmaz) 08:30-12:00 (İstanbul) arasında, kişi başına günde bir:
     bugün bitecek, geciken ve son 24 saatte atanan açık işler. Boşsa e-posta gitmez.

   Tek süreç varsayımı: zamanlayıcı her sunucu sürecinde setInterval ile çalışır; birden çok süreç açılırsa danışma kilidi
   (pg_try_advisory_lock) aynı anda yalnız birinin tur atmasını sağlar, sabah özeti de (kişi, gün) tekil dizinle bir kez gider.

   Güvenlik: alıcı yalnız kişinin kendi hesabındaki adres; konu ve gönderen başlıkları tek satıra indirilir ve assertHeader'dan
   geçer (başlık enjeksiyonu yok); HTML gövdede tüm kullanıcı metni kaçışlı (h); bağlantı yalnız PUBLIC_URL + iş anahtarı.
   İçerik: iş anahtarı, özet, olayın türü, yapan kişinin adı ve (yorum/bahsetmede) en fazla 140 karakterlik yorum özeti. */
import { pollingEnabled, providerConfigured, sendSystemMail, validMailAddress } from './mail.js';
import { userSeesProject, visibleProjectIds } from './store.js';
import { HttpError } from './util.js';

export const NOTIFY_PREF_KEYS = ['assigned', 'comment', 'mention', 'status', 'due', 'digest'];
export const NOTIFY_DEFAULTS = { assigned: true, comment: false, mention: true, status: false, due: false, digest: false };
const KIND_PREF = { assigned: 'assigned', comment: 'comment', mention: 'mention', status: 'status', due_soon: 'due', overdue: 'due' };
export const NOTIFY_LIMITS = {
  quietMs: 2 * 60e3,           // son olaydan sonra bu kadar sessizlik olunca gönder
  maxWaitMs: 10 * 60e3,        // ilk olaydan sonra en geç (toplama penceresi)
  userHourly: 6,               // kişi başına saatte en fazla olay e-postası
  senderHourly: 200,           // gönderici kutudan saatte en fazla e-posta (özet dahil)
  maxAgeMs: 24 * 3600e3,       // daha eski bekleyen olay gönderilmez
  perMail: 25,                 // bir e-postada en fazla olay (fazlası "ve N bildirim daha")
  failBackoffMs: 5 * 60e3,     // sağlayıcı hatasında tüm gönderim bu kadar bekler
};
const DIGEST_FROM = 8 * 60 + 30, DIGEST_TO = 12 * 60;    // İstanbul saati, dakika
const OVERDUE_DAYS = 7;
let BACKOFF_UNTIL = 0, DUE_DAY = '';
export function resetNotifyMail() { BACKOFF_UNTIL = 0; DUE_DAY = ''; }

/* ---- zaman (İstanbul) ---- */
const FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function istanbul(d) {
  const p = Object.fromEntries(FMT.formatToParts(d).map(x => [x.type, x.value]));
  const wd = WD.indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), wd, workday: wd >= 1 && wd <= 5 };
}
const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const ISO_D = /^\d{4}-\d{2}-\d{2}$/;
const trDate = iso => (ISO_D.test(String(iso || '')) ? new Date(iso + 'T00:00:00Z').toLocaleDateString('tr-TR',
  { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }) : '');

/* ---- tercihler (user_prefs.data.notif; istemcideki DB'ye girmez, PREF_KEYS dışında) ---- */
export async function prefsOf(db, userId) {
  const n = (await db.query(`SELECT data->'notif' AS n FROM user_prefs WHERE user_id=$1`, [userId])).rows[0]?.n;
  const out = {};
  for (const k of NOTIFY_PREF_KEYS) out[k] = typeof n?.[k] === 'boolean' ? n[k] : NOTIFY_DEFAULTS[k];
  return out;
}
export function validatePrefs(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Geçersiz tercih');
  const extra = Object.keys(b).filter(k => !NOTIFY_PREF_KEYS.includes(k));
  if (extra.length) throw new HttpError(400, 'Bilinmeyen bildirim türü');
  const out = {};
  for (const k of NOTIFY_PREF_KEYS) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== 'boolean') throw new HttpError(400, 'Tercihler açık/kapalı (true/false) olmalı');
    out[k] = b[k];
  }
  return out;
}
async function savePrefs(pool, userId, patch) {
  const cur = await prefsOf(pool, userId);
  await pool.query(`INSERT INTO user_prefs (user_id, data) VALUES ($1, jsonb_build_object('notif', $2::jsonb))
     ON CONFLICT (user_id) DO UPDATE SET data = user_prefs.data || jsonb_build_object('notif', $2::jsonb), updated_at = now()`,
  [userId, JSON.stringify({ ...cur, ...patch })]);
}

/* ---- gönderici kutu ---- */
export async function senderOf(db) {
  if (!pollingEnabled()) return null;
  const a = (await db.query(`SELECT * FROM mail_accounts WHERE notify_sender AND active AND status='ok' LIMIT 1`)).rows[0];
  return a && providerConfigured(a.provider) ? a : null;
}
const emailOf = u => String(u?.data?.email || '').trim();
/* Kişinin göreceği durum (tercih ekranı). Gönderici adresi kullanıcıya gösterilmez. */
async function prefsView(pool, me) {
  const prefs = await prefsOf(pool, me.id);
  const email = emailOf(me);
  let reason = '';
  if (!pollingEnabled()) reason = 'off';
  else if (!(await senderOf(pool))) reason = 'nosender';
  else if (!validMailAddress(email)) reason = 'noemail';
  return { prefs, email: validMailAddress(email) ? email : '', available: !reason, reason };
}

/* ---- kuyruğa yazma (notify.js → add; aynı işlem) ---- */
export async function enqueueNotifyMail(c, userId, kind, issueId, actorId, meta = {}) {
  if (!KIND_PREF[kind] || !userId || !(await senderOf(c))) return false;
  if (!(await prefsOf(c, userId))[KIND_PREF[kind]]) return false;
  await c.query(`INSERT INTO mail_notify_queue (user_id, kind, issue_id, actor_id, meta) VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [userId, kind, issueId || null, actorId || null, JSON.stringify(meta || {})]);
  return true;
}

/* ---- içerik ---- */
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oneLine = (s, n) => {
  const t = String(s ?? '').replace(/[\0-\x1f\x7f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
export function appUrl() {
  const u = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(u) ? u : '';
}
const issueUrl = key => (appUrl() && key ? `${appUrl()}/?is=${encodeURIComponent(key)}` : '');
const KIND_SHORT = { assigned: 'Size atandı', comment: 'Yeni yorum', mention: 'Sizden bahsedildi', status: 'Durum değişti',
  due_soon: 'Bitiş yaklaşıyor', overdue: 'Bitiş tarihi geçti' };
function eventLine(it, actor) {
  const a = oneLine(actor || 'Biri', 80), m = it.meta || {};
  switch (it.kind) {
    case 'assigned': return `${a} işi size atadı`;
    case 'comment': return `${a} yorum yazdı`;
    case 'mention': return `${a} bir yorumda sizden bahsetti`;
    case 'status': return `${a} durumu “${oneLine(m.status, 60) || '—'}” yaptı`;
    case 'due_soon': return `Bitiş tarihi yaklaşıyor: ${trDate(m.due)}`;
    case 'overdue': return `Bitiş tarihi geçti: ${trDate(m.due)}`;
    default: return 'Bildirim';
  }
}
const FOOT_T = 'Bu e-postaları ÇevikPano\'da hesap menüsü → Bildirimler bölümünden açıp kapatabilirsiniz.';
function wrapHtml(title, inner) {
  const base = appUrl();
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${h(title)}</title></head>
<body style="margin:0;padding:16px;background:#f5f6f8;font-family:Segoe UI,Arial,sans-serif;color:#1f2937;font-size:14px">
<div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:18px 20px">
<div style="font-weight:700;font-size:15px;margin-bottom:12px">${h(title)}</div>
${inner}
<p style="margin:18px 0 0;color:#6b7280;font-size:12px">${h(FOOT_T)}${base ? ` <a href="${h(base + '/')}" style="color:#4f46e5">ÇevikPano'yu açın</a>` : ''}</p>
</div></body></html>`;
}
function issueBlockHtml(iss, lines) {
  const url = issueUrl(iss.issue_key);
  const head = `<b>${h(iss.issue_key || '')}</b> · ${h(oneLine(iss.summary, 200))}`;
  return `<div style="border-top:1px solid #eef0f3;padding:10px 0">
<div>${url ? `<a href="${h(url)}" style="color:#1f2937;text-decoration:none">${head}</a>` : head}</div>
<ul style="margin:6px 0 0;padding-left:18px;color:#374151">${lines.map(l => `<li>${h(l.t)}${l.x ? `<div style="color:#6b7280;margin-top:2px">“${h(l.x)}”</div>` : ''}</li>`).join('')}</ul>
${url ? `<div style="margin-top:6px"><a href="${h(url)}" style="color:#4f46e5;font-size:13px">İşi aç</a></div>` : ''}</div>`;
}
function issueBlockText(iss, lines) {
  const url = issueUrl(iss.issue_key);
  return `${iss.issue_key || ''} · ${oneLine(iss.summary, 200)}\n${lines.map(l => `  • ${l.t}${l.x ? `\n    “${l.x}”` : ''}`).join('\n')}${url ? `\n  ${url}` : ''}`;
}
/* Olay e-postası: işe göre gruplanır. */
export function composeEvents(entries, extra = 0) {
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.iss.id)) groups.set(e.iss.id, { iss: e.iss, lines: [] });
    const x = ['comment', 'mention'].includes(e.it.kind) ? oneLine(e.it.meta?.excerpt, 140) : '';
    groups.get(e.iss.id).lines.push({ t: eventLine(e.it, e.actor), x });
  }
  const n = entries.length + extra, first = entries[0];
  const subject = n === 1
    ? `[${oneLine(first.iss.issue_key, 30)}] ${KIND_SHORT[first.it.kind] || 'Bildirim'}: ${oneLine(first.iss.summary, 80)}`
    : `ÇevikPano: ${n} yeni bildirim`;
  const title = n === 1 ? 'ÇevikPano bildirimi' : `ÇevikPano: ${n} yeni bildirim`;
  const more = extra ? `ve ${extra} bildirim daha (uygulamada görebilirsiniz)` : '';
  const G = [...groups.values()];
  const html = wrapHtml(title, G.map(g => issueBlockHtml(g.iss, g.lines)).join('\n')
    + (more ? `<p style="color:#6b7280">${h(more)}</p>` : ''));
  const text = `${title}\n\n${G.map(g => issueBlockText(g.iss, g.lines)).join('\n\n')}${more ? `\n\n${more}` : ''}\n\n${FOOT_T}${appUrl() ? `\n${appUrl()}/` : ''}\n`;
  return { subject: oneLine(subject, 180), text, html };
}
export function composeDigest(day, sec) {
  const label = trDate(day);
  const parts = [['today', 'Bugün bitecek'], ['late', 'Geciken'], ['fresh', 'Yeni atanan (son 24 saat)']].filter(([k]) => sec[k].length);
  const row = (i, k) => (k === 'late' ? `bitiş ${trDate(i.due)}` : k === 'today' ? 'bitiş bugün' : '');
  const li = (i, k) => {
    const url = issueUrl(i.issue_key), head = `<b>${h(i.issue_key || '')}</b> · ${h(oneLine(i.summary, 200))}`;
    return `<li style="margin:4px 0">${url ? `<a href="${h(url)}" style="color:#1f2937;text-decoration:none">${head}</a>` : head}${row(i, k) ? ` <span style="color:#6b7280">(${h(row(i, k))})</span>` : ''}</li>`;
  };
  const html = wrapHtml(`Sabah özeti — ${label}`, parts.map(([k, t]) => `<div style="margin-top:10px"><div style="font-weight:600">${h(t)} (${sec[k].length})</div>
<ul style="margin:6px 0 0;padding-left:18px">${sec[k].map(i => li(i, k)).join('')}</ul></div>`).join('\n'));
  const text = `Sabah özeti — ${label}\n\n${parts.map(([k, t]) => `${t} (${sec[k].length})\n${sec[k].map(i =>
    `  • ${i.issue_key || ''} · ${oneLine(i.summary, 200)}${row(i, k) ? ` (${row(i, k)})` : ''}${issueUrl(i.issue_key) ? `\n    ${issueUrl(i.issue_key)}` : ''}`).join('\n')}`).join('\n\n')}\n\n${FOOT_T}\n`;
  const cnt = [sec.today.length && `${sec.today.length} bugün`, sec.late.length && `${sec.late.length} geciken`, sec.fresh.length && `${sec.fresh.length} yeni`].filter(Boolean).join(', ');
  return { subject: oneLine(`ÇevikPano sabah özeti — ${label}: ${cnt}`, 180), text, html };
}

/* ---- sayım ve gönderim ---- */
const senderHour = async (db, now) => Number((await db.query(
  `SELECT count(*) AS n FROM mail_notify_sent WHERE sent AND created_at > $1`, [new Date(now - 3600e3)])).rows[0].n);
const userHour = async (db, uid, now) => Number((await db.query(
  `SELECT count(*) AS n FROM mail_notify_sent WHERE sent AND kind='events' AND user_id=$1 AND created_at > $2`, [uid, new Date(now - 3600e3)])).rows[0].n);
const isDone = async (db, statusId) => (await db.query(`SELECT category FROM statuses WHERE id=$1`, [statusId])).rows[0]?.category === 'done';
function failed(r, now, log) {
  BACKOFF_UNTIL = now.getTime() + Math.max(NOTIFY_LIMITS.failBackoffMs, (r.retryAfter || 0) * 1000);
  log(`[bildirim] e-posta gönderilemedi (${r.error}); gönderim bekletildi`);
}

async function flushUser(pool, acc, uid, now, log) {
  const items = (await pool.query(`SELECT * FROM mail_notify_queue WHERE user_id=$1 AND status='pending' ORDER BY id`, [uid])).rows;
  if (!items.length) return {};
  const u = (await pool.query('SELECT * FROM users WHERE id=$1', [uid])).rows[0];
  const to = emailOf(u);
  const prefs = await prefsOf(pool, uid);
  const keep = [], drop = [];
  for (const it of items) {
    if (!u || !u.active || u.system || !validMailAddress(to) || !prefs[KIND_PREF[it.kind]]) { drop.push(it.id); continue; }
    const iss = it.issue_id ? (await pool.query(`SELECT id, issue_key, summary, project_id, assignee_id, status_id, due FROM issues WHERE id=$1`,
      [it.issue_id])).rows[0] : null;
    if (!iss || !(await userSeesProject(pool, uid, iss.project_id))) { drop.push(it.id); continue; }
    if ((it.kind === 'due_soon' || it.kind === 'overdue')
        && (iss.assignee_id !== uid || iss.due !== it.meta?.due || await isDone(pool, iss.status_id))) { drop.push(it.id); continue; }
    keep.push(it);
  }
  if (drop.length) await pool.query(`UPDATE mail_notify_queue SET status='dropped' WHERE id = ANY($1) AND status='pending'`, [drop]);
  if (!keep.length) return { dropped: drop.length };
  if (await userHour(pool, uid, now) >= NOTIFY_LIMITS.userHourly) return { dropped: drop.length, deferred: true };
  const shown = keep.slice(-NOTIFY_LIMITS.perMail);
  const entries = [];
  for (const it of shown) {
    const iss = (await pool.query(`SELECT id, issue_key, summary FROM issues WHERE id=$1`, [it.issue_id])).rows[0];
    const actor = it.actor_id ? (await pool.query('SELECT name FROM users WHERE id=$1', [it.actor_id])).rows[0]?.name : '';
    if (iss) entries.push({ it, iss, actor });             // bu arada silinen iş e-postaya girmez
  }
  if (!entries.length) return { dropped: drop.length };
  const mail = composeEvents(entries, keep.length - shown.length);
  const r = await sendSystemMail(pool, acc, { to, ...mail });
  if (!r.ok) { failed(r, now, log); return { dropped: drop.length, error: r.error }; }
  await pool.query(`UPDATE mail_notify_queue SET status='sent', sent_at=$2 WHERE id = ANY($1)`, [keep.map(x => x.id), now]);
  await pool.query(`INSERT INTO mail_notify_sent (user_id, kind, items, created_at) VALUES ($1,'events',$2,$3)`, [uid, keep.length, now]);
  return { sent: 1, dropped: drop.length };
}

/* Bekleyen olayları gönder. now: testte ileri alınabilir. */
export async function flushNotifyMail(pool, { now = new Date(), log = () => {} } = {}) {
  const out = { sent: 0, dropped: 0, deferred: 0 };
  out.dropped += (await pool.query(`UPDATE mail_notify_queue SET status='dropped' WHERE status='pending' AND created_at < $1`,
    [new Date(now - NOTIFY_LIMITS.maxAgeMs)])).rowCount;
  const acc = await senderOf(pool);
  if (!acc) return { ...out, off: true };
  if (now.getTime() < BACKOFF_UNTIL) return { ...out, backoff: true };
  const users = (await pool.query(`SELECT user_id FROM mail_notify_queue WHERE status='pending' GROUP BY user_id
      HAVING min(created_at) <= $1 OR max(created_at) <= $2 ORDER BY min(created_at)`,
  [new Date(now - NOTIFY_LIMITS.maxWaitMs), new Date(now - NOTIFY_LIMITS.quietMs)])).rows.map(r => r.user_id);
  for (const uid of users) {
    if (await senderHour(pool, now) >= NOTIFY_LIMITS.senderHourly) { out.deferred++; break; }
    const r = await flushUser(pool, acc, uid, now, log);
    out.sent += r.sent || 0; out.dropped += r.dropped || 0; if (r.deferred) out.deferred++;
    if (r.error) { out.error = r.error; break; }
  }
  return out;
}

/* Bitiş hatırlatmaları: iş günü 08:30'dan sonra günde bir tarama (tekil dizin tekrar göndermeyi önler). */
export async function scanDue(pool, { now = new Date() } = {}) {
  const L = istanbul(now);
  if (!L.workday || L.minutes < DIGEST_FROM || DUE_DAY === L.date) return { skipped: true };
  if (!(await senderOf(pool))) return { off: true };
  DUE_DAY = L.date;
  const soonEnd = addDays(L.date, L.wd === 5 ? 3 : 1), lateFrom = addDays(L.date, -OVERDUE_DAYS);
  const rows = (await pool.query(`SELECT i.id, i.assignee_id, i.project_id, i.due FROM issues i
      JOIN users u ON u.id = i.assignee_id AND u.active AND NOT u.system
      LEFT JOIN statuses s ON s.id = i.status_id
      LEFT JOIN projects p ON p.id = i.project_id
     WHERE i.due ~ '^\\d{4}-\\d{2}-\\d{2}$' AND i.due <> $1 AND i.due >= $2 AND i.due <= $3
       AND coalesce(s.category, '') <> 'done' AND coalesce(p.data->>'archived', '') <> 'true'
     ORDER BY i.due LIMIT 5000`, [L.date, lateFrom, soonEnd])).rows;
  let n = 0;
  const pref = new Map();
  for (const r of rows) {
    if (!pref.has(r.assignee_id)) pref.set(r.assignee_id, (await prefsOf(pool, r.assignee_id)).due);
    if (!pref.get(r.assignee_id) || !(await userSeesProject(pool, r.assignee_id, r.project_id))) continue;
    const kind = r.due > L.date ? 'due_soon' : 'overdue';
    n += (await pool.query(`INSERT INTO mail_notify_queue (user_id, kind, issue_id, meta, created_at) VALUES ($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT DO NOTHING`, [r.assignee_id, kind, r.id, JSON.stringify({ due: r.due }), now])).rowCount;
  }
  return { queued: n };
}

/* Sabah özeti. */
export async function runDigest(pool, { now = new Date(), log = () => {} } = {}) {
  const L = istanbul(now);
  if (!L.workday || L.minutes < DIGEST_FROM || L.minutes >= DIGEST_TO) return { skipped: true };
  const acc = await senderOf(pool);
  if (!acc) return { off: true };
  if (now.getTime() < BACKOFF_UNTIL) return { backoff: true };
  const users = (await pool.query(`SELECT u.* FROM users u JOIN user_prefs p ON p.user_id = u.id
     WHERE u.active AND NOT u.system AND p.data->'notif'->'digest' = 'true'::jsonb
       AND NOT EXISTS (SELECT 1 FROM mail_notify_sent s WHERE s.user_id = u.id AND s.kind = 'digest' AND s.day = $1)
     ORDER BY u.ord`, [L.date])).rows;
  const out = { sent: 0, empty: 0 };
  for (const u of users) {
    const to = emailOf(u);
    if (!validMailAddress(to)) continue;
    if (await senderHour(pool, now) >= NOTIFY_LIMITS.senderHourly) { out.deferred = true; break; }
    const claim = await pool.query(`INSERT INTO mail_notify_sent (user_id, kind, day, items, sent, created_at) VALUES ($1,'digest',$2,0,false,$3)
      ON CONFLICT DO NOTHING RETURNING id`, [u.id, L.date, now]);
    if (!claim.rowCount) continue;
    const seen = await visibleProjectIds(pool, u);
    const vis = r => !seen || seen.has(r.project_id);
    const open = (await pool.query(`SELECT i.id, i.issue_key, i.summary, i.project_id, i.due FROM issues i
        LEFT JOIN statuses s ON s.id = i.status_id LEFT JOIN projects p ON p.id = i.project_id
       WHERE i.assignee_id = $1 AND i.due ~ '^\\d{4}-\\d{2}-\\d{2}$' AND i.due <= $2
         AND coalesce(s.category, '') <> 'done' AND coalesce(p.data->>'archived', '') <> 'true'
       ORDER BY i.due, i.issue_key LIMIT 200`, [u.id, L.date])).rows.filter(vis);
    const fresh = (await pool.query(`SELECT DISTINCT ON (i.id) i.id, i.issue_key, i.summary, i.project_id, i.due FROM notifications n
        JOIN issues i ON i.id = n.issue_id LEFT JOIN statuses s ON s.id = i.status_id LEFT JOIN projects p ON p.id = i.project_id
       WHERE n.user_id = $1 AND n.kind = 'assigned' AND n.created_at > $2 AND i.assignee_id = $1
         AND coalesce(s.category, '') <> 'done' AND coalesce(p.data->>'archived', '') <> 'true'
       ORDER BY i.id LIMIT 100`, [u.id, new Date(now - 24 * 3600e3)])).rows.filter(vis);
    const sec = { today: open.filter(i => i.due === L.date), late: open.filter(i => i.due < L.date), fresh };
    const items = sec.today.length + sec.late.length + sec.fresh.length;
    if (!items) { out.empty++; continue; }
    const r = await sendSystemMail(pool, acc, { to, ...composeDigest(L.date, sec) });
    if (!r.ok) { await pool.query('DELETE FROM mail_notify_sent WHERE id=$1', [claim.rows[0].id]); failed(r, now, log); out.error = r.error; break; }
    await pool.query('UPDATE mail_notify_sent SET sent=true, items=$2 WHERE id=$1', [claim.rows[0].id, items]);
    out.sent++;
  }
  return out;
}

async function purge(pool, now) {
  const old = new Date(now - 30 * 24 * 3600e3);
  await pool.query(`DELETE FROM mail_notify_queue WHERE status <> 'pending' AND created_at < $1`, [old]);
  await pool.query(`DELETE FROM mail_notify_sent WHERE created_at < $1`, [old]);
}

export async function notifyTick(pool, { now = new Date(), log = () => {} } = {}) {
  const due = await scanDue(pool, { now });
  const events = await flushNotifyMail(pool, { now, log });
  const digest = await runDigest(pool, { now, log });
  await purge(pool, now);
  return { due, events, digest };
}

/* Zamanlayıcı: dakikada bir (tek süreç varsayımı; çok süreçte danışma kilidi). */
export function startNotifyMailer(pool, log = console.log) {
  let running = false;
  const run = async () => {
    if (running || !pollingEnabled()) return;
    running = true;
    let c = null, locked = false;
    try {
      c = await pool.connect();
      locked = (await c.query('SELECT pg_try_advisory_lock(727291) AS ok')).rows[0].ok;
      if (locked) await notifyTick(pool, { log });
    } catch (e) { log('[bildirim] tur başarısız: ' + (e.code || e.message)); }
    finally {
      if (locked) await c.query('SELECT pg_advisory_unlock(727291)').catch(() => {});
      c?.release(); running = false;
    }
  };
  setTimeout(run, 20e3).unref();
  setInterval(run, 60e3).unref();
}

export function notifyMailRoutes(app, pool, requireUser) {
  app.get('/api/notify/prefs', requireUser, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await prefsView(pool, req.user));
  });
  app.post('/api/notify/prefs', requireUser, async (req, res) => {
    const patch = validatePrefs(req.body);
    await savePrefs(pool, req.user.id, patch);
    /* Kapatılan türün bekleyen olayları hemen düşer (gönderimde de yeniden denetlenir). */
    const off = Object.entries(KIND_PREF).filter(([, p]) => patch[p] === false).map(([k]) => k);
    if (off.length) await pool.query(`UPDATE mail_notify_queue SET status='dropped' WHERE user_id=$1 AND status='pending' AND kind = ANY($2)`,
      [req.user.id, off]);
    res.json(await prefsView(pool, req.user));
  });
}
