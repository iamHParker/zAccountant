import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsv } from '../src/core/bankImport.js';
import { readAccountsTable, readTrialBalance, readJournal, readIif, mapAccountType } from '../src/core/bookImport.js';
import { readXlsx, excelSerialToIso } from '../src/core/xlsx.js';
import { makeXlsx } from './xlsxWriter.js';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const tpl = (f) => readFileSync(new URL(`../public/templates/${f}`, import.meta.url), 'utf8');

test('QuickBooks account types map to ours', () => {
  assert.deepEqual(mapAccountType('Other Current Liability'), ['liability', 'current']);
  assert.deepEqual(mapAccountType('CCARD'), ['liability', 'credit_card']);
  assert.deepEqual(mapAccountType('Fixed Asset', 'Accumulated Depreciation'), ['asset', 'contra']);
  assert.deepEqual(mapAccountType('Equity', 'Owner\'s draw'), ['equity', 'draws']);
  assert.deepEqual(mapAccountType('Expense', 'cogs'), ['expense', 'cogs']);
  assert.equal(mapAccountType('Spaceship'), null);
});

test('QuickBooks Account List export (title rows above the header)', () => {
  const a = readAccountsTable(parseCsv(fx('qb-account-list.csv')));
  assert.equal(a.length, 10);
  assert.deepEqual(a[0], { code: '1010', name: 'Operating Checking', type: 'asset', subtype: 'bank' });
  assert.deepEqual(a.find((x) => x.name === 'Chase Ink'), { code: '2110', name: 'Chase Ink', type: 'liability', subtype: 'credit_card' });
});

test('our chart template', () => {
  const a = readAccountsTable(parseCsv(tpl('chart-of-accounts.csv')));
  assert.deepEqual(a.map((x) => [x.code, x.type, x.subtype]), [['1020', 'asset', 'bank'], ['1520', 'asset', 'fixed'], ['2600', 'liability', 'long_term'], ['4200', 'revenue', 'operating'], ['6700', 'expense', 'operating']]);
});

test('trial balance template balances; signed Balance column works too', () => {
  const l = readTrialBalance(parseCsv(tpl('opening-balances.csv')));
  assert.equal(l.reduce((s, x) => s + x.debitCents, 0), 7520000);
  assert.equal(l.reduce((s, x) => s + x.creditCents, 0), 7520000);
  const s = readTrialBalance(parseCsv('Account,Balance\nCash,100.00\nCapital,-100.00\n'));
  assert.deepEqual(s.map((x) => [x.debitCents, x.creditCents]), [[10000, 0], [0, 10000]]);
});

test('QuickBooks Journal report: grouped by date rows, subtotal rows skipped', () => {
  const e = readJournal(parseCsv(fx('qb-journal.csv')));
  assert.equal(e.length, 6);
  assert.equal(e[0].date, '2026-01-02');
  assert.match(e[1].memo, /Expense · Adobe · Monthly plan/);
  assert.deepEqual(e[1].lines.map((l) => [l.account, l.debitCents, l.creditCents]), [['Software Subscriptions', 5499, 0], ['Chase Ink', 0, 5499]]);
  const total = e.reduce((s, x) => s + x.lines.reduce((t, l) => t + l.debitCents, 0), 0);
  assert.equal(total, 2611284); // matches the TOTAL row in the file
});

test('our journal template groups by Entry column', () => {
  const e = readJournal(parseCsv(tpl('journal-entries.csv')));
  assert.equal(e.length, 2);
  assert.equal(e[1].lines[0].debitCents, 450000);
});

test('unbalanced entries and bad dates are all reported', () => {
  assert.throws(() => readJournal(parseCsv('Entry,Date,Account,Debit,Credit\n1,01/01/2026,Cash,10,\n1,01/01/2026,Sales,,9\n2,13/40/2026,Cash,1,\n')), (e) => e.details.length === 2);
});

test('QuickBooks IIF: accounts and transactions; customer list ignored', () => {
  const r = readIif(fx('qb.iif'));
  assert.equal(r.accounts.length, 3);
  assert.deepEqual(r.accounts[2], { code: '6620', name: 'Drafting Supplies', type: 'expense', subtype: 'operating' });
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.entries[1].lines.map((l) => [l.account, l.debitCents, l.creditCents]), [['Operating Checking', 0, 8640], ['Drafting Supplies', 8640, 0]]);
  assert.deepEqual(r.ignored, ['CUST']);
  assert.throws(() => readIif('!TRNS\tDATE\tACCNT\tAMOUNT\nTRNS\t01/01/2026\tCash\t5\nSPL\t01/01/2026\tSales\t-4\nENDTRNS\n'), /does not balance/);
});

test('Excel .xlsx: shared strings, numbers, dates, float noise', () => {
  assert.equal(excelSerialToIso(46037), '2026-01-15');
  const buf = makeXlsx([
    ['Entry', 'Date', 'Memo', 'Account', 'Debit', 'Credit'],
    ['1', { date: 46037 }, 'Rent & utilities', '6300 Rent', { raw: '1234.5599999999999' }, ''],
    ['1', { date: 46037 }, 'Rent & utilities', '1000 Checking', '', 1234.56],
  ]);
  const rows = readXlsx(buf);
  assert.deepEqual(rows[1], ['1', '2026-01-15', 'Rent & utilities', '6300 Rent', '1234.56']);
  const e = readJournal(rows);
  assert.equal(e[0].lines[0].debitCents, 123456);
  assert.equal(e[0].lines[1].creditCents, 123456);
  assert.throws(() => readXlsx(Buffer.from('not a zip at all, just text')), /not an Excel/);
});
