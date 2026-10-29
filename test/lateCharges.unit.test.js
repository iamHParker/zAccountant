// Late charges: one month of simple interest on what is past its grace period, plus the late-statement fee.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lateSettings, graceEnds, monthlyInterest, chargesFor } from '../src/core/lateCharges.js';

const S = lateSettings({ late_apr: '6', late_fee_cents: 3500, late_grace_days: 30, late_holiday_grace_days: 60 });

test('one month of interest at 6% a year, rounded half-up', () => {
  assert.equal(monthlyInterest(100000, S.aprPpm), 500); // 1,000.00 × 0.06 ÷ 12 = 5.00
  assert.equal(monthlyInterest(123457, S.aprPpm), 617); // 1,234.57 × 0.005 = 6.17285 → 6.17
  assert.equal(monthlyInterest(10100, S.aprPpm), 51); // 101.00 × 0.005 = 0.505 → 0.51 (half-up)
  assert.equal(monthlyInterest(100000, lateSettings({ late_apr: '18.5' }).aprPpm), 1542); // 1,000 × 0.185 ÷ 12 = 15.4167
  assert.equal(monthlyInterest(100000, 0), 0);
});

test('grace: 30 days after the due date; 60 for a homeowner when the invoice fell due in November or December', () => {
  assert.equal(graceEnds('2026-10-15', false, S), '2026-11-14');
  assert.equal(graceEnds('2026-11-15', false, S), '2026-12-15'); // a company: 30 days even in November
  assert.equal(graceEnds('2026-11-15', true, S), '2027-01-14'); // a homeowner: 60 days
  assert.equal(graceEnds('2026-12-31', true, S), '2027-03-01');
  assert.equal(graceEnds('2027-01-05', true, S), '2027-02-04'); // January: back to 30
});

test('what a customer is charged: past-grace invoices only, never plans, exempt invoices or late charges', () => {
  const inv = (number, dueDate, balanceCents, more = {}) => ({ id: number, number, dueDate, balanceCents, planCount: null, noLateCharges: false, lateChargeMonth: null, ...more });
  const list = [
    inv('2601', '2026-09-01', 100000), // grace ended Oct 1: charged
    inv('2602', '2026-10-20', 50000), // grace ends Nov 19: not yet on Nov 15
    inv('2603', '2026-08-01', 70000, { planCount: 6 }), // on a payment plan: never
    inv('2604', '2026-08-01', 30000, { noLateCharges: true }),
    inv('LC1', '2026-08-01', 3500, { lateChargeMonth: '2026-09' }), // no interest on interest
    inv('2605', '2026-08-01', 0), // paid
  ];
  const ch = chargesFor({ isHomeowner: false, noLateCharges: false }, list, S, '2026-11-15');
  assert.deepEqual(ch.invoices.map((d) => d.number), ['2601']);
  assert.deepEqual([ch.pastDueCents, ch.interestCents, ch.feeCents, ch.totalCents], [100000, 500, 3500, 4000]);
  // A customer marked "no late charges", or nothing past grace, owes nothing extra (and no fee).
  assert.equal(chargesFor({ noLateCharges: true }, list, S, '2026-11-15').totalCents, 0);
  assert.equal(chargesFor({}, [list[1]], S, '2026-11-15').totalCents, 0);
  // Off until a rate or a fee is set.
  assert.equal(chargesFor({}, list, lateSettings({}), '2026-11-15').totalCents, 0);
  // Fee only (no rate): 35.00.
  assert.deepEqual(chargesFor({}, list, lateSettings({ late_fee_cents: 3500 }), '2026-11-15').totalCents, 3500);
});
