import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv, amt, csvFileName, statementRows, agingRows } from '../src/core/csv.js';
import { incomeStatement, compareStatements } from '../src/core/reports.js';
import { parseCsv } from '../src/core/bankImport.js';
import { chart, sumsFor, je } from './helpers.js';

test('cells: quoting, formula guard, amounts as plain decimals', () => {
  assert.equal(csvCell('Smith, Jones & Co'), '"Smith, Jones & Co"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('-rent'), "'-rent");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell(amt(-123456)), '-1234.56'); // amounts are never escaped
  assert.equal(csvCell(amt(5)), '0.05');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(42), '42');
});

test('a CSV file round-trips through our own CSV reader', () => {
  const text = toCsv([['Name', 'Amount'], ['A, Inc.', amt(150_000)], ['line\nbreak', amt(-1)]]);
  assert.ok(text.startsWith('﻿'));
  assert.deepEqual(parseCsv(text.slice(1)).filter((r) => r.some((c) => c !== '')), [['Name', 'Amount'], ['A, Inc.', '1500.00'], ['line\nbreak', '-0.01']]);
});

test('file names are safe', () => {
  assert.equal(csvFileName('Acme "Builders"/LLC', 'Balance Sheet', '2026-12-31'), 'Acme BuildersLLC - Balance Sheet 2026-12-31.csv');
});

test('comparative P&L as CSV: columns add up like the statement', () => {
  const entries = [
    je('2025-03-01', 'Sale', ['1000', 1_000_000, 0], ['4000', 0, 1_000_000]),
    je('2025-03-05', 'Rent', ['6300', 200_000, 0], ['1000', 0, 200_000]),
    je('2026-03-01', 'Sale', ['1000', 1_250_000, 0], ['4000', 0, 1_250_000]),
    je('2026-03-05', 'Rent', ['6300', 200_000, 0], ['1000', 0, 200_000]),
  ];
  const a = chart();
  const cur = { from: '2026-03-01', to: '2026-03-31', ...incomeStatement(a, sumsFor(entries, { from: '2026-03-01', to: '2026-03-31' })) };
  const prior = incomeStatement(a, sumsFor(entries, { from: '2025-03-01', to: '2025-03-31' }));
  const c = compareStatements('income-statement', cur, prior, { compare: 'prior_year', from: '2025-03-01', to: '2025-03-31' });
  const rows = statementRows('income-statement', c, { company: 'Acme', title: 'Profit and Loss' });
  const text = toCsv(rows);
  assert.match(text, /Account number,Account,2026-03-01 to 2026-03-31,2025-03-01 to 2025-03-31,Change,Change %/);
  assert.match(text, /4000,.*,12500\.00,10000\.00,2500\.00,25\.0/);
  // Net income $10,500 vs $8,000: +$2,500, +31.3% (31.25 rounds half up).
  assert.match(text, /,Net income,10500\.00,8000\.00,2500\.00,31\.3\r\n$/);
});

test('aging as CSV lists each open document under its customer', () => {
  const d = {
    asOf: '2026-12-31', buckets: [{ id: 'current', label: 'Current' }, { id: 'd1_30', label: '1-30' }],
    rows: [{ name: '=Evil Co', current: 0, d1_30: 50_000, totalCents: 50_000,
      documents: [{ number: 'INV-7', date: '2026-11-01', dueDate: '2026-12-01', daysPastDue: 30, bucket: 'd1_30', balanceCents: 50_000 }] }],
    totals: { current: 0, d1_30: 50_000, totalCents: 50_000 },
  };
  const lines = toCsv(agingRows(d, { company: 'Acme', title: 'Accounts Receivable Aging' })).split('\r\n');
  assert.equal(lines[4], 'Name,Number,Date,Due,Days past due,Current,1-30,Total');
  assert.equal(lines[5], "'=Evil Co,,,,,0.00,500.00,500.00");
  assert.equal(lines[6], ',INV-7,2026-11-01,2026-12-01,30,,500.00,500.00');
  assert.equal(lines[7], 'Total,,,,,0.00,500.00,500.00');
});
