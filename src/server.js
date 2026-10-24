// Starts the web server.  ℹ️ Run with:  npm run dev   then open http://localhost:3000
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';

const production = process.env.NODE_ENV === 'production';
if (production) {
  // Refuse to run in production without the secrets and settings that protect customer data.
  const missing = ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'AUDIT_HMAC_KEY', 'FIELD_ENCRYPTION_KEY', 'ALLOWED_HOSTS']
    .filter((k) => !process.env[k]);
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
await ownerPool.end();
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
if (!process.env.MIGRATION_DATABASE_URL) {
  console.warn('Note: running with a single database role (development). Row-level security is not enforced for the table owner.');
}

const pool = createPool();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1');
createApp(pool).listen(port, host, () => console.log(`zAccountant running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
