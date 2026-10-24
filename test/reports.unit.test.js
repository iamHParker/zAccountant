import test from 'node:test';
import assert from 'node:assert/strict';
import { trialBalance, incomeStatement, balanceSheet, cashFlowStatement } from '../src/core/reports.js';
import { chart, sumsFor, je } from './helpers.js';

// A small contractor's first 14 months (fiscal year = calendar year). Amounts in cents.
const entries = [
  je('2025-01-02', 'Owner invests', ['1000', 5_000_000, 0], ['3000', 0, 5_000_000]),
  je('2025-02-01', 'Buy equipment with loan', ['1500', 3_000_000, 0], ['2700', 0, 2_000_000], ['1000', 0, 1_000_000]),
  je('2025-06-30', 'Invoice customer', ['1100', 4_000_000, 0], ['4100', 0, 4_000_000]),
  je('2025-07-15', 'Customer pays', ['1000', 3_000_000, 0], ['1100', 0, 3_000_000]),
  je('2025-08-01', 'Rent', ['6300', 1_200_000, 0], ['1000', 0, 1_200_000]),
  je('2025-12-31', 'Depreciation', ['6100', 600_000, 0], ['1590', 0, 600_000]),
  // 2026
  je('2026-01-10', 'Cash sale', ['1000', 250_000, 0], ['4000', 0, 250_000]),
  je('2026-01-15', 'Supplies on credit card', ['6200', 12_345, 0], ['2100', 0, 12_345]),
  je('2026-01-20', 'Loan payment: principal + interest', ['2700', 100_000, 0], ['6900', 15_000, 0], ['1000', 0, 115_000]),
  je('2026-02-01', 'Owner draw', ['3100', 300_000, 0], ['1000', 0, 300_000]),
  je('2026-02-15', 'Collect rest of receivable', ['1000', 1_000_000, 0], ['1100', 0, 1_000_000]),
  je('2026-02-20', 'Prepay insurance', ['1300', 240_000, 0], ['1000', 0, 240_000]),
];

test('trial balance balances', () => {
  const tb = trialBalance(chart(), sumsFor(entries));
  assert.equal(tb.balanced, true);
  assert.equal(tb.totalDebits, tb.totalCredits);
});

test('income statement 2025', () => {
  const is = incomeStatement(chart(), sumsFor(entries, { from: '2025-01-01', to: '2025-12-31' }));
  assert.equal(is.revenue.totalCents, 4_000_000);
  assert.equal(is.operatingExpenses.totalCents, 1_800_000);
  assert.equal(is.netIncomeCents, 2_200_000);
  assert.equal(is.check, 0);
});

test('income statement Jan-Feb 2026 with other expense', () => {
  const is = incomeStatement(chart(), sumsFor(entries, { from: '2026-01-01', to: '2026-02-28' }));
  assert.equal(is.revenue.totalCents, 250_000);
  assert.equal(is.operatingExpenses.totalCents, 12_345);
  assert.equal(is.otherExpenses.totalCents, 15_000);
  assert.equal(is.netIncomeCents, 250_000 - 12_345 - 15_000);
});

test('balance sheet: prior-year profit lands in retained earnings, no closing entry needed', () => {
  const bs = balanceSheet(chart(), sumsFor(entries, { to: '2026-02-28' }), sumsFor(entries, { to: '2025-12-31' }));
  assert.equal(bs.balanced, true, `check ${bs.check}`);
  const re = bs.equity.lines.find((l) => l.name === 'Retained Earnings');
  assert.equal(re.amountCents, 2_200_000);
  const cy = bs.equity.lines.find((l) => l.name === 'Net Income (current year)');
  assert.equal(cy.amountCents, 222_655);
  const accDep = bs.assets.lines.find((l) => l.code === '1590');
  assert.equal(accDep.amountCents, -600_000, 'contra asset reduces assets');
  // Cash: 50,000 -10,000 +30,000 -12,000 +2,500 -1,150 -3,000 +10,000 -2,400 = 63,950.00
  assert.equal(bs.assets.lines.find((l) => l.code === '1000').amountCents, 6_395_000);
});

test('balance sheet balances at every date', () => {
  for (const asOf of ['2025-01-02', '2025-06-30', '2025-12-31', '2026-01-01', '2026-01-31', '2026-02-28']) {
    const fyStart = asOf.slice(0, 4) + '-01-01';
    const before = String(Number(asOf.slice(0, 4)) - 1) + '-12-31';
    const bs = balanceSheet(chart(), sumsFor(entries, { to: asOf }), sumsFor(entries, { to: before }));
    assert.equal(bs.check, 0, `${asOf} (fy ${fyStart})`);
  }
});

