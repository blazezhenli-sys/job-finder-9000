import { startServer } from './server.js';
import { startWorkers } from './worker.js';
await startServer();
await startWorkers();
