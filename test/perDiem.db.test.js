// Per diem (Homer, 2026-11-23: "I can't add a per diem for food"). A meals per diem is days × a daily rate, with
// no receipt: a saved "by the day" invoice rate, and a trip cost that each project's invoice pulls in at its share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import * as ledger from '../src/services/ledgerService.js';
import * as arap from '../src/services/arapService.js';
import * as time from '../src/services/timesheetService.js';
import * as projects from '../src/services/projectService.js';
import * as trips from '../src/services/tripService.js';
import * as setup from '../src/services/invoiceSetupService.js';
import { perDiemAmount } from '../src/core/money.js';

test('per diem: days × daily rate, half-up once', () => {
  // 3 days × $68.00 = $204.00; 2.75 days (75% first and last day) × $68 = 275 × 6800 / 100 = 18700 → $187.00.
  assert.deepEqual(perDiemAmount('3', '68.00'), { days: '3', dayRateCents: 6800, amountCents: 20400 });
  assert.deepEqual(perDiemAmount('2.75', '$68'), { days: '2.75', dayRateCents: 6800, amountCents: 18700 });
  // 1.5 days × $59.33 = 150 × 5933 / 100 = 8899.5 → 8900 (half-up).
  assert.equal(perDiemAmount('1.5', '59.33').amountCents, 8900);
  assert.equal(perDiemAmount('2.50', '10').days, '2.5');
  assert.equal(perDiemAmount('3.00', '10').days, '3');
  for (const [d, r] of [['0', '68'], ['3', '0'], ['1.255', '68'], ['three', '68'], ['3', '68.001'], ['', '68'], ['3', '']]) {
    assert.equal(perDiemAmount(d, r), null, `${d} × ${r}`);
  }
});

test('per diem on a trip: posts, splits by project share, pulls into the invoice; per-day rate', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  t.after(() => db.drop());
  const { pool } = db;
  const co = await ledger.createCompany(pool, { name: 'Parker Engineering', homeState: 'TX' });
  const A = Object.fromEntries((await ledger.listAccounts(pool, co.id)).map((a) => [a.code, a.id]));
  const nhwic = await arap.createContact(pool, co.id, { kind: 'customer', name: 'NHWIC' });
  const richards = await time.createJob(pool, co.id, { name: '26-151 Richards', code: '26-151', customerId: nhwic.id });
  const other = await time.createJob(pool, co.id, { name: '26-152 Other', code: '26-152', customerId: nhwic.id });
  let trip = await trips.createTrip(pool, co.id, { name: 'OKC Nov 16-18', startDate: '2026-11-16', endDate: '2026-11-18',
    jobs: [{ jobId: richards.id, share: '60' }, { jobId: other.id, share: '40' }] });
  const owner = { expenseAccountId: A['6500'], paidFromAccountId: A['3000'] };

  await assert.rejects(trips.addTripCost(pool, co.id, trip.id, { date: '2026-11-18', kind: 'per_diem', days: '3', ...owner }),
    (e) => e.details.some((d) => /rate per day/.test(d)));
  // No description typed: the words say what it is, so the invoice line explains itself.
  trip = await trips.addTripCost(pool, co.id, trip.id, { date: '2026-11-18', kind: 'per_diem', days: '3', dayRate: '68.00', ...owner });
  const pd = trip.costs.find((c) => c.kind === 'per_diem');
  assert.deepEqual([pd.description, pd.days, pd.dayRateCents, pd.amountCents], ['Meals per diem, 3 days × $68.00', '3', 6800, 20400]);
  // Correcting it to 2.75 days writes the words again (they were written by the app, not typed).
  trip = await trips.replaceTripCost(pool, co.id, pd.id, { date: '2026-11-18', kind: 'per_diem', days: '2.75', dayRate: '68', description: pd.description, ...owner });
  const fixed = trip.costs.find((c) => c.kind === 'per_diem' && c.status === 'posted');
  assert.deepEqual([fixed.description, fixed.amountCents], ['Meals per diem, 2.75 days × $68.00', 18700]);
  // A typed description stays.
  const typed = await trips.addTripCost(pool, co.id, trip.id, { date: '2026-11-18', kind: 'per_diem', days: '1', dayRate: '20', description: 'Snacks, site day', ...owner });
  assert.equal(typed.costs.find((c) => c.id === typed.costId).description, 'Snacks, site day');

  // Richards carries 60%: 0.6 × $187.00 = $112.20.
  const pull = await projects.listUnbilled(pool, co.id, { jobId: richards.id });
  const row = pull.tripCosts.find((x) => x.id === fixed.id);
  assert.deepEqual([row.kind, row.days, row.dayRateCents, row.quantity, row.shareCents], ['per_diem', '2.75', 6800, '0.6', 11220]);

  // A saved "by the day" rate: untaxed unless ticked; days × rate on the invoice.
  const item = await setup.createItem(pool, co.id, { name: 'Per diem (meals)', kind: 'per_day', rate: '68.00', accountId: A['4000'] });
  assert.deepEqual([item.kind, item.rateCents, item.taxable], ['per_day', 6800, false]);
  await assert.rejects(setup.createItem(pool, co.id, { name: 'Bad', kind: 'per_week', accountId: A['4000'] }), /per_day/);
  const inv = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: nhwic.id, number: '2611', date: '2026-11-23', jobId: richards.id, taxRate: '8.25',
    lines: [
      { accountId: A['4000'], description: 'Drafting', quantity: '1', unitPrice: '100.00', taxable: true, serviceDate: '2026-11-19' },
      { accountId: A['4000'], itemId: item.id, description: 'Meals per diem, OKC', quantity: '3', unitPrice: '68.00', serviceDate: '2026-11-18' },
      { accountId: A['4000'], description: fixed.description, quantity: row.quantity, unitPrice: '187.00', serviceDate: '2026-11-18', tripCostId: fixed.id, jobId: richards.id },
    ] });
  // Per diems 3 × $68.00 = $204.00 + $112.20 = $316.20, untaxed; drafting $100.00 + 8.25% = $108.25. Total $424.45.
  assert.equal(Number(inv.totalCents), 42445);
  assert.equal((await projects.listUnbilled(pool, co.id, { jobId: richards.id })).tripCosts.some((x) => x.id === fixed.id), false);
  // The starter list now includes a per diem.
  assert.ok(setup.STARTER_ITEMS.some((s) => s.kind === 'per_day'));
});
