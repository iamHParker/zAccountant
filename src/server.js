// Starts the web server.  ℹ️ Run with:  npm run dev   then open http://localhost:3000
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { startNightlyScheduler } from './jobs/booksCheck.js';
import { ensureRuntimeRole } from './db/grant.js';

const production = process.env.NODE_ENV === 'production';
if (production) {
  // Refuse to run in production without the secrets and settings that protect customer data.
  // On Railway the site's address comes in RAILWAY_PUBLIC_DOMAIN, so ALLOWED_HOSTS is optional there.
  const missing = ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'AUDIT_HMAC_KEY', 'FIELD_ENCRYPTION_KEY']
    .filter((k) => !process.env[k]);
  if (!process.env.ALLOWED_HOSTS && !process.env.RAILWAY_PUBLIC_DOMAIN) missing.push('ALLOWED_HOSTS');
  if (missing.length) {
    console.error(`Missing required settings: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (process.env.MIGRATION_DATABASE_URL === process.env.DATABASE_URL) {
    console.error('DATABASE_URL must use the restricted runtime role, not the owner role in MIGRATION_DATABASE_URL');
    process.exit(1);
  }
}

// Migrations run with the owner role; the app itself connects with the restricted runtime role.
const ownerPool = createPool(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL);
const applied = await migrate(ownerPool);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
if (process.env.MIGRATION_DATABASE_URL) {
  // Create/refresh the app's restricted login from DATABASE_URL (user + password) and its rights.
  const r = await ensureRuntimeRole(ownerPool, process.env.DATABASE_URL);
  if (!r.skipped) console.log(JSON.stringify({ level: 'info', msg: 'runtime database role ready', role: r.role }));
} else {
  console.warn('Note: running with a single database role (development). Row-level security is not enforced for the table owner.');
}

// The nightly books check works across all companies, so it uses the owner connection.
if (process.env.NIGHTLY_JOB !== 'off') startNightlyScheduler(ownerPool);
else await ownerPool.end();

const pool = createPool();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1');
const server = createApp(pool).listen(port, host, () => console.log(`zAccountant running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));

// Last line of defence. A promise nobody waited on is logged and the server keeps going (the request it belonged
// to has already been answered). Anything thrown outside a request leaves the program in an unknown state, so it is
// logged and the server stops; Railway starts a fresh copy within seconds. Requests never reach here: the error
// handler in app.js answers them.
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ level: 'error', msg: 'unhandled promise rejection', error: String(reason?.message ?? reason).slice(0, 500) }));
});
process.on('uncaughtException', (err) => {
  console.error(JSON.stringify({ level: 'fatal', msg: 'uncaught exception, restarting', error: err.message, stack: err.stack?.split('\n').slice(0, 5).join(' | ') }));
  process.exit(1);
});

// Railway stops the old copy with SIGTERM on every deploy: finish requests in flight (each is one
// database transaction), then close the database connections. Anything still running after 10 s is cut off
// and rolled back by PostgreSQL, so a half-finished save is never left behind.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(async () => {
      await pool.end().catch(() => {});
      if (process.env.NIGHTLY_JOB !== 'off') await ownerPool.end().catch(() => {});
      process.exit(0);
    });
    server.closeIdleConnections?.();
  });
}
