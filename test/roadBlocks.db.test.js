// Time in blocks from the Road page (migration 042): travel, site and office blocks on projects; travel split between
// two projects becomes two halves; travel on a trip becomes travel time on the trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { totpCode } from '../src/security/totp.js';
import { splitBlock } from '../src/services/roadService.js';

process.env.AUTH_RATE_LIMIT = '1000';

test('split travel: half each, the odd minute to the first, the first ends where the second starts', () => {
  // 7:00 to 8:01 = 61 minutes → 31 + 30: 7:00-7:31 and 7:31-8:01.
  assert.deepEqual(splitBlock(61, '07:00'), [{ minutes: 31, start: '07:00', end: '07:31' }, { minutes: 30, start: '07:31', end: '08:01' }]);
  assert.deepEqual(splitBlock(90).map((x) => x.minutes), [45, 45]);
  // Past midnight: 11:50 PM + 30 min → 11:50-12:05 AM, 12:05-12:20 AM.
  assert.deepEqual(splitBlock(30, '23:50').map((x) => [x.start, x.end]), [['23:50', '00:05'], ['00:05', '00:20']]);
});

test('Road time blocks: one entry per block, split travel in halves, travel on a trip', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase({ withAppRole: true });
  const server = createApp(db.appPool, { log: () => {} }).listen(0, '127.0.0.1');
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
      return { status: r.status, body: json, type: r.headers.get('content-type') };
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
  const A = Object.fromEntries(ok(await desk.call('GET', `${b}/accounts`)).map((a) => [a.code, a.id]));
  ok(await desk.call('POST', `${b}/jobs/import`, { text: '2601 Smith Residence\n2602 Lee Garage' }));
  const J = Object.fromEntries(ok(await desk.call('GET', `${b}/jobs`)).map((j) => [j.code, j.id]));
  const made = ok(await desk.call('POST', `${b}/road-keys`, { name: "Homer's iPhone" }), 201);
  const phone = client(made.url.split('#key=')[1]);

  const send = async (clientId, data, status = 201) => phone.call('POST', '/api/road/items', { clientId, kind: 'block', data }).then((r) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; });
  // Homer's day: drive out (split with the Lee visit later), site time before and after lunch, the drive home split,
  // and drafting typed on the phone in the evening.
  await send('blk-travel-out1', { date: '2026-11-05', type: 'travel', start: '07:00', end: '08:01', jobId: J['2601'], splitJobId: J['2602'], notes: 'SAT to Boerne' });
  await send('blk-site-am-001', { date: '2026-11-05', type: 'site', start: '08:01', end: '12:00', jobId: J['2601'] });
  await send('blk-site-pm-001', { date: '2026-11-05', type: 'site', start: '12:45', end: '15:30', jobId: J['2601'] });
  await send('blk-office-0001', { date: '2026-11-05', type: 'office', hours: '1.5', notes: 'Drafting' });
  // Refused: site time with no project; split with itself; no times.
  const noJob = await phone.call('POST', '/api/road/items', { clientId: 'blk-bad-000001', kind: 'block', data: { date: '2026-11-05', type: 'site', start: '08:00', end: '09:00' } });
  assert.equal(noJob.status, 400);
  assert.match(noJob.body.details.join(' '), /choose the project/);
  const self = await phone.call('POST', '/api/road/items', { clientId: 'blk-bad-000002', kind: 'block', data: { date: '2026-11-05', type: 'travel', hours: '1', jobId: J['2601'], splitJobId: J['2601'] } });
  assert.match(self.body.details.join(' '), /different project/);
  const noTime = await phone.call('POST', '/api/road/items', { clientId: 'blk-bad-000003', kind: 'block', data: { date: '2026-11-05', type: 'office' } });
  assert.match(noTime.body.details.join(' '), /start and end, or hours/);

  // Travel on a trip: the trip is sent and accepted first; the block becomes travel time on it.
  await phone.call('POST', '/api/road/items', { clientId: 'trip-dallas-01', kind: 'trip', data: { name: 'Dallas', startDate: '2026-11-05', jobIds: [J['2602']], newProjects: [] } });
  await send('blk-trip-drive1', { date: '2026-11-05', type: 'travel', start: '16:00', end: '17:00', trip: { clientId: 'trip-dallas-01' } });

  const inbox = ok(await desk.call('GET', `${b}/road-items`));
  const by = (cid) => inbox.find((i) => i.clientId === cid);
  assert.equal(by('blk-travel-out1').hours, '1.02'); // 61 minutes
  assert.equal(by('blk-office-0001').data.minutes, 90);
  ok(await desk.call('POST', `${b}/road-items/${by('trip-dallas-01').id}/accept`, {}));
  const split = ok(await desk.call('POST', `${b}/road-items/${by('blk-travel-out1').id}/accept`, {}));
  assert.equal(split.timeEntryIds.length, 2);
  for (const cid of ['blk-site-am-001', 'blk-site-pm-001', 'blk-office-0001', 'blk-trip-drive1']) ok(await desk.call('POST', `${b}/road-items/${by(cid).id}/accept`, {}));

  const { rows } = await db.pool.query(
    `SELECT j.code, t.trip_id IS NOT NULL AS trip, t.minutes, to_char(t.start_time, 'HH24:MI') AS s, to_char(t.end_time, 'HH24:MI') AS e, t.notes
       FROM time_entries t LEFT JOIN jobs j ON j.id = t.job_id WHERE t.company_id = $1 ORDER BY t.start_time NULLS LAST, j.code`, [co.id]);
  assert.deepEqual(rows.map((r) => [r.code, r.trip, r.minutes, r.s, r.e, r.notes]), [
    ['2601', false, 31, '07:00', '07:31', 'Travel: SAT to Boerne (split)'],
    ['2602', false, 30, '07:31', '08:01', 'Travel: SAT to Boerne (split)'],
    ['2601', false, 239, '08:01', '12:00', 'Site'],
    ['2601', false, 165, '12:45', '15:30', 'Site'],
    [null, true, 60, '16:00', '17:00', 'Travel'],
    [null, false, 90, null, null, 'Office / drafting: Drafting'],
  ]);
  assert.equal(ok(await desk.call('GET', `${b}/road-items`)).length, 0);
});
