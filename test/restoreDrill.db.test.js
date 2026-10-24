import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { hasDb, freshDatabase, emptyDatabase } from './db.js';
import * as ledger from '../src/services/ledgerService.js';
import { restoreDrill } from '../src/jobs/restoreDrill.js';

// pg_dump must be at least the server's version; skip (don't fail) on a machine without a matching one.
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

test('restore drill: back up, restore into an empty database, books check passes', { skip: await toolsMatchServer() }, async (t) => {
  const src = await freshDatabase();
  const dst = await emptyDatabase();
  t.after(async () => { await src.drop(); await dst.drop(); });
  const co = await ledger.createCompany(src.pool, { name: 'Drill Co', homeState: 'TX' });
  const accts = await ledger.listAccounts(src.pool, co.id);
  const id = (code) => accts.find((a) => a.code === code).id;
  await ledger.postEntry(src.pool, co.id, { date: '2026-10-01', memo: 'Owner invests', lines: [{ accountId: id('1000'), debit: '5000.00' }, { accountId: id('3000'), credit: '5000.00' }] });

  const lines = [];
  const r = await restoreDrill({ sourceUrl: src.url, targetUrl: dst.url, log: (l) => lines.push(JSON.parse(l)) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.steps.map((s) => s.step), ['backup', 'restore', 'row counts', 'books check']);
  const check = r.steps.find((s) => s.step === 'books check');
  assert.deepEqual([check.companies, check.failures], [1, 0]);
  assert.deepEqual(r.steps.find((s) => s.step === 'row counts').changedSinceBackup, []);

  // A second run refuses: the target is no longer empty, and the drill never overwrites data.
  await assert.rejects(restoreDrill({ sourceUrl: src.url, targetUrl: dst.url, log: () => {} }), /already has \d+ tables/);
  await assert.rejects(restoreDrill({ sourceUrl: src.url, targetUrl: src.url, log: () => {} }), /must not be the source/);
});
