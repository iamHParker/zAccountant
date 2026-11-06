// Bookings on a trip planned ahead (Homer, 2026-11-06): the flight, hotel and rental car booked from the Road page or
// the desk. A booking is a plan, not money; paying for it is a trip cost linked to it. Through HTTP with the runtime role.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { totpCode } from '../src/security/totp.js';

process.env.AUTH_RATE_LIMIT = '1000';

test('Trip bookings: plan a trip ahead from the phone and the desk', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase({ withAppRole: true });
  const server = createApp(db.appPool, { log: (l) => { if (process.env.SHOW_LOG) console.log(l); } }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { server.close(); await db.drop(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = (bearer = null) => {
    let cookie = '';
    const call = async (method, path, body) => {
      const r = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* file */ }
      return { status: r.status, body: json, text, type: r.headers.get('content-type') };
    };
    return { call };
  };
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  async function newUser(email) {
    const c = client();
    await c.call('POST', '/api/auth/signup', { email, name: email.split('@')[0], password: 'a long enough passphrase' });
    const setup = (await c.call('POST', '/api/auth/mfa/setup', {})).body;
    ok(await c.call('POST', '/api/auth/mfa/enable', { code: totpCode(setup.secret, Date.now()) }));
    return c;
  }

  const desk = await newUser('homer@example.com');
  const co = ok(await desk.call('POST', '/api/companies', { name: 'Parker Engineering', homeState: 'TX', fiscalYearStartMonth: 1 }), 201);
  const b = `/api/companies/${co.id}`;
  const A = Object.fromEntries(ok(await desk.call('GET', `${b}/accounts`)).map((a) => [a.code, a.id]));
  ok(await desk.call('POST', `${b}/jobs/import`, { text: '2601 Smith Residence\n2602 Lee Garage' }));
  const J = Object.fromEntries(ok(await desk.call('GET', `${b}/jobs`)).map((j) => [j.code, j.id]));

  const made = ok(await desk.call('POST', `${b}/road-keys`, { name: "Homer's iPhone" }), 201);
  const phone = client(made.url.split('#key=')[1]);
  const accounts = { expenseAccountId: A['6500'], paidFromAccountId: A['2100'] };

  // At the desk: a trip two weeks out, and its flight booked now. A booking is not in the books.
  const trip = ok(await desk.call('POST', `${b}/trips`, { name: 'Albuquerque, Nov 20-23', startDate: '2026-11-20', endDate: '2026-11-23',
    jobs: [{ jobId: J['2601'], share: '100' }] }), 201);
  const T = `${b}/trips/${trip.id}`;
  const bad = await desk.call('POST', `${T}/bookings`, { kind: 'airfare', startsOn: '2026-11-31', endsOn: '2026-11-19', startTime: '25:00', amount: '-4' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.details.length, 5); // the date, the last date, the time, the price, and who it is with
  const fly = ok(await desk.call('POST', `${T}/bookings`, { kind: 'airfare', vendor: 'Southwest', confirmation: 'K7QX2P', startsOn: '2026-11-20',
    startTime: '6:05 AM', endsOn: '2026-11-23', endTime: '5:40 PM', details: 'WN 1123 SAT-ABQ, WN 2210 ABQ-SAT', amount: '$412.30' }), 201);
  assert.equal(fly.bookings.length, 1);
  assert.deepEqual([fly.bookings[0].startTime, fly.bookings[0].endTime, fly.bookings[0].amountCents, fly.bookings[0].tripCostId], ['06:05', '17:40', 41230, null]);
  assert.equal(fly.totalCents, 0); // nothing in the books yet
  const flyId = fly.bookingId;
  const { rows: [{ n: entries }] } = await db.pool.query('SELECT count(*)::int AS n FROM journal_entries WHERE company_id = $1', [co.id]);

  // The phone sees the trip's bookings (the plan), with no accounts or amounts paid.
  const sum = ok(await phone.call('GET', '/api/road'));
  assert.match(sum.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(sum.bookings.length, 1);
  assert.equal(sum.bookings[0].confirmation, 'K7QX2P');
  assert.equal(sum.bookings[0].paid, false);
  assert.equal(sum.bookings[0].tripCostId, undefined);
  assert.equal(sum.bookingKinds.lodging, 'Hotel');

  // From the phone: another trip planned ahead, a hotel booked on it, and the airfare paid for the desk's flight.
  ok(await phone.call('POST', '/api/road/items', { clientId: 'trip-denver-01', kind: 'trip', data: { name: 'Denver, Dec 7-9', startDate: '2026-12-07',
    endDate: '2026-12-09', jobIds: [J['2602']] } }), 201);
  assert.equal((await phone.call('POST', '/api/road/items', { clientId: 'book-bad-01', kind: 'booking', data: { trip: { clientId: 'trip-denver-01' },
    kind: 'lodging', startsOn: '2026-12-07' } })).status, 400); // who is it with?
  ok(await phone.call('POST', '/api/road/items', { clientId: 'book-hotel-01', kind: 'booking', data: { trip: { clientId: 'trip-denver-01' },
    kind: 'lodging', vendor: 'Hilton Garden Inn', confirmation: '88231', startsOn: '2026-12-07', endsOn: '2026-12-09', amount: '389.00' } }), 201);
  ok(await phone.call('POST', '/api/road/items', { clientId: 'cost-air-abq', kind: 'cost', data: { trip: { id: trip.id }, booking: { id: flyId },
    date: '2026-11-06', kind: 'airfare', vendor: 'Southwest', amount: '412.30' } }), 201);
  // The hotel paid at check-out names the phone's own booking.
  ok(await phone.call('POST', '/api/road/items', { clientId: 'cost-hotel-den', kind: 'cost', data: { trip: { clientId: 'trip-denver-01' },
    booking: { clientId: 'book-hotel-01' }, date: '2026-12-09', kind: 'lodging', vendor: 'Hilton Garden Inn', amount: '401.17' } }), 201);

  // Accept all: the trip first, then the booking (no accounts to choose), then the costs, linked to what they paid.
  const inbox = ok(await desk.call('GET', `${b}/road-items`));
  assert.deepEqual(inbox.map((i) => i.kind).sort(), ['booking', 'cost', 'cost', 'trip']);
  const den = inbox.filter((i) => i.trip?.name === 'Denver, Dec 7-9');
  const r = ok(await desk.call('POST', `${b}/road-items/accept-all`, { itemIds: den.map((i) => i.id), ...accounts }));
  assert.equal(r.accepted, 3);
  const denId = r.items.find((i) => i.kind === 'trip').tripId;
  const denver = ok(await desk.call('GET', `${b}/trips/${denId}`));
  assert.equal(denver.bookings.length, 1);
  assert.equal(denver.bookings[0].vendor, 'Hilton Garden Inn');
  assert.equal(denver.bookings[0].amountCents, 38900);          // the price quoted…
  assert.equal(denver.bookings[0].paidCents, 40117);            // …and what was paid (taxes added at check-out)
  assert.equal(denver.bookings[0].tripCostId, denver.costs[0].id);
  const air = inbox.find((i) => i.data.kind === 'airfare');
  ok(await desk.call('POST', `${b}/road-items/${air.id}/accept`, accounts));
  let t1 = ok(await desk.call('GET', T));
  assert.equal(t1.bookings[0].tripCostId, t1.costs[0].id);
  assert.equal(t1.totalCents, 41230);
  const { rows: [{ n: after }] } = await db.pool.query('SELECT count(*)::int AS n FROM journal_entries WHERE company_id = $1', [co.id]);
  assert.equal(after, entries + 2); // two costs posted; the bookings posted nothing
  // The phone now says it's paid, and knows which of the trips is the one it sent.
  const sum2 = ok(await phone.call('GET', '/api/road'));
  assert.equal(sum2.bookings.find((x) => x.id === flyId).paid, true);
  assert.equal(sum2.bookings.find((x) => x.tripId === denId).fromClientId, 'book-hotel-01');
  assert.equal(sum2.trips.find((x) => x.id === denId).fromClientId, 'trip-denver-01');

  // A booking already paid can't be paid twice…
  const twice = await desk.call('POST', `${T}/costs`, { date: '2026-11-07', kind: 'airfare', amount: '412.30', bookingId: flyId, ...accounts });
  assert.equal(twice.status, 400);
  // …a corrected cost carries the link along…
  t1 = ok(await desk.call('PUT', `${b}/trip-costs/${t1.costs[0].id}`, { date: '2026-11-06', kind: 'airfare', vendor: 'Southwest', amount: '432.30', ...accounts }));
  const fixed = t1.costs.find((x) => x.status === 'posted');
  assert.equal(t1.bookings[0].tripCostId, fixed.id);
  assert.equal(t1.bookings[0].paidCents, 43230);
  // …and a cost voided without a correction leaves the booking unpaid again.
  t1 = ok(await desk.call('POST', `${b}/trip-costs/${fixed.id}/void`, {}));
  assert.equal(t1.bookings[0].tripCostId, null);

  // Change a booking (a later flight), cancel it, book it again. Each change is audited.
  t1 = ok(await desk.call('PATCH', `${T}/bookings/${flyId}`, { kind: 'airfare', vendor: 'Southwest', confirmation: 'K7QX2P', startsOn: '2026-11-21', startTime: '9:15 AM' }));
  assert.deepEqual([t1.bookings[0].startsOn, t1.bookings[0].startTime, t1.bookings[0].endsOn], ['2026-11-21', '09:15', null]);
  t1 = ok(await desk.call('PATCH', `${T}/bookings/${flyId}`, { status: 'cancelled' }));
  assert.equal(t1.bookings[0].status, 'cancelled');
  assert.equal(t1.bookings[0].vendor, 'Southwest');
  assert.equal((await desk.call('PATCH', `${T}/bookings/${flyId}`, { status: 'lost' })).status, 400);
  assert.equal((await desk.call('PATCH', `${b}/trips/${denId}/bookings/${flyId}`, { status: 'booked' })).status, 404); // not on that trip
  const { rows: audit } = await db.pool.query("SELECT action FROM audit_log WHERE company_id = $1 AND entity = 'trip_booking' ORDER BY seq", [co.id]);
  assert.deepEqual(audit.map((a) => a.action), ['create', 'create', 'paid', 'paid', 'update', 'cancel']);
  assert.equal(ok(await desk.call('GET', `${b}/trips`)).find((x) => x.id === trip.id).bookingCount, 0); // cancelled ones don't count
});
