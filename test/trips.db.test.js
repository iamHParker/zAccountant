import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import * as ledger from '../src/services/ledgerService.js';
import * as arap from '../src/services/arapService.js';
import * as time from '../src/services/timesheetService.js';
import * as projects from '../src/services/projectService.js';
import * as trips from '../src/services/tripService.js';
import { accountSums } from '../src/services/reportService.js';

const net = async (pool, companyId, accountId) => { const x = (await accountSums(pool, companyId)).get(accountId); return Number(x.debitCents) - Number(x.creditCents); };

test('trip shares: percent, invoice quantity, shared hours', () => {
  assert.deepEqual(['60', '33.33', '12.5%', '0', '100', '100.01', '-5', 'abc'].map(trips.percentToBp), [6000, 3333, 1250, 0, 10000, null, null, null]);
  assert.deepEqual([6000, 3333, 1250, 500, 10000].map(trips.bpToQuantity), ['0.6', '0.3333', '0.125', '0.05', '1']);
  assert.equal(projects.sharedHoursQuantity(360, 6000), '3.6'); // 6 h travel × 60% = 3.6 h
  assert.equal(projects.sharedHoursQuantity(50, 3333), '0.2778'); // 50 × 3333 / 60 = 2777.5 → 2778 (half-up)
  // Mileage at a typed rate: 212.4 mi × $0.725 = $153.99 (21240 × 7250 / 10000 = 15399); 100 mi × $0.70 = $70.00.
  assert.equal(trips.mileageAmount('212.4', '0.725').amountCents, 15399);
  assert.deepEqual(trips.mileageAmount('100', '.70'), { miles: '100', rateCentsText: '70', amountCents: 7000 });
  assert.equal(trips.mileageAmount('12.345', '0.70'), null); // miles to 2 decimals at most
});

