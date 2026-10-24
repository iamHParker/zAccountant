import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import * as ledger from '../src/services/ledgerService.js';
import * as reports from '../src/services/reportService.js';
import { verifyChain } from '../src/services/audit.js';

test('ledger against PostgreSQL', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  t.after(() => db.drop());
  const { pool } = db;
  const co = await ledger.createCompany(pool, { name: 'Acme Structural LLC', homeState: 'TX' });
  const accts = await ledger.listAccounts(pool, co.id);
  const A = Object.fromEntries(accts.map((a) => [a.code, a.id]));

  await t.test('posts a balanced entry and numbers it', async () => {
    const je = await ledger.postEntry(pool, co.id, { date: '2026-01-02', memo: 'Owner investment',
      lines: [{ accountId: A['1000'], debit: '25000' }, { accountId: A['3000'], credit: '25000' }] });
    assert.equal(je.entry_number, 1);
    const je2 = await ledger.postSimple(pool, co.id, { date: '2026-01-05', memo: 'January rent', fromAccountId: A['1000'], toAccountId: A['6300'], amount: '1800' });
    assert.equal(je2.entry_number, 2);
  });

  await t.test('database itself rejects an unbalanced entry even if app code is bypassed', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [e] } = await c.query(`INSERT INTO journal_entries (company_id, entry_number, entry_date) VALUES ($1, 999, '2026-01-06') RETURNING id`, [co.id]);
      await c.query(`INSERT INTO journal_lines (entry_id, company_id, account_id, entry_date, debit_cents) VALUES ($1,$2,$3,'2026-01-06',100)`, [e.id, co.id, A['1000']]);
      await c.query(`INSERT INTO journal_lines (entry_id, company_id, account_id, entry_date, credit_cents) VALUES ($1,$2,$3,'2026-01-06',99)`, [e.id, co.id, A['4000']]);
      await assert.rejects(c.query('COMMIT'), /Unbalanced journal entry/);
    } finally { c.release(); }
  });

  await t.test('posted history cannot be edited or deleted', async () => {
    await assert.rejects(pool.query('UPDATE journal_lines SET debit_cents = 1'), /append-only/);
    await assert.rejects(pool.query('DELETE FROM journal_entries'), /append-only/);
    await assert.rejects(pool.query('DELETE FROM audit_log'), /append-only/);
  });

  await t.test('a line cannot use another company\'s account', async () => {
    const other = await ledger.createCompany(pool, { name: 'Other Co', homeState: 'CA' });
    const otherCash = (await ledger.listAccounts(pool, other.id)).find((a) => a.code === '1000').id;
    await assert.rejects(ledger.postEntry(pool, co.id, { date: '2026-01-07', lines: [{ accountId: otherCash, debit: '1' }, { accountId: A['4000'], credit: '1' }] }), /unknown account/);
  });

  await t.test('reversal undoes an entry exactly once', async () => {
    const e = await ledger.postSimple(pool, co.id, { date: '2026-01-10', memo: 'Typo', fromAccountId: A['1000'], toAccountId: A['6200'], amount: '999.99' });
    const r = await ledger.reverseEntry(pool, co.id, e.id, { date: '2026-01-11' });
    assert.equal(r.reverses_entry_id, e.id);
    await assert.rejects(ledger.reverseEntry(pool, co.id, e.id), /already reversed/);
    const is = await reports.getIncomeStatement(pool, co.id, { from: '2026-01-01', to: '2026-01-31' });
    assert.equal(is.operatingExpenses.lines.find((l) => l.code === '6200'), undefined);
  });

  await t.test('closed periods reject postings', async () => {
    await ledger.lockPeriod(pool, co.id, { through: '2026-01-31' });
    await assert.rejects(ledger.postSimple(pool, co.id, { date: '2026-01-15', fromAccountId: A['1000'], toAccountId: A['6200'], amount: '1' }), /closed through 2026-01-31/);
    await ledger.postSimple(pool, co.id, { date: '2026-02-01', memo: 'Sale', fromAccountId: A['4000'], toAccountId: A['1000'], amount: '5000.01' });
  });

  await t.test('reports tie out', async () => {
    const tb = await reports.getTrialBalance(pool, co.id, { asOf: '2026-12-31' });
    assert.equal(tb.balanced, true);
    const bs = await reports.getBalanceSheet(pool, co.id, { asOf: '2026-12-31' });
    assert.equal(bs.balanced, true);
    assert.equal(bs.totalAssetsCents, 2_500_000 - 180_000 + 500_001);
    const cf = await reports.getCashFlow(pool, co.id, { from: '2026-01-01', to: '2026-12-31' });
    assert.equal(cf.balanced, true);
    assert.equal(cf.endingCashCents, 2_820_001);
    const reg = await reports.getAccountRegister(pool, co.id, A['1000']);
    assert.equal(reg.endingBalanceCents, 2_820_001);
    const dash = await reports.getDashboard(pool, co.id, { asOf: '2026-12-31' });
    assert.equal(dash.cashCents, 2_820_001);
    assert.equal(dash.netIncomeYtdCents, 500_001 - 180_000);
  });

  await t.test('audit hash chain verifies, and detects tampering', async () => {
    const ok = await verifyChain(pool, co.id);
    assert.equal(ok.ok, true);
    assert.ok(ok.rows >= 6);
    // Simulate an attacker with superuser rights who disables the guard trigger:
    await pool.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
    await pool.query(`UPDATE audit_log SET payload = jsonb_set(payload, '{memo}', '"edited"') WHERE company_id = $1 AND action = 'post' AND id = (SELECT min(id) FROM audit_log WHERE company_id = $1 AND action = 'post')`, [co.id]);
    await pool.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable');
    const bad = await verifyChain(pool, co.id);
    assert.equal(bad.ok, false);
  });
});
