// Bir geçiş dosyasını (tekrar çalıştırılabilir olmalı) DATABASE_URL veritabanında tek işlemde yeniden uygular.
// Örn. eski biçimli demo verisi yüklendikten sonra: node scripts/apply-sql.mjs server/migrations/005_musteri_cari.sql
import { readFile } from 'node:fs/promises';
import { createPool } from '../server/db.js';

const file = process.argv[2];
if (!file) { console.error('kullanım: node scripts/apply-sql.mjs <dosya.sql>'); process.exit(2); }
const pool = createPool();
const c = await pool.connect();
try {
  await c.query('BEGIN');
  await c.query(await readFile(file, 'utf8'));
  await c.query('COMMIT');
  console.log('[apply-sql] uygulandı:', file);
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('[apply-sql] hata:', e.message);
  process.exitCode = 1;
} finally { c.release(); await pool.end(); }
