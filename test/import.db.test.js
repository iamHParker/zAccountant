import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hasDb, freshDatabase } from './db.js';
import * as ledger from '../src/services/ledgerService.js';
import * as imports from '../src/services/importService.js';
import * as reports from '../src/services/reportService.js';
import { verifyChain } from '../src/services/audit.js';
import { makeXlsx } from './xlsxWriter.js';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const tpl = (f) => readFileSync(new URL(`../public/templates/${f}`, import.meta.url), 'utf8');

test('importing books', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  t.after(() => db.drop());
  const { pool } = db;
  const co = await ledger.createCompany(pool, { name: 'Import Co', homeState: 'CO' });
  const count = async () => (await ledger.listEntries(pool, co.id, {})).total;
  const acctCount = async () => (await ledger.listAccounts(pool, co.id)).length;

  await t.test('QuickBooks journal without the chart first: clear error, nothing saved', async () => {
    await assert.rejects(imports.previewImport(pool, co.id, { kind: 'journal', file: { fileName: 'j.csv', content: fx('qb-journal.csv') } }),
      (e) => /Operating Checking.*not in your chart/.test(e.message) && e.details.length >= 3);
    assert.equal(await count(), 0);
  });

  await t.test('chart of accounts: preview saves nothing; import creates accounts once', async () => {
    const before = await acctCount();
    const p = await imports.previewImport(pool, co.id, { kind: 'accounts', file: { fileName: 'a.csv', content: fx('qb-account-list.csv') } });
    assert.equal(p.preview, true);
    assert.ok(p.accountsCreated.length >= 6, JSON.stringify(p.accountsCreated));
    assert.equal(await acctCount(), before);
    const r = await imports.commitImport(pool, co.id, { kind: 'accounts', file: { fileName: 'a.csv', content: fx('qb-account-list.csv') } });
    assert.equal(r.accountsCreated.length, p.accountsCreated.length);
    const accts = await ledger.listAccounts(pool, co.id);
    const opChecking = accts.find((a) => a.name === 'Operating Checking');
    assert.equal(opChecking.cashFlow, 'cash');
    assert.notEqual(opChecking.code, '1010', 'our 1010 is Savings, so QuickBooks 1010 gets the next free number');
    assert.equal(accts.find((a) => a.name === 'Savings').code, '1010');
    assert.equal(accts.find((a) => a.name === 'Chase Ink').subtype, 'credit_card');
    assert.equal(accts.find((a) => a.name === 'Engineering Fees').code, '4110');
    const again = await imports.commitImport(pool, co.id, { kind: 'accounts', file: { fileName: 'a.csv', content: fx('qb-account-list.csv') } });
    assert.equal(again.accountsCreated.length, 0, 're-import matches existing accounts');
  });

  await t.test('QuickBooks journal: imports, ties to the file to the penny, and the trial balance balances', async () => {
    const p = await imports.previewImport(pool, co.id, { kind: 'journal', file: { fileName: 'j.csv', content: fx('qb-journal.csv') } });
    assert.equal(p.entries, 6);
    assert.equal(p.totalCents, 2611284);
    assert.equal(await count(), 0);
    const r = await imports.commitImport(pool, co.id, { kind: 'journal', file: { fileName: 'j.csv', content: fx('qb-journal.csv') } });
    assert.equal(r.verified, true);
    assert.equal(r.trialBalance.balanced, true);
    assert.equal(await count(), 6);
    const tb = await reports.getTrialBalance(pool, co.id, { asOf: '2026-01-31' });
    const row = (name) => tb.rows.find((x) => x.name === name);
    assert.equal(row('Operating Checking').debitCents - row('Operating Checking').creditCents, 1684567); // 12,345.67 + 4,500.00
    assert.equal(row('Chase Ink').creditCents, 5499);
    assert.equal(row('Utilities:Electric').debitCents, 21218, 'sub-account');
    assert.equal(r.accountTotals.find((a) => a.name === 'Operating Checking').netCents, 1684567);
  });

  await t.test('IIF creates its own accounts and posts', async () => {
    const r = await imports.commitImport(pool, co.id, { kind: 'iif', file: { fileName: 'q.iif', content: fx('qb.iif') } });
    assert.equal(r.entries, 2);
    assert.deepEqual(r.accountsCreated.map((a) => a.code), ['6620']);
    assert.deepEqual(r.ignored, ['CUST']);
  });

  await t.test('opening balances from a trial balance (template) and from Excel', async () => {
    const co2 = await ledger.createCompany(pool, { name: 'Opening Co', homeState: 'TX' });
    await assert.rejects(imports.previewImport(pool, co2.id, { kind: 'opening', file: { content: tpl('opening-balances.csv') } }), /date/);
    const r = await imports.commitImport(pool, co2.id, { kind: 'opening', asOf: '2025-12-31', file: { fileName: 'tb.csv', content: tpl('opening-balances.csv') } });
    assert.equal(r.totalCents, 7520000);
    const bs = await reports.getBalanceSheet(pool, co2.id, { asOf: '2025-12-31' });
    assert.equal(bs.balanced, true);
    assert.equal(bs.assets.totalCents, 7520000);
    const co3 = await ledger.createCompany(pool, { name: 'Excel Co', homeState: 'CA' });
    const xlsx = makeXlsx([['Account', 'Debit', 'Credit'], ['1000', 500.25, ''], ['3000', '', { raw: '500.25000000000006' }]]);
    const x = await imports.commitImport(pool, co3.id, { kind: 'opening', asOf: '2026-01-01', file: { fileName: 'tb.xlsx', base64: xlsx.toString('base64') } });
    assert.equal(x.totalCents, 50025);
  });

  await t.test('closed period: whole import refused', async () => {
    const co4 = await ledger.createCompany(pool, { name: 'Closed Co', homeState: 'TX' });
    await ledger.lockPeriod(pool, co4.id, { through: '2026-01-31' });
    await assert.rejects(imports.commitImport(pool, co4.id, { kind: 'journal', file: { content: tpl('journal-entries.csv') } }), /closed period/);
    assert.equal((await ledger.listEntries(pool, co4.id, {})).total, 0);
  });

  await t.test('undo reverses every entry of the batch; can only be done once', async () => {
    const list = await imports.listImports(pool, co.id);
    const journal = list.find((b) => b.kind === 'journal');
    const u = await imports.undoImport(pool, co.id, journal.id);
    assert.equal(u.reversed, 6);
    await assert.rejects(imports.undoImport(pool, co.id, journal.id), /already undone/);
    const tb = await reports.getTrialBalance(pool, co.id, { asOf: '2026-12-31' });
    const cash = tb.rows.find((x) => x.name === 'Operating Checking');
    assert.equal((cash?.debitCents ?? 0) - (cash?.creditCents ?? 0), 150000 - 8640, 'only the IIF deposit and check remain');
    assert.equal((await verifyChain(pool, co.id)).ok, true);
  });
});
