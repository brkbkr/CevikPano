import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRoutes, requireUser, meOf } from './auth.js';
import { readState, readChanges, applyChanges, HttpError } from './store.js';

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

  app.get('/api/changes', requireUser, async (req, res) => {
    const since = Math.max(0, Number(req.query.since) || 0);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await readChanges(pool, since));
  });

  app.post('/api/sync', requireUser, async (req, res) => {
    res.json(await applyChanges(pool, req.user, req.body?.changes));
  });

  /* Tam yedek (yönetici). Parola özetleri dahil edilmez. */
  app.get('/api/export', requireUser, async (req, res) => {
    if (!['admin', 'super'].includes(req.user.role)) throw new HttpError(403, 'Yalnızca yöneticiler');
    const { data } = await readState(pool, req.user);
    res.setHeader('Content-Disposition', `attachment; filename="pano-yedek-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(data);
  });

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Bulunamadı')));

  app.use(express.static(PUBLIC, { index: 'index.html', maxAge: 0 }));
  app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error('[hata]', req.method, req.url, err);
    res.status(status).json({ error: status >= 500 ? 'Sunucu hatası' : err.message });
  });
  return app;
}
