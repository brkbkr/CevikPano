import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRoutes, requireUser, meOf } from './auth.js';
import { readState, readChanges, applyChanges, addContact, HttpError } from './store.js';
import { listNotifications, unreadCount, markRead } from './notify.js';
import { createSnapshot, listSnapshots, getSnapshot, replaceAll, listTrash, restoreTrash, activity } from './backup.js';
import { isAdminRole } from './util.js';
import { mailRoutes } from './mail.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');

/* Express 4 async hataları yakalamaz; tüm işleyicileri sar. */
function asyncSafe(app) {
  for (const m of ['get', 'post', 'put', 'delete', 'use']) {
    const orig = app[m].bind(app);
    app[m] = (...args) => {
      if (m === 'get' && args.length === 1) return orig(...args);       // app.get('ayar')
      return orig(...args.map(a => typeof a === 'function' && a.length < 4
        ? (req, res, next) => { try { const r = a(req, res, next); if (r?.catch) r.catch(next); } catch (e) { next(e); } }
        : a));
    };
  }
}

export function createApp(pool) {
  const app = express();
  asyncSafe(app);
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/healthz', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  /* Sürüm ve ortam bilgisi (oturum gerekmez; gizli bilgi içermez). Test ortamı canlının
     sürümünü buradan okuyup karşılaştırır, bu yüzden başka kökenden okunabilir. */
  const VERSION = {
    env: process.env.APP_ENV || 'development',
    commit: String(process.env.APP_COMMIT || '').slice(0, 40),
    commitDate: process.env.APP_COMMIT_DATE || '',
    commitMessage: String(process.env.APP_COMMIT_MSG || '').slice(0, 200),
    startedAt: new Date().toISOString(),
    publicUrl: process.env.PUBLIC_URL || '',
    peerUrl: process.env.PEER_URL || '',
    repo: process.env.GITHUB_REPO || '',
  };
  app.get('/api/version', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.json(VERSION);
  });

  app.use('/api', express.json({ limit: '25mb' }));

  /* CSRF: değişiklik yapan her API isteği özel başlık taşımalı. Tarayıcılar
     başka bir siteden bu başlıkla istek atamaz (CORS ön kontrolü gerekir). */
  app.use('/api', (req, _res, next) => {
    if (req.method !== 'GET' && req.headers['x-pano'] !== '1') return next(new HttpError(403, 'Geçersiz istek kaynağı'));
    next();
  });

  authRoutes(app, pool);

  app.get('/api/state', requireUser, async (req, res) => {
    const st = await readState(pool, req.user);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...st, me: meOf(req.user) });
  });

  /* Kim çevrim içi: son 30 sn'de değişiklik soran kullanıcılar (bellekte tutulur). */
  const presence = new Map();
  const online = () => {
    const now = Date.now(), out = [];
    for (const [id, p] of presence) { if (now - p.at < 30e3) out.push({ id, view: p.view, issue: p.issue }); else presence.delete(id); }
    return out;
  };

  app.get('/api/changes', requireUser, async (req, res) => {
    const since = Math.max(0, Number(req.query.since) || 0);
    presence.set(req.user.id, { at: Date.now(), view: String(req.query.view || '').slice(0, 30),
      issue: String(req.query.issue || '').slice(0, 200) });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...(await readChanges(pool, since, req.user)), unread: await unreadCount(pool, req.user.id), online: online() });
  });

  app.get('/api/notifications', requireUser, async (req, res) => {
    res.json({ items: await listNotifications(pool, req.user.id), unread: await unreadCount(pool, req.user.id) });
  });
  app.post('/api/notifications/read', requireUser, async (req, res) => {
    await markRead(pool, req.user.id, req.body?.ids === 'all' ? 'all' : req.body?.ids);
    res.json({ unread: await unreadCount(pool, req.user.id) });
  });

  /* ---- yönetici araçları ---- */
  const requireAdmin = (req, _res, next) => next(isAdminRole(req.user?.role) ? undefined : new HttpError(403, 'Yalnızca yöneticiler'));

  app.post('/api/import', requireUser, requireAdmin, async (req, res) => {
    res.json(await replaceAll(pool, req.user, req.body?.data, 'import'));
  });
  app.get('/api/backups', requireUser, requireAdmin, async (_req, res) => res.json(await listSnapshots(pool)));
  app.post('/api/backups', requireUser, requireAdmin, async (req, res) => {
    res.json(await createSnapshot(pool, 'manual', req.user.id, String(req.body?.label || 'Elle alınan yedek').slice(0, 200)));
  });
  app.get('/api/backups/:id', requireUser, requireAdmin, async (req, res) => {
    const s = await getSnapshot(pool, req.params.id);
    res.setHeader('Content-Disposition', `attachment; filename="pano-yedek-${req.params.id}-${new Date(s.created_at).toISOString().slice(0, 10)}.json"`);
    res.json(s.data);
  });
  app.post('/api/backups/:id/restore', requireUser, requireAdmin, async (req, res) => {
    const s = await getSnapshot(pool, req.params.id);
    res.json(await replaceAll(pool, req.user, s.data, 'restore'));
  });
  app.get('/api/trash', requireUser, requireAdmin, async (_req, res) => res.json(await listTrash(pool)));
  app.post('/api/trash/:id/restore', requireUser, requireAdmin, async (req, res) => res.json(await restoreTrash(pool, req.user, req.params.id)));
  app.get('/api/activity', requireUser, requireAdmin, async (req, res) =>
    res.json(await activity(pool, Math.min(500, Number(req.query.limit) || 200))));

  app.post('/api/sync', requireUser, async (req, res) => {
    res.json(await applyChanges(pool, req.user, req.body?.changes));
  });

  /* Hızlı kişi ekleme (görev 12): yönetici + üye; izleyici 403. Yalnız ad, e-posta, telefon. */
  app.post('/api/customers/:id/contacts', requireUser, async (req, res) => {
    res.json(await addContact(pool, req.user, req.params.id, req.body));
  });

  /* Tam yedek (yönetici). Parola özetleri dahil edilmez. */
  app.get('/api/export', requireUser, async (req, res) => {
    if (!isAdminRole(req.user.role)) throw new HttpError(403, 'Yalnızca yöneticiler');
    const { data } = await readState(pool, req.user);
    for (const k of ['ui', 'board', 'open']) delete data[k];
    res.setHeader('Content-Disposition', `attachment; filename="pano-yedek-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(data);
  });

  /* Posta kutuları (görev 11, E2): yalnız yönetici; jetonlar hiçbir yanıtta yok. */
  mailRoutes(app, pool, requireUser, requireAdmin);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Bulunamadı')));

  app.use(express.static(PUBLIC, { index: 'index.html', maxAge: 0 }));
  app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
    /* Veritabanı hatasının `detail` alanı satırdaki değeri taşır (ör. vergi no / T.C. kimlik no):
       günlüğe yalnız kod, ileti ve kısıt adı yazılır. */
    if (status >= 500) {
      if (err?.severity && typeof err.code === 'string')
        console.error('[hata]', req.method, req.url, { code: err.code, message: err.message, constraint: err.constraint });
      else console.error('[hata]', req.method, req.url, err);
    }
    res.status(status).json({ error: status >= 500 ? 'Sunucu hatası' : err.message });
  });
  return app;
}
