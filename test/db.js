// Gives each integration test file its own throwaway database, so tests never touch real data.
// Set DATABASE_URL to a server where the user can CREATE DATABASE. Without it, DB tests are skipped.
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

export const hasDb = Boolean(process.env.DATABASE_URL);

export async function freshDatabase() {
  const base = new URL(process.env.DATABASE_URL);
  const name = `zacc_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base); url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  await migrate(pool);
  return {
    pool,
    async drop() {
      await pool.end();
      const a = new pg.Client({ connectionString: base.toString() });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
