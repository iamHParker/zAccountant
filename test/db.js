// Gives each integration test file its own throwaway database, so tests never touch real data.
// Set DATABASE_URL to a server where the user can CREATE DATABASE (and CREATE ROLE, for the
// restricted runtime-role tests). Without DATABASE_URL, DB tests are skipped.
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { grantRuntimeRole } from '../src/db/grant.js';

export const hasDb = Boolean(process.env.DATABASE_URL);
const APP_ROLE = 'zacc_app_test';

export async function freshDatabase({ withAppRole = false } = {}) {
  const base = new URL(process.env.DATABASE_URL);
  const name = `zacc_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  if (withAppRole) {
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE}';
      END IF; END $$`);
  }
  await admin.end();
  const url = new URL(base); url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  await migrate(pool);
  let appPool = null;
  if (withAppRole) {
    await grantRuntimeRole(pool, APP_ROLE);
    const appUrl = new URL(url); appUrl.username = APP_ROLE; appUrl.password = APP_ROLE;
    appPool = createPool(appUrl.toString());
  }
  return {
    pool,
    appPool,
    async drop() {
      if (appPool) await appPool.end();
      await pool.end();
      const a = new pg.Client({ connectionString: base.toString() });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
