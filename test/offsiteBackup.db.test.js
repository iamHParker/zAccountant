// The nightly off-site backup: pg_dump → locked file → signed PUT to the bucket → a row in offsite_backups.
// The storage service is played by a stand-in fetch that keeps what it was sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { hasDb, freshDatabase } from './db.js';
import { runOffsiteBackup, backedUp, decryptBackup, recentOffsiteBackups } from '../src/jobs/offsiteBackup.js';

// pg_dump must be at least the server's version (as in restoreDrill.db.test.js); otherwise a stand-in dump is used.
async function realDump() {
  try {
    const tools = Number(/(\d+)\.\d+/.exec(execFileSync('pg_dump', ['--version']).toString())[1]);
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const server = Math.floor(Number((await c.query('SHOW server_version_num')).rows[0].server_version_num) / 10000);
    await c.end();
    return tools >= server;
  } catch { return false; }
}

const cfg = { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'zacc-backups', region: 'auto', keyId: 'KEYID', secret: 'SECRET', encryptionKey: 'k'.repeat(40) };

test('off-site backup: sent locked, recorded, and opens again', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  t.after(() => db.drop());
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init }); return new Response('', { status: 200 }); };
  const real = await realDump();
  const r = await runOffsiteBackup(db.pool, { cfg, url: db.url, asOf: '2026-10-25', fetchImpl, dump: real ? null : Buffer.from('PGDMP stand-in') });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.objectKey, real ? /^zaccountant\/2026\/zaccountant-2026-10-25-pg\d+\.dump\.zbk$/ : /^zaccountant\/2026\/zaccountant-2026-10-25\.dump\.zbk$/);
  assert.equal(sent.length, 1);
  const { url, init } = sent[0];
  assert.equal(url, `https://acct.r2.cloudflarestorage.com/zacc-backups/${r.objectKey}`);
  assert.equal(init.method, 'PUT');
  assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=KEYID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(init.headers['x-amz-content-sha256'], createHash('sha256').update(init.body).digest('hex'));
  // What the storage company holds is scrambled; with our key it is a real pg_dump file.
  assert.ok(!init.body.subarray(0, 64).toString('latin1').includes('PGDMP'));
  assert.equal(decryptBackup(init.body, cfg.encryptionKey).subarray(0, 5).toString(), 'PGDMP');
  assert.equal(await backedUp(db.pool, '2026-10-25'), true);

  // The bucket says no: recorded as a failure with the reason, not as a backup.
  const refuse = async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
  const bad = await runOffsiteBackup(db.pool, { cfg, url: db.url, asOf: '2026-10-26', dump: Buffer.from('PGDMP x'), fetchImpl: refuse });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /HTTP 403.*AccessDenied/);
  assert.equal(await backedUp(db.pool, '2026-10-26'), false);
  const list = await recentOffsiteBackups(db.pool);
  assert.deepEqual(list.map((x) => [x.asOf, x.ok]), [['2026-10-26', false], ['2026-10-25', true]]);
  // Not set up: nothing happens.
  assert.deepEqual(await runOffsiteBackup(db.pool, { cfg: null, asOf: '2026-10-27' }), { skipped: 'not set up' });
});
