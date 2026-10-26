// The Road page: a phone's limited key sends trips, costs (with receipt photos) and travel time into an inbox;
// they reach the books only when accepted at the desk. Through HTTP with the restricted runtime role.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { totpCode } from '../src/security/totp.js';
import { evenShares } from '../src/services/roadService.js';

process.env.AUTH_RATE_LIMIT = '1000';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('even shares: hundredths of a percent, leftovers to the first projects', () => {
  assert.deepEqual(evenShares(2), [5000, 5000]);
  assert.deepEqual(evenShares(3), [3334, 3333, 3333]); // 33.34 + 33.33 + 33.33 = 100.00
  assert.deepEqual(evenShares(7).reduce((a, b) => a + b, 0), 10000);
  assert.deepEqual(evenShares(0), []);
});

test('Road page: phone key, inbox, review at the desk', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
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

  // A key for the phone: the link carries it after the #; only its hash is stored.
  assert.equal((await desk.call('POST', `${b}/road-keys`, { name: '' })).status, 400);
  const made = ok(await desk.call('POST', `${b}/road-keys`, { name: "Homer's iPhone" }), 201);
  assert.match(made.url, /\/road#key=zr_[A-Za-z0-9_-]{43}$/);
  assert.match(made.qrSvg, /^<svg/);
  const token = made.url.split('#key=')[1];
  const { rows: [stored] } = await db.pool.query('SELECT token_hash FROM road_keys WHERE id = $1', [made.id]);
  assert.notEqual(stored.token_hash, token);
  assert.equal(ok(await desk.call('GET', `${b}/road-keys`)).length, 1);

  const phone = client(token);
  // What the phone can see: names of open trips and projects, nothing about money.
  const summary = ok(await phone.call('GET', '/api/road'));
  assert.equal(summary.company, 'Parker Engineering');
  assert.deepEqual(summary.projects.map((p) => p.code), ['2601', '2602']);
  assert.deepEqual(Object.keys(summary.projects[0]).sort(), ['code', 'id', 'name']);
  // …and nothing else: the key is no session, and a bad key is refused.
  assert.equal((await phone.call('GET', `${b}/accounts`)).status, 401);
  assert.equal((await phone.call('GET', '/api/companies')).status, 401);
  assert.equal((await client('zr_' + 'x'.repeat(43)).call('GET', '/api/road')).status, 401);

  // On the road: a new trip with one project picked and one new project number typed.
  const trip = { clientId: 'trip-dallas-01', kind: 'trip', data: { name: 'Dallas, Oct 4-6', startDate: '2026-10-04', endDate: '2026-10-06',
    jobIds: [J['2601']], newProjects: ['2610 Garcia Barn'] } };
  // A cost for a trip the server hasn't seen yet is refused (the phone sends trips first).
  assert.equal((await phone.call('POST', '/api/road/items', { clientId: 'cost-air-01', kind: 'cost',
    data: { trip: { clientId: 'trip-dallas-01' }, date: '2026-10-04', kind: 'airfare', amount: '412.30' } })).status, 400);
  ok(await phone.call('POST', '/api/road/items', trip), 201);
  assert.equal(ok(await phone.call('POST', '/api/road/items', trip), 201).duplicate, true); // resent after a dropped answer
  const ref = { clientId: 'trip-dallas-01' };
  ok(await phone.call('POST', '/api/road/items', { clientId: 'cost-air-01', kind: 'cost',
    data: { trip: ref, date: '2026-10-04', kind: 'airfare', vendor: 'Southwest', amount: '412.30' } }), 201);
  ok(await phone.call('POST', '/api/road/items/cost-air-01/photos', { clientId: 'photo-air-01', picture: PNG }), 201);
  assert.equal(ok(await phone.call('POST', '/api/road/items/cost-air-01/photos', { clientId: 'photo-air-01', picture: PNG }), 201).duplicate, true);
  ok(await phone.call('POST', '/api/road/items', { clientId: 'cost-miles-01', kind: 'cost',
    data: { trip: ref, date: '2026-10-06', kind: 'mileage', miles: '150', mileRate: '0.70', description: 'Site visits' } }), 201);
  ok(await phone.call('POST', '/api/road/items', { clientId: 'time-drive-01', kind: 'time', data: { trip: ref, date: '2026-10-04', hours: '6', notes: 'Drive SAT to DAL' } }), 201);
  // Day 2 from the clock: 7:30 AM to 5:45 PM = 10:15, less 1:15 of breaks = 9:00. The phone's own "hours" is not trusted.
  ok(await phone.call('POST', '/api/road/items', { clientId: 'time-day2-01', kind: 'time',
    data: { trip: ref, date: '2026-10-05', start: '07:30', end: '17:45', breaks: '1:15', hours: '1' } }), 201);
  const badBreaks = await phone.call('POST', '/api/road/items', { clientId: 'time-bad-001', kind: 'time',
    data: { trip: ref, date: '2026-10-05', start: '07:30', end: '17:45', breaks: 'lunch' } });
  assert.equal(badBreaks.status, 400);
  assert.match(badBreaks.body.details.join(' '), /breaks must be like 0:45/);
  const bad = await phone.call('POST', '/api/road/items', { clientId: 'cost-bad-001', kind: 'cost', data: { trip: ref, date: '2026-13-01', amount: '-5' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.details.length >= 2);
  // Nothing is in the books yet.
  const { rows: [{ n: tripsBefore }] } = await db.pool.query('SELECT count(*)::int AS n FROM trips');
  assert.equal(tripsBefore, 0);

  // At the desk: four items waiting.
  let inbox = ok(await desk.call('GET', `${b}/road-items`));
  assert.deepEqual(inbox.map((i) => i.kind), ['trip', 'cost', 'cost', 'time', 'time']);
  const [tItem, air, miles, drive, day2] = inbox;
  assert.equal(day2.hours, '9.00');
  assert.equal(air.trip.name, 'Dallas, Oct 4-6');
  assert.equal(air.photos.length, 1);
  assert.equal(drive.hours, '6.00');
  const pic = await desk.call('GET', `${b}/road-items/${air.id}/photos/${air.photos[0]}`);
  assert.equal(pic.type, 'image/png');
  const accounts = { expenseAccountId: A['6500'], paidFromAccountId: A['2100'] };
  const early = await desk.call('POST', `${b}/road-items/${air.id}/accept`, accounts);
  assert.equal(early.status, 400);
  assert.match(early.body.error, /Accept its trip first/);

  // Accept the trip: 2610 becomes a project, both share the trip 50/50.
  const tr = ok(await desk.call('POST', `${b}/road-items/${tItem.id}/accept`, {}));
  const saved = ok(await desk.call('GET', `${b}/trips/${tr.tripId}`));
  assert.deepEqual(saved.jobs.map((j) => [j.jobCode ?? j.code, j.share]).sort(), [['2601', '50'], ['2610', '50']]);
  // The airfare: Dr Travel $412.30 / Cr credit card, with its receipt photo.
  const ac = ok(await desk.call('POST', `${b}/road-items/${air.id}/accept`, accounts));
  const photos = ok(await desk.call('GET', `/api/companies/${co.id}/trip-costs/${ac.costId}/photos`));
  assert.equal(photos.length, 1);
  ok(await desk.call('POST', `${b}/road-items/${miles.id}/accept`, accounts));
  ok(await desk.call('POST', `${b}/road-items/${drive.id}/accept`, {}));
  ok(await desk.call('POST', `${b}/road-items/${day2.id}/accept`, {}));
  const after = ok(await desk.call('GET', `${b}/trips/${tr.tripId}`));
  // 150 mi × $0.70 = $105.00; airfare $412.30.
  assert.deepEqual(after.costs.map((c) => c.amountCents).sort((x, y) => x - y), [10500, 41230]);
  assert.deepEqual(after.time.map((x) => [x.date, x.minutes, x.start, x.end]), [['2026-10-04', 360, null, null], ['2026-10-05', 540, '07:30', '17:45']]);
  assert.equal(ok(await desk.call('GET', `${b}/road-items`)).length, 0);
  // Accepting twice is refused; a photo for a reviewed cost is refused.
  assert.equal((await desk.call('POST', `${b}/road-items/${air.id}/accept`, accounts)).status, 400);
  assert.equal((await phone.call('POST', '/api/road/items/cost-air-01/photos', { clientId: 'photo-air-02', picture: PNG })).status, 400);
  // The phone can see they are in the books.
  const st = ok(await phone.call('POST', '/api/road/status', { clientIds: ['trip-dallas-01', 'cost-air-01', 'nope-nope-1'] }));
  assert.deepEqual(st.map((s) => s.status), ['accepted', 'accepted']);

  // Dismiss: a cost on an existing trip that turned out to be personal.
  ok(await phone.call('POST', '/api/road/items', { clientId: 'cost-lunch-01', kind: 'cost', data: { trip: { id: tr.tripId }, date: '2026-10-05', kind: 'meals', amount: '18.00' } }), 201);
  inbox = ok(await desk.call('GET', `${b}/road-items`));
  assert.equal(inbox[0].trip.name, 'Dallas, Oct 4-6');
  ok(await desk.call('POST', `${b}/road-items/${inbox[0].id}/dismiss`, {}));
  assert.equal(ok(await desk.call('GET', `${b}/road-items`)).length, 0);

  // A viewer can't make a road key.
  const viewer = await newUser('viewer@example.com');
  ok(await desk.call('POST', `${b}/members`, { email: 'viewer@example.com', role: 'viewer' }), 201);
  assert.equal((await viewer.call('POST', `${b}/road-keys`, { name: 'mine' })).status, 403);

  // Revoked: the phone is shut out.
  ok(await desk.call('POST', `${b}/road-keys/${made.id}/revoke`, {}));
  assert.equal((await phone.call('GET', '/api/road')).status, 401);
  assert.equal(ok(await desk.call('GET', `${b}/road-keys`)).length, 0);
});
