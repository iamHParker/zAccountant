// Payment plans: the schedule adds up to the invoice exactly, and only payments past their own date are late.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planSchedule, planStatus, addMonths, cleanPlan } from '../src/core/paymentPlan.js';

test('the total splits evenly; the odd cents go one each to the first payments', () => {
  // 1,000.00 / 3 = 333.33 rem 0.01 → 333.34, 333.33, 333.33 (sum 1,000.00)
  assert.deepEqual(planSchedule(100000, 3, '2026-11-01').map((p) => [p.dueDate, p.amountCents]),
    [['2026-11-01', 33334], ['2026-12-01', 33333], ['2027-01-01', 33333]]);
  // 2,000.05 / 8 = 250.00 rem 0.05 → five of 250.01 and three of 250.00
  const s = planSchedule(200005, 8, '2026-11-15');
  assert.equal(s.reduce((t, p) => t + p.amountCents, 0), 200005);
  assert.deepEqual(s.map((p) => p.amountCents), [25001, 25001, 25001, 25001, 25001, 25000, 25000, 25000]);
});

test('the 31st becomes the last day of a shorter month', () => {
  assert.deepEqual([1, 2, 3, 13].map((n) => addMonths('2026-01-31', n)), ['2026-02-28', '2026-03-31', '2026-04-30', '2027-02-28']);
});

test('payments pay off the earliest plan payments; only those past their date are late', () => {
  // 8 × 250.00 = 2,000.00, due Nov 1 … Jun 1. Paid 600.00 by Feb 15: Nov, Dec paid, Jan 100.00 of 250.00.
  const st = planStatus(200000, 8, '2026-11-01', 60000, '2027-02-15');
  assert.deepEqual(st.schedule.slice(0, 4).map((p) => [p.paidCents, p.balanceCents]), [[25000, 0], [25000, 0], [10000, 15000], [0, 25000]]);
  // Late: rest of Jan (150.00) + Feb 1 (250.00) = 400.00. The other 1,000.00 is not due yet.
  assert.equal(st.pastDueCents, 40000);
  assert.deepEqual(st.next, { n: 3, dueDate: '2027-01-01', amountCents: 15000 });
  // On schedule: paid 500.00 by Dec 20 → nothing late.
  assert.equal(planStatus(200000, 8, '2026-11-01', 50000, '2026-12-20').pastDueCents, 0);
  // Due today is not late yet.
  assert.equal(planStatus(200000, 8, '2026-11-01', 0, '2026-11-01').pastDueCents, 0);
});

test('a plan typed on the form is checked', () => {
  const errors = [];
  assert.equal(cleanPlan(null, '2026-10-01', errors), null);
  assert.equal(cleanPlan({ count: '' }, '2026-10-01', errors), null);
  assert.deepEqual(cleanPlan({ count: '8', firstDue: '2026-11-01' }, '2026-10-01', errors), { count: 8, firstDue: '2026-11-01' });
  cleanPlan({ count: 1, firstDue: '2026-11-01' }, '2026-10-01', errors);
  cleanPlan({ count: 5, firstDue: '2026-09-01' }, '2026-10-01', errors);
  assert.deepEqual(errors, ['a payment plan has 2 to 60 payments', 'the first plan payment must be due on or after the invoice date']);
});
