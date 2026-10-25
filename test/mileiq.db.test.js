// MileIQ import: the monthly drive report becomes mileage costs on trips, once per drive.
// Through HTTP with the restricted runtime role (so the column grants are tested too).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { totpCode } from '../src/security/totp.js';

process.env.AUTH_RATE_LIMIT = '1000';
const content = readFileSync(new URL('./fixtures/mileiq-sample.csv', import.meta.url), 'utf8');

test('MileIQ import: preview, post per trip and day, never twice', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase({ withAppRole: true });
  const server = createApp(db.appPool, { log: () => {} }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { server.close(); await db.drop(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  await call('POST', '/api/auth/signup', { email: 'homer@example.com', name: 'Homer', password: 'a long enough passphrase' });
  const setup = (await call('POST', '/api/auth/mfa/setup', {})).body;
  ok(await call('POST', '/api/auth/mfa/enable', { code: totpCode(setup.secret, Date.now()) }));
  const co = ok(await call('POST', '/api/companies', { name: 'Parker Engineering', homeState: 'TX', fiscalYearStartMonth: 1 }), 201);
  const b = `/api/companies/${co.id}`;
  const A = Object.fromEntries(ok(await call('GET', `${b}/accounts`)).map((a) => [a.code, a.id]));
  const midland = ok(await call('POST', `${b}/trips`, { name: 'Midland, Oct 8', startDate: '2026-10-08' }), 201);

  // Preview: nothing saved. The Midland drives find their trip by date; the commute is shown but not business.
  const p = ok(await call('POST', `${b}/mileiq/preview`, { content }));
  assert.deepEqual(p.counts, { drives: 7, business: 6, imported: 0, toImport: 6, miles: '52.6', businessMiles: '42.7', mileIqValueCents: 3244, tollsCents: 225, parkingCents: 550 });
  // MileIQ's figure, drive by drive: 14.74 + 10.87 + 2.43 + 2.05 + 1.82 + 0.53 = $32.44.
  assert.deepEqual(p.drives.map((d) => d.tripId), [midland.id, midland.id, null, null, null, null, null]);
  assert.equal(p.drives[4].business, false);
  assert.equal((await call('POST', `${b}/mileiq/preview`, { content: 'Date,Amount\n1/1/2026,5\n' })).status, 400);

  const pick = (tripFor) => p.drives.filter((d) => d.business).map((d) => ({ key: d.key, tripId: tripFor(d) }));
  const body = { content, expenseAccountId: A['6600'], paidFromAccountId: A['3000'], newTripName: 'Local driving, October 2026',
    drives: pick((d) => d.tripId ?? 'new') };
  // The commute can't be slipped in, and a drive needs a trip.
  assert.equal((await call('POST', `${b}/mileiq/import`, { ...body, drives: [...body.drives, { key: p.drives[4].key, tripId: 'new' }] })).status, 400);
  assert.equal((await call('POST', `${b}/mileiq/import`, { ...body, drives: pick(() => '') })).status, 400);

  const r = ok(await call('POST', `${b}/mileiq/import`, body), 201);
  // Midland, Oct 8: 19.4 + 14.3 = 33.7 mi × $0.76 = $25.612 → $25.61, tolls $2.25, parking $5.50.
  // Local, Oct 11: 3.2 mi → $2.43 (2.432) + 2.7 mi → $2.05 (2.052) = $4.48.
  // Oct 13, each drive rounded as MileIQ does: 2.4 mi → $1.82 (1.824) + 0.7 mi → $0.53 (0.532) = $2.35
  // (3.1 mi × $0.76 in one go would be $2.356 → $2.36; the books follow MileIQ's report instead).
  // 25.61 + 2.25 + 5.50 + 4.48 + 2.35 = $40.19 = MileIQ's $32.44 + $7.75 tolls and parking.
  assert.deepEqual([r.drives, r.costs, r.amountCents, r.miles, r.trips.length], [6, 5, 4019, '42.7', 2]);
  const trip = ok(await call('GET', `${b}/trips/${midland.id}`));
  assert.deepEqual(trip.costs.map((c) => [c.kind, c.description, c.amountCents, c.miles]), [
    ['mileage', 'MileIQ, 2 drives: 100 Airport Rd → 200 County Rd 111 → 300 Main St', 2561, '33.7'],
    ['tolls', 'Tolls (MileIQ)', 225, null], ['other', 'Parking (MileIQ)', 550, null]]);
  const list = ok(await call('GET', `${b}/trips`));
  const local = list.find((x) => x.name === 'Local driving, October 2026');
  const lt0 = ok(await call('GET', `${b}/trips/${local.id}`));
  assert.deepEqual(lt0.costs.map((c) => [c.date, c.miles, c.amountCents]), [['2026-10-11', '5.9', 448], ['2026-10-13', '3.1', 235]]);
  assert.deepEqual([local.startDate, local.endDate, local.totalCents, local.costCount], ['2026-10-11', '2026-10-13', 683, 2]);
  const bal = ok(await call('GET', `${b}/reports/trial-balance?asOf=2026-10-31`));
  const row = (code) => bal.rows.find((x) => x.code === code);
  assert.equal(row('6600').debitCents, 4019);
  assert.equal(row('3000').creditCents, 4019);

  // The same file again: everything is already in.
  const again = ok(await call('POST', `${b}/mileiq/preview`, { content }));
  assert.deepEqual([again.counts.imported, again.counts.toImport], [6, 0]);
  assert.equal((await call('POST', `${b}/mileiq/import`, body)).status, 400);

  // Void the Oct 13 cost outright: its two drives can come in again.
  const lt = ok(await call('GET', `${b}/trips/${local.id}`));
  ok(await call('POST', `${b}/trip-costs/${lt.costs.find((c) => c.miles === '3.1').id}/void`, {}));
  const after = ok(await call('POST', `${b}/mileiq/preview`, { content }));
  assert.deepEqual(after.drives.filter((d) => d.business && !d.imported).map((d) => d.date), ['2026-10-13', '2026-10-13']);
});
