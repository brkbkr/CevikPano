/* Uygulama içi bildirimler. Kayıt yazılırken aynı işlemde üretilir. */

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

export async function notifyForIssue(c, me, data, cur) {
  if (data.assignee && (!cur || cur.assignee !== data.assignee))
    await add(c, data.assignee, 'assigned', data.id, me.id);
  if (cur && cur.statusId !== data.statusId && data.statusId) {
    const st = (await c.query('SELECT name FROM statuses WHERE id=$1', [data.statusId])).rows[0];
    const to = new Set([data.reporter, data.assignee].filter(Boolean));
    for (const u of to) await add(c, u, 'status', data.id, me.id, { status: st?.name || '' });
  }
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
  for (const u of mentioned) await add(c, u, 'mention', issue.id, me.id, { excerpt });
  for (const u of new Set([issue.assignee, issue.reporter].filter(Boolean)))
    if (!mentioned.has(u)) await add(c, u, 'comment', issue.id, me.id, { excerpt });
}

export async function listNotifications(pool, userId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT n.id, n.kind, n.issue_id, n.actor_id, n.meta, n.created_at, n.read_at,
            i.issue_key, i.summary, i.project_id, a.name AS actor_name
       FROM notifications n
       LEFT JOIN issues i ON i.id = n.issue_id
       LEFT JOIN users a ON a.id = n.actor_id
      WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT $2`, [userId, limit]);
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
