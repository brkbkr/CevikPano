import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/* Ön yüzdeki DB nesnesinin dizileri → tablo adları.
   Listede olmayan bir dizi gelirse `misc_records` tablosuna yazılır. */
export const TABLES = {
  projects: 'projects', statuses: 'statuses', sprints: 'sprints', issues: 'issues',
  worklogs: 'worklogs', comments: 'comments', history: 'history', transitions: 'transitions',
  links: 'links', fields: 'fields', rules: 'rules', filters: 'filters',
  workspaces: 'workspaces',                         // 003_workspaces.sql
  customers: 'customers',                           // 004_cariler.sql
  reports: 'reports',                               // 011_kayitli_raporlar.sql
  versions: 'versions',                             // 017_surumler.sql
};

/* İstemciden yazılabilen, tablosu olmayan (misc_records) koleksiyonlar: beyaz liste (Güv D1). Bugünkü ön yüzün
   DB dizilerinin hepsi TABLES'ta (ya da users); bu yüzden liste boş. Ön yüze yeni bir dizi eklenirse ya buraya
   yazılır ya da (kalıcıysa) geçiş dosyasıyla tablo açılıp TABLES'a eklenir. Tercih (PREF_KEYS) ve ayar adlarıyla
   çakışan ad listede olsa da reddedilir (store.js miscAllowed). misc_records'taki eski kayıtlar okunmaya devam eder. */
export const MISC_COLLECTIONS = [];

/* Koleksiyonun tablosu (yalnız kendi anahtarı; `constructor` gibi kalıtılan adlar tablo sayılmaz). */
export const tableOf = c => (typeof c === 'string' && Object.hasOwn(TABLES, c) ? TABLES[c] : undefined);

/* Nesne prototipindeki adlar (`__proto__`, `constructor`, `hasOwnProperty` ...) koleksiyon/ayar adı olamaz:
   düz nesnelere anahtar olarak yazıldıklarında prototipe dokunur ya da kalıtılan değeri okur. */
export const reservedName = c => typeof c === 'string' && c in Object.prototype;

/* Kişiye özel tutulan üst düzey anahtarlar (herkesin ekranı ayrı). */
export const PREF_KEYS = ['ui', 'board', 'open'];

/* Hiç saklanmayan üst düzey anahtarlar. */
export const IGNORED_KEYS = ['savedAt', 'savedBy'];

export function createPool(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL tanımlı değil');
  const local = /localhost|127\.0\.0\.1|@[^.]+(:\d+)?\//.test(url) && !/render\.com/.test(url);
  const ssl = process.env.PGSSL === 'disable' || local ? false : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: url, ssl, max: 10, statement_timeout: 30000,
    idle_in_transaction_session_timeout: 60000 });
  pool.on('error', e => console.error('[db] boşta bağlantı hatası:', e.message));
  return pool;
}

/* Sürümlü şema geçişleri: server/migrations/NNN_ad.sql sırayla, her biri bir kez
   ve kendi işleminde çalışır. Birden çok sunucu aynı anda açılırsa danışma kilidi
   (advisory lock) yalnızca birinin geçiş yapmasını sağlar. */
export async function migrate(pool, log = () => {}) {
  const dir = path.join(here, 'migrations');
  const files = (await readdir(dir)).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727274)');
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await c.query('SELECT id FROM schema_migrations')).rows.map(r => r.id));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(path.join(dir, f), 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (id) VALUES ($1)', [f]);
        await c.query('COMMIT');
        log(`[db] geçiş uygulandı: ${f}`);
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`Geçiş başarısız (${f}): ${e.message}`);
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    c.release();
  }
}

export async function tx(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}
