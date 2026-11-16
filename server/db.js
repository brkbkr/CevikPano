import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/* Ön yüzdeki DB nesnesinin dizileri → tablo adları.
   Listede olmayan bir dizi gelirse `misc_records` tablosuna yazılır. */
export const TABLES = {
  projects: 'projects', statuses: 'statuses', sprints: 'sprints', issues: 'issues',
  worklogs: 'worklogs', comments: 'comments', history: 'history', transitions: 'transitions',
  links: 'links', fields: 'fields', rules: 'rules', filters: 'filters',
};

/* Kişiye özel tutulan üst düzey anahtarlar (herkesin ekranı ayrı). */
export const PREF_KEYS = ['ui', 'board', 'open'];

/* Hiç saklanmayan üst düzey anahtarlar. */
export const IGNORED_KEYS = ['savedAt', 'savedBy'];

export function createPool(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL tanımlı değil');
  const local = /localhost|127\.0\.0\.1|@[^.]+(:\d+)?\//.test(url) && !/render\.com/.test(url);
  const ssl = process.env.PGSSL === 'disable' || local ? false : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: url, ssl, max: 10 });
  pool.on('error', e => console.error('[db] boşta bağlantı hatası:', e.message));
  return pool;
}

export async function migrate(pool) {
  const sql = await readFile(path.join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
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
