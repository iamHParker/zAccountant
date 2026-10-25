import test from 'node:test';
import assert from 'node:assert/strict';
import { TAX_CATEGORIES, TAX_FORMS, FORM_FOR_ENTITY, suggestCategory, placeOf, taxSummary, necThresholdCents } from '../src/core/taxLines.js';
import { DEFAULT_CHART } from '../src/core/chartOfAccounts.js';
import { ENTITY_KEYS } from '../src/core/entityTypes.js';

test('every type of business has a return (or none for personal books), and every form places every category', () => {
  for (const k of ENTITY_KEYS) assert.ok(k in FORM_FOR_ENTITY, k);
  for (const [form, f] of Object.entries(TAX_FORMS)) {
    for (const cat of Object.keys(f.lines)) assert.ok(TAX_CATEGORIES[cat], `${form}: ${cat}`);
    for (const cat of Object.keys(TAX_CATEGORIES)) {
      const p = placeOf(form, cat);
      assert.ok(p.line || p.elsewhere, `${form}: ${cat}`);
      // An income category must never fall through to the "other deductions" line.
      if (TAX_CATEGORIES[cat].side === 'income') assert.notEqual(p, f.other, `${form}: ${cat}`);
    }
  }
});

test('the default chart gets sensible suggestions', () => {
  const s = (code) => suggestCategory(DEFAULT_CHART.find((a) => a.code === code));
  assert.equal(s('4100'), 'gross_receipts');
  assert.equal(s('6300'), 'rent_property');
  assert.equal(s('6410'), 'taxes_licenses');
  assert.equal(s('1000'), null, 'balance-sheet accounts have no tax line');
  assert.equal(suggestCategory({ code: '6300', name: 'Software subscriptions', type: 'expense', subtype: 'operating' }), 'office_expense', 'renamed: judged by name');
  assert.equal(suggestCategory({ code: '6720', name: 'Something odd', type: 'expense', subtype: 'operating' }), 'other_expense');
  assert.equal(suggestCategory({ code: '4300', name: 'Interest earned', type: 'revenue', subtype: 'other' }), 'interest_income');
});

test('tax summary groups accounts onto Schedule C lines', () => {
  const accounts = [
    { id: 'a', code: '4100', name: 'Service Revenue', type: 'revenue', subtype: 'operating', category: null },
    { id: 'b', code: '6000', name: 'Advertising', type: 'expense', subtype: 'operating', category: null },
    { id: 'c', code: '6150', name: 'Insurance', type: 'expense', subtype: 'operating', category: 'insurance' },
    { id: 'd', code: '6050', name: 'Bank Fees', type: 'expense', subtype: 'operating', category: null },
    { id: 'e', code: '4900', name: 'Interest Income', type: 'revenue', subtype: 'other', category: null },
    { id: 'f', code: '1000', name: 'Checking', type: 'asset', subtype: 'bank', category: null },
  ];
  const sums = new Map([
    ['a', { debitCents: 50000, creditCents: 1250000 }], // $12,500 earned, $500 credited back → 12,000.00
    ['b', { debitCents: 80000, creditCents: 0 }],        // 800.00
    ['c', { debitCents: 120000, creditCents: 0 }],       // 1,200.00
    ['d', { debitCents: 3500, creditCents: 0 }],         // 35.00 → line 27b
    ['e', { debitCents: 0, creditCents: 1234 }],         // 12.34 → Schedule B
    ['f', { debitCents: 999999, creditCents: 0 }],       // ignored
  ]);
  const s = taxSummary('schedule_c', accounts, sums);
  assert.deepEqual(s.lines.map((g) => [g.line, g.cents]), [['1', 1200000], ['8', 80000], ['15', 120000], ['27b', 3500]]);
  assert.deepEqual(s.elsewhere.map((g) => [g.note, g.cents]), [['Schedule B (Form 1040), not Schedule C', 1234]]);
  assert.equal(s.suggestedCount, 4, 'insurance was saved; the other four are suggestions');
  // 12,000.00 − (800 + 1,200 + 35) = 9,965.00
  assert.equal(s.ordinaryIncomeCents, 996500);
});

test('on Form 1120-S officer pay has its own line; rents share line 11', () => {
  const accounts = [
    { id: 'o', code: '6420', name: 'Officer salary', type: 'expense', subtype: 'payroll', category: null },
    { id: 'r1', code: '6300', name: 'Rent', type: 'expense', subtype: 'operating', category: 'rent_property' },
    { id: 'r2', code: '6310', name: 'Equipment rent', type: 'expense', subtype: 'operating', category: 'rent_equipment' },
  ];
  const sums = new Map([['o', { debitCents: 5000000, creditCents: 0 }], ['r1', { debitCents: 100, creditCents: 0 }], ['r2', { debitCents: 200, creditCents: 0 }]]);
  const s = taxSummary('form_1120s', accounts, sums);
  assert.deepEqual(s.lines.map((g) => [g.line, g.cents]), [['7', 5000000], ['11', 300]]);
});

test('1099-NEC threshold: $600 through 2025, $2,000 from 2026', () => {
  assert.deepEqual(necThresholdCents(2025), { cents: 60000, exact: true });
  assert.deepEqual(necThresholdCents(2026), { cents: 200000, exact: true });
  assert.deepEqual(necThresholdCents(2027), { cents: 200000, exact: false }, 'a later year uses the latest known amount and says so');
});