// Homer, 2026-10-25: a major client carries most of a trip, a few smaller jobs a little; the shares need not add to 100%.
test('trips: costs and travel time shared by project, billed once per project', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  t.after(() => db.drop());
  const { pool } = db;
  const co = await ledger.createCompany(pool, { name: 'Parker Engineering', homeState: 'TX' });
  const A = Object.fromEntries((await ledger.listAccounts(pool, co.id)).map((a) => [a.code, a.id]));
  const { rows: [u] } = await pool.query("INSERT INTO users (email, name, password_hash) VALUES ('homer@example.com', 'Homer', 'x') RETURNING id");
  await pool.query("INSERT INTO memberships (company_id, user_id, role) VALUES ($1, $2, 'owner')", [co.id, u.id]);
  const viewer = { userId: u.id, can: () => true, departmentId: null };
  const dwh = await arap.createContact(pool, co.id, { kind: 'customer', name: 'DWH - SATX' });
  const lee = await arap.createContact(pool, co.id, { kind: 'customer', name: 'Lee family' });
  const big = await time.createJob(pool, co.id, { name: '2601 Smith Residence', code: '2601', customerId: dwh.id });
  const small = await time.createJob(pool, co.id, { name: '2602 Lee Garage', code: '2602', customerId: lee.id });
  const other = await time.createJob(pool, co.id, { name: '2603 Other', code: '2603' });

  await assert.rejects(trips.createTrip(pool, co.id, { name: 'Dallas', startDate: '2026-10-04',
    jobs: [{ jobId: big.id, share: '80' }, { jobId: small.id, share: '30' }] }), (e) => e.details.some((d) => /110%/.test(d)));
  let trip = await trips.createTrip(pool, co.id, { name: 'Dallas, Oct 4-6', startDate: '2026-10-04', endDate: '2026-10-06',
    jobs: [{ jobId: big.id, share: '80' }, { jobId: small.id, share: '10' }] });
  assert.deepEqual(trip.jobs.map((j) => [j.jobCode, j.share]), [['2601', '80'], ['2602', '10']]);
  assert.equal(trip.sharePercent, '90'); // 10% not billed: Homer carries it

  // Airfare on the credit card; a hotel paid personally. Each posts Dr Travel, Cr what paid for it.
  const card = { expenseAccountId: A['6500'], paidFromAccountId: A['2100'] };
  trip = await trips.addTripCost(pool, co.id, trip.id, { date: '2026-10-04', vendor: 'Southwest', description: 'Airfare SAT-DAL', amount: '412.30', ...card });
  trip = await trips.addTripCost(pool, co.id, trip.id, { date: '2026-10-05', vendor: 'Hilton', description: 'Hotel, 2 nights', amount: '389.00',
    expenseAccountId: A['6500'], paidFromAccountId: A['3000'] });
  assert.equal(trip.totalCents, 80130);
  await assert.rejects(trips.addTripCost(pool, co.id, trip.id, { date: '2026-10-05', description: 'x', amount: '5', expenseAccountId: A['4000'], paidFromAccountId: A['2100'] }), /not valid/);
  assert.equal(await net(pool, co.id, A['6500']), 80130);
  assert.equal(await net(pool, co.id, A['2100']), -41230); // owed on the card
  assert.equal(await net(pool, co.id, A['3000']), -38900); // put in by the owner
  trip = await trips.addTravelTime(pool, co.id, viewer, trip.id, { date: '2026-10-04', hours: '6', notes: 'Drive to Dallas' });
  assert.equal(trip.time[0].hours, '6.00');

  const pull = await projects.listUnbilled(pool, co.id, { jobId: big.id });
  // 80% of $412.30 = $329.84; 80% of $389.00 = $311.20; 80% of 6 h = 4.8 h.
  assert.deepEqual(pull.tripCosts.map((x) => [x.description, x.quantity, x.shareCents]), [['Airfare SAT-DAL', '0.8', 32984], ['Hotel, 2 nights', '0.8', 31120]]);
  assert.deepEqual(pull.time.map((x) => [x.quantity, x.lineJobId === big.id, x.tripName]), [['4.8', true, 'Dallas, Oct 4-6']]);
  assert.equal((await projects.listUnbilled(pool, co.id, { jobId: other.id })).tripCosts.length, 0);

  const line = (x, extra = {}) => ({ accountId: A['4000'], description: x.description ?? x.notes, quantity: x.quantity, unitPrice: x.amountCents ?? '150',
    serviceDate: x.date, jobId: big.id, ...extra });
  const inv = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: dwh.id, number: '2601', date: '2026-10-10', jobId: big.id, lines: [
    line(pull.tripCosts[0], { tripCostId: pull.tripCosts[0].id }),
    // Override on the invoice: bill 75% of the hotel instead of 80%.
    line(pull.tripCosts[1], { tripCostId: pull.tripCosts[1].id, quantity: '0.75' }),
    line(pull.time[0], { timeEntryId: pull.time[0].id, unitPrice: '150' })] });
  // $329.84 + 0.75 × $389.00 = $291.75 + 4.8 h × $150 = $720.00 → $1,341.59.
  assert.equal(inv.totalCents, 134159);

  await t.test("the big project's share is billed; the small one's is still waiting", async () => {
    const after = await projects.listUnbilled(pool, co.id, { jobId: big.id });
    assert.deepEqual([after.tripCosts.length, after.time.length], [0, 0]);
    const lees = await projects.listUnbilled(pool, co.id, { jobId: small.id });
    assert.deepEqual(lees.tripCosts.map((x) => x.shareCents), [4123, 3890]); // 10%: $41.23, $38.90
    assert.equal(lees.time[0].quantity, '0.6');
    await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: lee.id, date: '2026-10-10', lines: lees.tripCosts.map((x) =>
      ({ accountId: A['4000'], quantity: x.quantity, unitPrice: x.amountCents, tripCostId: x.id, jobId: small.id })) });
  });

  await t.test('billed once per project, and only for projects on the trip', async () => {
    const again = { accountId: A['4000'], quantity: '0.8', unitPrice: 41230, tripCostId: pull.tripCosts[0].id, jobId: big.id };
    await assert.rejects(arap.createDocument(pool, co.id, { kind: 'invoice', contactId: dwh.id, date: '2026-10-11', lines: [again] }),
      (e) => e.details.some((d) => /already billed on invoice 2601/.test(d)));
    await assert.rejects(arap.createDocument(pool, co.id, { kind: 'invoice', contactId: dwh.id, date: '2026-10-11', lines: [{ ...again, jobId: other.id }] }),
      (e) => e.details.some((d) => /not for this project/.test(d)));
    await assert.rejects(arap.createDocument(pool, co.id, { kind: 'invoice', contactId: dwh.id, date: '2026-10-11', lines: [{ accountId: A['4000'], amount: '5', jobId: big.id }] }),
      (e) => e.details.some((d) => /only a trip/.test(d)));
    // The database refuses it too.
    const blank = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: dwh.id, date: '2026-10-11', lines: [{ accountId: A['4000'], amount: '1' }] });
    await assert.rejects(pool.query(`INSERT INTO document_lines (company_id, document_id, account_id, quantity, unit_price_cents, amount_cents, trip_cost_id, job_id)
      VALUES ($1, $2, $3, '1', 1, 1, $4, $5)`, [co.id, blank.id, A['4000'], pull.tripCosts[0].id, big.id]), /already billed/);
    await assert.rejects(pool.query(`INSERT INTO document_lines (company_id, document_id, account_id, quantity, unit_price_cents, amount_cents, trip_cost_id, job_id)
      VALUES ($1, $2, $3, '1', 1, 1, $4, $5)`, [co.id, blank.id, A['4000'], pull.tripCosts[0].id, other.id]), /not on the trip/);
    await arap.voidDocument(pool, co.id, blank.id);
  });

  await t.test('a late toll is added; a billed cost and billed travel time are locked', async () => {
    trip = await trips.addTripCost(pool, co.id, trip.id, { date: '2026-10-20', vendor: 'NTTA', description: 'Tolls (late)', amount: '18.40', ...card });
    assert.deepEqual((await projects.listUnbilled(pool, co.id, { jobId: big.id })).tripCosts.map((x) => x.shareCents), [1472]); // 80% of $18.40
    const air = trip.costs.find((x) => x.description === 'Airfare SAT-DAL');
    assert.deepEqual(air.billed.map((b) => b.number).sort(), ['1001', '2601']);
    await assert.rejects(trips.voidTripCost(pool, co.id, air.id), /billed on invoice/);
    await assert.rejects(trips.removeTravelTime(pool, co.id, viewer, trip.id, trip.time[0].id), /billed on invoice 2601/);
    await assert.rejects(trips.updateTrip(pool, co.id, trip.id, { jobs: [{ jobId: small.id, share: '10' }] }), (e) => e.details.some((d) => /already billed part/.test(d)));
    // CPA review B4: a project that has billed keeps its share too (later pulls would bill more or less than 100%).
    await assert.rejects(trips.updateTrip(pool, co.id, trip.id, { jobs: [{ jobId: big.id, share: '70' }, { jobId: small.id, share: '10' }] }),
      (e) => e.details.some((d) => /share stays 80%/.test(d)));
  });

  await t.test('edit a cost: void + corrected copy, receipt photo moves along', async () => {
    const toll = trip.costs.find((x) => x.description === 'Tolls (late)');
    const png = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')}`;
    await trips.addCostPhoto(pool, co.id, toll.id, { picture: png });
    trip = await trips.replaceTripCost(pool, co.id, toll.id, { date: '2026-10-20', vendor: 'NTTA', description: 'Tolls (late)', amount: '21.15', ...card });
    const fixed = trip.costs.find((x) => x.status === 'posted' && x.description === 'Tolls (late)');
    assert.equal(fixed.amountCents, 2115);
    assert.equal(fixed.photoCount, 1);
    assert.equal(trip.costs.find((x) => x.id === toll.id).replacedById, fixed.id);
    assert.equal(trip.totalCents, 41230 + 38900 + 2115);
    assert.equal(await net(pool, co.id, A['6500']), 41230 + 38900 + 2115);
    // Mileage in your own car, paid personally: 150 mi × $0.70 = $105.00, and the tolls on the way.
    trip = await trips.addTripCost(pool, co.id, trip.id, { date: '2026-10-06', kind: 'mileage', miles: '150', mileRate: '0.70',
      expenseAccountId: A['6500'], paidFromAccountId: A['3000'] });
    const miles = trip.costs.find((x) => x.kind === 'mileage');
    assert.deepEqual([miles.description, miles.amountCents, miles.miles, miles.mileRateCents], ['Mileage', 10500, '150', '70']);
    await assert.rejects(trips.addTripCost(pool, co.id, trip.id, { date: '2026-10-06', kind: 'mileage', miles: '150', amount: '5', ...card }), /not valid/);
    // A trip cost's entry can't be reversed from the journal; only from the trip.
    await assert.rejects(ledger.reverseEntry(pool, co.id, (await pool.query('SELECT journal_entry_id FROM trip_costs WHERE id = $1', [fixed.id])).rows[0].journal_entry_id), /Trips tab/);
  });
});
