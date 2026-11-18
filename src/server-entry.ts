import { migrate } from './db.js';
import { startServer } from './server.js';
await migrate();
await startServer();
