// The one-command restore drill against the off-site copy: fetch the newest sent file back, check it, restore it
// into a throwaway database, books check, delete the throwaway. The bucket is a stand-in fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { hasDb, freshDatabase } from './db.js';
import * as ledger from '../src/services/ledgerService.js';
import { runOffsiteBackup } from '../src/jobs/offsiteBackup.js';
import { offsiteDrill, databaseUrlFor } from '../src/jobs/offsiteDrill.js';

async function toolsMatchServer() {
  if (!hasDb) return 'DATABASE_URL not set';
  let tools;
  try { tools = Number(/(\d+)\.\d+/.exec(execFileSync('pg_dump', ['--version']).toString())[1]); } catch { return 'pg_dump not installed'; }
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const server = Math.floor(Number((await c.query('SHOW server_version_num')).rows[0].server_version_num) / 10000);
  await c.end();
  return tools >= server ? false : `pg_dump ${tools} is older than the server (${server})`;
}

const cfg = { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'zacc-backups', region: 'auto', keyId: 'KEYID', secret: 'SECRET', encryptionKey: 'k'.repeat(40) };

async function databaseExists(name) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try { return (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows.length > 0; } finally { await c.end(); }
}

test('databaseUrlFor swaps only the database name', () => {
  assert.equal(databaseUrlFor('postgres://u:p%40ss@h.example:5432/railway?sslmode=require', 'zacc_drill_20261123'),
    'postgres://u:p%40ss@h.example:5432/zacc_drill_20261123?sslmode=require');
});

test('off-site drill: the sent file comes back, restores, books check, throwaway deleted', { skip: await toolsMatchServer() }, async (t) => {
  const src = await freshDatabase();
  t.after(() => src.drop());
  const co = await ledger.createCompany(src.pool, { name: 'Offsite Co', homeState: 'TX' });
  const accts = await ledger.listAccounts(src.pool, co.id);
  const id = (code) => accts.find((a) => a.code === code).id;
  await ledger.postEntry(src.pool, co.id, { date: '2026-11-01', memo: 'Owner invests', lines: [{ accountId: id('1000'), debit: '2500.00' }, { accountId: id('3000'), credit: '2500.00' }] });

  const bucket = new Map();
  const fetchImpl = async (url, init) => {
    if (init.method === 'PUT') { bucket.set(url, Buffer.from(init.body)); return new Response('', { status: 200 }); }
    assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=KEYID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, /);
    return bucket.has(url) ? new Response(bucket.get(url), { status: 200 }) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
  };
  const sent = await runOffsiteBackup(src.pool, { cfg, url: src.url, asOf: '2026-11-23', fetchImpl });
  assert.equal(sent.ok, true, JSON.stringify(sent));

  const database = `zacc_drill_t${randomBytes(3).toString('hex')}`;
  const lines = [];
  const r = await offsiteDrill({ url: src.url, cfg, fetchImpl, database, log: (l) => lines.push(JSON.parse(l)) });
  assert.equal(r.ok, true, JSON.stringify(lines));
  assert.equal(r.objectKey, sent.objectKey);
  assert.equal(lines[0].sha256Matches, true);
  assert.equal(lines.find((l) => l.step === 'books check').failures, 0);
  assert.equal(await databaseExists(database), false, 'the throwaway database is deleted');

  // A file changed in the bucket is refused before anything is restored, and nothing is left behind.
  for (const [k, v] of bucket) { const bad = Buffer.from(v); bad[bad.length - 1] ^= 1; bucket.set(k, bad); }
  await assert.rejects(offsiteDrill({ url: src.url, cfg, fetchImpl, database, log: () => {} }), /not the one that was sent/);
  assert.equal(await databaseExists(database), false);
});
