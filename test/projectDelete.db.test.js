// Deleting a project made by mistake (Homer, 2026-11-16: "need to be able to delete errant job number"). Only when
// nothing points at it; time, trip shares, purchases and road items can be moved to another project first; invoices
// and bills are never moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { totpCode } from '../src/security/totp.js';

process.env.AUTH_RATE_LIMIT = '1000';

test('Projects: delete one nothing uses, move what uses one, never move invoices', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase({ withAppRole: true });
  const server = createApp(db.appPool, { log: () => {} }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { server.close(); await db.drop(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = (bearer = null) => {
    let cookie = '';
    const call = async (method, path, body) => {
      const r = await fetch(base + path, { method, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { call };
  };
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const desk = client();
  await desk.call('POST', '/api/auth/signup', { email: 'homer@example.com', name: 'homer', password: 'a long enough passphrase' });
  const setup = (await desk.call('POST', '/api/auth/mfa/setup', {})).body;
  ok(await desk.call('POST', '/api/auth/mfa/enable', { code: totpCode(setup.secret, Date.now()) }));
  const co = ok(await desk.call('POST', '/api/companies', { name: 'Parker Engineering', homeState: 'TX', fiscalYearStartMonth: 1 }), 201);
  const b = `/api/companies/${co.id}`;
  const j147 = ok(await desk.call('POST', `${b}/jobs`, { code: '26-147', name: 'CastleRock customer, 3204 Stirrat' }), 201);
  const j148 = ok(await desk.call('POST', `${b}/jobs`, { code: '26-148', name: 'CastleRock Customer, 6709 Avila Way' }), 201);
  const phantom = ok(await desk.call('POST', `${b}/jobs`, { code: '26', name: '26-147, 26-148' }), 201);

  // Nothing uses a fresh project: it can be deleted, and the audit trail keeps a note.
  const lonely = ok(await desk.call('POST', `${b}/jobs`, { code: '99', name: '99 typo' }), 201);
  const u0 = ok(await desk.call('GET', `${b}/jobs/${lonely.id}/uses`));
  assert.deepEqual([u0.canDelete, u0.uses], [true, []]);
  ok(await desk.call('DELETE', `${b}/jobs/${lonely.id}`));
  assert.equal(ok(await desk.call('GET', `${b}/jobs?inactive=1`)).some((j) => j.id === lonely.id), false);
  const { rows: [a] } = await db.pool.query("SELECT payload FROM audit_log WHERE entity = 'job' AND action = 'delete' AND entity_id = $1", [lonely.id]);
  assert.equal(a.payload.name, '99 typo');

  // Homer's phantom is on a trip at 100%: refused, with what uses it; movable.
  const trip = ok(await desk.call('POST', `${b}/trips`, { name: 'Pflugerville', startDate: '2026-11-15', jobs: [{ jobId: phantom.id, share: '100' }] }), 201);
  const refused = await desk.call('DELETE', `${b}/jobs/${phantom.id}`);
  assert.equal(refused.status, 400);
  assert.match(refused.body.details.join(' '), /share of 1 trip \(Pflugerville\)/);
  const u1 = ok(await desk.call('GET', `${b}/jobs/${phantom.id}/uses`));
  assert.deepEqual([u1.canDelete, u1.canMove], [false, true]);

  // The trip fixed by hand (the right two projects at 50/50, the phantom at 0%): now nothing really uses it, so it goes,
  // and its 0% line on the trip goes with it.
  ok(await desk.call('PATCH', `${b}/trips/${trip.id}`, { jobs: [{ jobId: j147.id, share: '50' }, { jobId: j148.id, share: '50' }, { jobId: phantom.id, share: '0' }] }));
  assert.equal(ok(await desk.call('GET', `${b}/jobs/${phantom.id}/uses`)).canDelete, true);
  ok(await desk.call('DELETE', `${b}/jobs/${phantom.id}`));
  assert.deepEqual(ok(await desk.call('GET', `${b}/trips/${trip.id}`)).jobs.map((j) => j.jobId).sort(), [j147.id, j148.id].sort());

  // Move: another mistaken project with a trip share and time; moved to 26-147, then deleted.
  const oops = ok(await desk.call('POST', `${b}/jobs`, { code: '26-1470', name: '26-1470 typo' }), 201);
  const trip2 = ok(await desk.call('POST', `${b}/trips`, { name: 'Round Rock', startDate: '2026-11-16', jobs: [{ jobId: oops.id, share: '100' }] }), 201);
  const { rows: [me] } = await db.pool.query("SELECT id FROM users WHERE email = 'homer@example.com'");
  ok(await desk.call('POST', `${b}/time-entries`, { userId: me.id, jobId: oops.id, date: '2026-11-16', hours: '1.5' }), 201);
  // Not to the same project, and not while 26-147 is already on that trip.
  assert.equal((await desk.call('POST', `${b}/jobs/${oops.id}/move`, { toJobId: oops.id })).status, 400);
  const moved = ok(await desk.call('POST', `${b}/jobs/${oops.id}/move`, { toJobId: j147.id }));
  assert.deepEqual(moved.moved, { time: 1, trips: 1, purchases: 0, road: 0 });
  assert.deepEqual(ok(await desk.call('GET', `${b}/trips/${trip2.id}`)).jobs.map((j) => [j.jobId, j.share]), [[j147.id, '100']]);
  ok(await desk.call('DELETE', `${b}/jobs/${oops.id}`));
  const oops2 = ok(await desk.call('POST', `${b}/jobs`, { code: '26-1471', name: '26-1471 typo' }), 201);
  ok(await desk.call('PATCH', `${b}/trips/${trip2.id}`, { jobs: [{ jobId: j147.id, share: '50' }, { jobId: oops2.id, share: '50' }] }));
  assert.match((await desk.call('POST', `${b}/jobs/${oops2.id}/move`, { toJobId: j147.id })).body.error, /already on Round Rock/);

  // An invoice that names a project is never moved: delete and move are both refused until the invoice is edited.
  const A = Object.fromEntries(ok(await desk.call('GET', `${b}/accounts`)).map((x) => [x.code, x.id]));
  const cust = ok(await desk.call('POST', `${b}/customers`, { name: 'CastleRock Homes' }), 201);
  ok(await desk.call('POST', `${b}/invoices`, { contactId: cust.id, date: '2026-11-16', number: '2601', jobId: oops2.id,
    lines: [{ description: 'Site visit', quantity: '1', unitPrice: '150.00', accountId: A['4000'] }] }), 201);
  const u2 = ok(await desk.call('GET', `${b}/jobs/${oops2.id}/uses`));
  assert.deepEqual([u2.canDelete, u2.canMove], [false, false]);
  assert.match(u2.uses.find((x) => x.kind === 'invoices').text, /1 invoice \(2601\)/);
  assert.equal((await desk.call('DELETE', `${b}/jobs/${oops2.id}`)).status, 400);
  assert.equal((await desk.call('POST', `${b}/jobs/${oops2.id}/move`, { toJobId: j148.id })).status, 400);
});
