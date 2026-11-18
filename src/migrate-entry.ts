import { migrate, pool, startDeferredMigrations } from './db.js';

await migrate();
await startDeferredMigrations();
await pool.end();
