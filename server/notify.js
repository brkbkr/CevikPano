/* Uygulama içi bildirimler. Kayıt yazılırken aynı işlemde üretilir. */
import { visibleProjectIds, userSeesProject } from './store.js';
import { watchersOf } from './perms.js';

async function add(c, userId, kind, issueId, actorId, meta = {}) {
  if (!userId || userId === actorId) return;
  const u = await c.query('SELECT 1 FROM users WHERE id=$1 AND active', [userId]);
  if (!u.rowCount) return;
  /* Aynı kişi aynı işte 2 dakika içinde aynı türde bildirim aldıysa tekrarlama. */
  const dup = await c.query(
    `SELECT 1 FROM notifications WHERE user_id=$1 AND kind=$2 AND issue_id=$3 AND actor_id=$4
       AND read_at IS NULL AND created_at > now() - interval '2 minutes' AND kind <> 'comment' AND kind <> 'mention'`,
    [userId, kind, issueId, actorId]);
  if (dup.rowCount) return;
  await c.query(`INSERT INTO notifications (user_id, kind, issue_id, actor_id, meta) VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [userId, kind, issueId, actorId, JSON.stringify(meta)]);
}

/* Atama ve durum bildirimi de yalnız işin projesini görebilen kişiye (projeden çıkarılan raporlayıcıya üretilmez).
   İşi izle: durum, atanan, öncelik ve bitiş değişikliği izleyicilere (watchersOf: dizisi olmayan eski işte raporlayan +
   atanan) gider; yeni atanan "sana atadı" bildirimini alır, ayrıca "atanan değişti" almaz. Kendi değişikliği için yok. */
export async function notifyForIssue(c, me, data, cur) {
  const sees = async u => u !== me.id && await userSeesProject(c, u, data.projectId);
  if (data.assignee && (!cur || cur.assignee !== data.assignee) && await sees(data.assignee))
    await add(c, data.assignee, 'assigned', data.id, me.id);
  if (!cur) return;
  const ws = watchersOf(data);
  const to = async (kind, meta, skip) => { for (const u of ws) if (u !== skip && await sees(u)) await add(c, u, kind, data.id, me.id, meta); };
  if (cur.statusId !== data.statusId && data.statusId) {
    const st = (await c.query('SELECT name FROM statuses WHERE id=$1', [data.statusId])).rows[0];
    await to('status', { status: st?.name || '' });
  }
  if ((cur.assignee || null) !== (data.assignee || null)) {
    const nm = data.assignee ? (await c.query('SELECT name FROM users WHERE id=$1', [data.assignee])).rows[0]?.name : '';
    await to('reassigned', { to: String(nm || '').slice(0, 100) }, data.assignee);
  }
  if ((cur.priority ?? null) !== (data.priority ?? null)) await to('priority', { priority: data.priority ?? null });
  if ((cur.due || '') !== (data.due || '')) await to('due', { due: String(data.due || '').slice(0, 10) });
}

export async function notifyForComment(c, me, data) {
  const issue = (await c.query('SELECT data FROM issues WHERE id=$1', [data.issueId])).rows[0]?.data;
  if (!issue) return;
  const excerpt = String(data.body || '').replace(/\s+/g, ' ').slice(0, 140);
  const mentioned = new Set();
  for (const m of String(data.body || '').matchAll(/@([a-z0-9._-]{2,40})/gi)) {
    const u = (await c.query('SELECT id FROM users WHERE lower(username)=lower($1)', [m[1]])).rows[0];
    if (u) mentioned.add(u.id);
  }
  /* Yalnız işin alanına erişimi olan kişi bildirim alır (alandan çıkarılan / hiç erişimi olmayan @bahsetme almaz). */
  const sees = async u => u !== me.id && await userSeesProject(c, u, issue.projectId);
  for (const u of mentioned) if (await sees(u)) await add(c, u, 'mention', issue.id, me.id, { excerpt });
  for (const u of watchersOf(issue))
    if (!mentioned.has(u) && await sees(u)) await add(c, u, 'comment', issue.id, me.id, { excerpt });
}

/* me: oturumdaki kullanıcı. Erişimi olmayan (alandan çıkarılmış ya da hiç erişimi olmayan) işin bildirimi kalır ama
   anahtar, başlık, proje ve meta (yorum özeti, durum) boş döner (okuma süzmesi 18 ile aynı kural). */
export async function listNotifications(pool, me, limit = 50) {
  const userId = me.id;
  const { rows } = await pool.query(
    `SELECT n.id, n.kind, n.issue_id, n.actor_id, n.meta, n.created_at, n.read_at,
            i.issue_key, i.summary, i.project_id, a.name AS actor_name
       FROM notifications n
       LEFT JOIN issues i ON i.id = n.issue_id
       LEFT JOIN users a ON a.id = n.actor_id
      WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT $2`, [userId, limit]);
  const seen = await visibleProjectIds(pool, me);
  if (seen) for (const r of rows) if (r.issue_id && !seen.has(r.project_id)) {
    r.issue_key = ''; r.summary = ''; r.project_id = null; r.meta = {};
  }
  return rows;
}

export async function unreadCount(pool, userId) {
  return Number((await pool.query(
    'SELECT count(*) AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [userId])).rows[0].n);
}

export async function markRead(pool, userId, ids) {
  if (ids === 'all') await pool.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [userId]);
  else if (Array.isArray(ids) && ids.length)
    await pool.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND id = ANY($2::bigint[]) AND read_at IS NULL',
      [userId, ids.map(Number).filter(Number.isFinite)]);
}
