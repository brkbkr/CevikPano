import { createPool, migrate } from './db.js';
import { bootstrap } from './store.js';

const pool = createPool();
await migrate(pool);
await bootstrap(pool);
await pool.end();
console.log('[migrate] şema güncel.');
