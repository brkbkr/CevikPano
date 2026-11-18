import { createPool, migrate } from './db.js';
import { bootstrap } from './store.js';
import { createApp } from './app.js';
import { startAutoBackup } from './backup.js';
import { startMailPoller } from './mail.js';

const port = Number(process.env.PORT || 3000);

async function main() {
  const pool = createPool();
  /* Veritabanı yeni açılıyorsa birkaç kez dene (Render'da ilk kurulum). */
  for (let i = 1; ; i++) {
    try { await pool.query('SELECT 1'); break; }
    catch (e) {
      if (i >= 10) throw e;
      console.log(`[db] bağlanılamadı (${e.message}), ${i * 2} sn sonra tekrar...`);
      await new Promise(r => setTimeout(r, i * 2000));
    }
  }
  await migrate(pool, console.log);
  await bootstrap(pool);
  const app = createApp(pool);
  startAutoBackup(pool);
  startMailPoller(pool);
  const server = app.listen(port, () => console.log(`[pano] http://localhost:${port} adresinde çalışıyor`));
  const stop = () => { server.close(() => pool.end().then(() => process.exit(0))); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch(e => { console.error('[pano] başlatılamadı:', e); process.exit(1); });
