import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import * as ledger from '../src/services/ledgerService.js';
import { runBooksCheck, runNightly } from '../src/jobs/booksCheck.js';

test('recurring entries and the nightly books check', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  t.after(() => db.drop());
  const { pool } = db;
  const co = await ledger.createCompany(pool, { name: 'Recurring Co', homeState: 'TX' });
  const A = Object.fromEntries((await ledger.listAccounts(pool, co.id)).map((a) => [a.code, a.id]));
  const rentLines = [{ accountId: A['6300'], debit: '1000' }, { accountId: A['1000'], credit: '1000' }];

  await t.test('month-end template posts on the last day of each month', async () => {
    await ledger.createRecurring(pool, co.id, { name: 'Month-end rent', frequency: 'monthly', startDate: '2026-01-31', lines: rentLines });
    const r = await ledger.postDueRecurring(pool, co.id, { asOf: '2026-04-30' });
    assert.deepEqual(r.posted.map((p) => p.date), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    assert.equal((await ledger.postDueRecurring(pool, co.id, { asOf: '2026-04-30' })).posted.length, 0);
  });

  await t.test('two runs at once never double-post', async () => {
    const [a, b] = await Promise.all([
      ledger.postDueRecurring(pool, co.id, { asOf: '2026-06-30' }),
      ledger.postDueRecurring(pool, co.id, { asOf: '2026-06-30' }),
    ]);
    assert.equal(a.posted.length + b.posted.length, 2); // May 31, Jun 30
    const { entries } = await ledger.listEntries(pool, co.id, { source: 'recurring' });
    assert.equal(entries.length, 6);
    assert.equal(new Set(entries.map((e) => e.date)).size, 6);
  });

  await t.test('a closed period stops the template with a visible reason (nothing skipped silently)', async () => {
    await ledger.createRecurring(pool, co.id, { name: 'Late one', frequency: 'weekly', startDate: '2026-07-01', lines: rentLines });
    await ledger.lockPeriod(pool, co.id, { through: '2026-07-15' });
    const r = await ledger.postDueRecurring(pool, co.id, { asOf: '2026-07-15' });
    assert.equal(r.posted.length, 0);
    assert.match(r.problems[0].error, /closed through 2026-07-15/);
    const late = (await ledger.listRecurring(pool, co.id)).find((x) => x.name === 'Late one');
    assert.equal(late.nextDate, '2026-07-01');
    assert.match(late.lastError, /closed/);
    await assert.rejects(ledger.createRecurring(pool, co.id, { name: 'Too early', frequency: 'monthly', startDate: '2026-07-10', lines: rentLines }), /after 2026-07-15/);
    await ledger.stopRecurring(pool, co.id, late.id);
  });

  await t.test('books check passes, anchors the chain, and notices deleted audit rows', async () => {
    const first = await runBooksCheck(pool, co.id, { asOf: '2026-08-31' });
    assert.equal(first.ok, true, first.problems.join('; '));
    assert.equal(first.recurringPosted.length, 2); // Jul 31 and Aug 31 rent
    const second = await runBooksCheck(pool, co.id, { asOf: '2026-08-31' });
    assert.equal(second.ok, true);
    // Simulate an attacker with database owner access removing the newest audit records.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
      await c.query('DELETE FROM audit_log WHERE company_id = $1 AND seq >= $2', [co.id, second.anchor.seq - 1]);
      await c.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable');
      await c.query('COMMIT');
    } finally { c.release(); }
    const third = await runBooksCheck(pool, co.id, { asOf: '2026-08-31' });
    assert.equal(third.ok, false);
    assert.ok(third.problems.some((p) => /from the last check is missing/.test(p)), third.problems.join('; '));
  });

  await t.test('nightly run covers every company and holds a lock', async () => {
    await ledger.createCompany(pool, { name: 'Second Co', homeState: 'CA' });
    const s = await runNightly(pool, { asOf: '2026-09-01' });
    assert.equal(s.companies, 2);
    assert.equal(s.ok, 1);          // Second Co is fine
    assert.equal(s.failed.length, 1); // Recurring Co: tampered above
  });
});
