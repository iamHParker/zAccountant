// Starts the web server.  ℹ️ Run with:  npm run dev   then open http://localhost:3000
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';

// Sign-in (Sprint 1) is not built yet, so the server only runs in development mode,
// listening on this computer only. This prevents accidentally exposing books to the internet.
if (process.env.ZACC_DEV_MODE !== '1') {
  console.error('zAccountant has no sign-in yet. Start it with ZACC_DEV_MODE=1 (local development only).');
  process.exit(1);
}

const pool = createPool();
const applied = await migrate(pool);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
createApp(pool).listen(port, host, () => console.log(`zAccountant running at http://${host}:${port}`));
