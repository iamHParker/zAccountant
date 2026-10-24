import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { hasDb, freshDatabase } from './db.js';
import { ensureRuntimeRole } from '../src/db/grant.js';

test('start-up creates the restricted app login from DATABASE_URL (Railway setup)', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  const role = `zacc_rt_${randomBytes(3).toString('hex')}`;
  const password = randomBytes(18).toString('base64url');
  const url = new URL(db.url); url.username = role; url.password = password;
  t.after(async () => {
    await db.pool.query(`DROP OWNED BY ${role}`).catch(() => {});
    await db.drop();
    const a = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await a.connect(); await a.query(`DROP ROLE IF EXISTS ${role}`); await a.end();
  });

  // Same user as the owner (local development): nothing to do.
  assert.equal((await ensureRuntimeRole(db.pool, db.url)).skipped, true);
  assert.equal((await ensureRuntimeRole(db.pool, url.toString())).role, role);
  assert.equal((await ensureRuntimeRole(db.pool, url.toString())).role, role, 'running again is harmless');

  const app = new pg.Client({ connectionString: url.toString() });
  await app.connect();
  try {
    assert.equal((await app.query('SELECT count(*)::int AS n FROM companies')).rows[0].n, 0);
    await assert.rejects(app.query('UPDATE journal_lines SET debit_cents = 0'), /permission denied/);
    await assert.rejects(app.query('CREATE TABLE sneaky (x int)'), /permission denied/);
    const { rows: [r] } = await app.query('SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user');
    assert.deepEqual(r, { rolsuper: false, rolbypassrls: false, rolcreaterole: false });
  } finally {
    await app.end();
  }

  const weak = new URL(url); weak.password = 'short';
  await assert.rejects(ensureRuntimeRole(db.pool, weak.toString()), /at least 16/);
  const bad = new URL(url); bad.username = 'Bad-Name';
  await assert.rejects(ensureRuntimeRole(db.pool, bad.toString()), /lower-case/);
});