test('cash flow (indirect) reconciles to change in cash', () => {
  const cf = cashFlowStatement(chart(), sumsFor(entries, { to: '2024-12-31' }), sumsFor(entries, { to: '2025-12-31' }));
  assert.equal(cf.balanced, true);
  assert.equal(cf.netIncomeCents, 2_200_000);
  // Operating: NI 22,000 + depreciation 6,000 - AR increase 10,000 = 18,000
  assert.equal(cf.operating.totalCents, 1_800_000);
  assert.equal(cf.investing.totalCents, -3_000_000);   // equipment
  assert.equal(cf.financing.totalCents, 7_000_000);    // owner 50,000 + loan 20,000
  assert.equal(cf.beginningCashCents, 0);
  assert.equal(cf.endingCashCents, 5_800_000);  // 50,000 - 10,000 + 30,000 - 12,000

  const cf26 = cashFlowStatement(chart(), sumsFor(entries, { to: '2025-12-31' }), sumsFor(entries, { to: '2026-02-28' }));
  assert.equal(cf26.balanced, true);
  assert.equal(cf26.beginningCashCents, 5_800_000);
  assert.equal(cf26.endingCashCents, 6_395_000);
  assert.equal(cf26.financing.totalCents, -400_000);   // loan principal -1,000, draw -3,000
});

test('cash flow: sale of equipment shows proceeds in investing, gain backed out of operating (board finding #1)', () => {
  const ents = [
    je('2025-01-01', 'Capital', ['1000', 2_000_000, 0], ['3000', 0, 2_000_000]),
    je('2025-01-02', 'Buy equipment', ['1500', 1_000_000, 0], ['1000', 0, 1_000_000]),
    je('2025-06-30', 'Depreciation', ['6100', 600_000, 0], ['1590', 0, 600_000]),
    // Sell for $5,000: cost 10,000, accumulated depreciation 6,000, gain 1,000
    je('2025-09-01', 'Sell equipment', ['1000', 500_000, 0], ['1590', 600_000, 0], ['1500', 0, 1_000_000], ['4950', 0, 100_000]),
  ];
  const cf = cashFlowStatement(chart(), sumsFor(ents, { to: '2025-06-30' }), sumsFor(ents, { to: '2025-12-31' }));
  assert.equal(cf.balanced, true);
  assert.equal(cf.netIncomeCents, 100_000);
  assert.equal(cf.operating.totalCents, 0);        // 1,000 NI − 1,000 gain
  assert.equal(cf.investing.totalCents, 500_000);  // proceeds
  const full = cashFlowStatement(chart(), new Map(), sumsFor(ents, { to: '2025-12-31' }));
  assert.equal(full.operating.adjustments.find((l) => l.name === 'Depreciation and amortization').amountCents, 600_000);
  assert.equal(full.operating.totalCents, 0);       // −5,000 NI... : NI = 1,000 − 6,000 = −5,000; +6,000 dep −1,000 gain = 0
  assert.equal(full.investing.totalCents, -500_000); // −10,000 purchase + 5,000 proceeds
  assert.equal(full.balanced, true);
});

test('cash flow: non-cash investing/financing is disclosed, not shown as cash (board finding #2)', () => {
  const ents = [je('2026-03-01', 'Truck financed 100%', ['1510', 800_000, 0], ['2700', 0, 800_000])];
  const nonCash = sumsFor(ents);
  const cf = cashFlowStatement(chart(), new Map(), sumsFor(ents), nonCash);
  assert.equal(cf.investing.totalCents, 0);
  assert.equal(cf.financing.totalCents, 0);
  assert.equal(cf.nonCashActivities.length, 2);
  assert.equal(cf.balanced, true);
});

test('trial balance (post-closing) agrees with the balance sheet in year two (board finding #3)', async () => {
  const { postClosingSums } = await import('../src/core/reports.js');
  const ents = [
    je('2024-12-15', 'FY25 sale', ['1000', 50_000, 0], ['4000', 0, 50_000]),   // July fiscal year
    je('2024-12-16', 'FY25 fee', ['6050', 1_000, 0], ['1000', 0, 1_000]),
    je('2025-08-15', 'FY26 sale', ['1000', 20_000, 0], ['4000', 0, 20_000]),
  ];
  const tb = trialBalance(chart(), postClosingSums(chart(), sumsFor(ents, { to: '2025-08-31' }), sumsFor(ents, { to: '2025-06-30' })));
  assert.equal(tb.balanced, true);
  assert.equal(tb.rows.find((r) => r.code === '4000').creditCents, 20_000);
  assert.equal(tb.rows.find((r) => r.code === '3900').creditCents, 49_000);
  assert.equal(tb.rows.find((r) => r.code === '6050'), undefined);
});
