// Merging two projects for the same job (Homer, 2026-11-23): 26-143 "Richards, NHWIC OK007208-01" got the OKC trip,
// 26-151 "Richards (OK007208-01)" got the office time. Merge moves everything from one onto the other in one step:
// time, trip shares, bills (re-saved), invoices (re-saved, payments follow), then deletes the empty project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { totpCode } from '../src/security/totp.js';

process.env.AUTH_RATE_LIMIT = '1000';

test('Projects: merge one into another, moving time, trips, bills and invoices', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase({ withAppRole: true });
  const server = createApp(db.appPool, { log: () => {} }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { server.close(); await db.drop(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  await call('POST', '/api/auth/signup', { email: 'homer@example.com', name: 'homer', password: 'a long enough passphrase' });
  const setup = (await call('POST', '/api/auth/mfa/setup', {})).body;
  ok(await call('POST', '/api/auth/mfa/enable', { code: totpCode(setup.secret, Date.now()) }));
  const co = ok(await call('POST', '/api/companies', { name: 'Parker Engineering', homeState: 'TX', fiscalYearStartMonth: 1 }), 201);
  const b = `/api/companies/${co.id}`;
  const A = Object.fromEntries(ok(await call('GET', `${b}/accounts`)).map((x) => [x.code, x.id]));
  const { rows: [me] } = await db.pool.query("SELECT id FROM users WHERE email = 'homer@example.com'");
  const nhwic = ok(await call('POST', `${b}/customers`, { name: 'NHWIC Warranty' }), 201);
  const avis = ok(await call('POST', `${b}/vendors`, { name: 'Avis' }), 201);
  const j143 = ok(await call('POST', `${b}/jobs`, { code: '26-143', name: 'Richards, NHWIC OK007208-01', customerId: nhwic.id }), 201);
  const j151 = ok(await call('POST', `${b}/jobs`, { code: '26-151', name: 'Richards (OK007208-01)', customerId: nhwic.id, address: '9112 NW 142nd, Yukon, OK' }), 201);
  const other = ok(await call('POST', `${b}/jobs`, { code: '26-150', name: 'Garcia Barn', customerId: nhwic.id }), 201);

  // The OKC trip at 100% on 26-143, with a $180.69 rental car; office time on 26-151; a field visit on 26-143.
  const trip = ok(await call('POST', `${b}/trips`, { name: 'OKC Nov 16-18', startDate: '2026-11-16', endDate: '2026-11-18', jobs: [{ jobId: j143.id, share: '100' }] }), 201);
  ok(await call('POST', `${b}/trips/${trip.id}/costs`, { date: '2026-11-17', kind: 'rental_car', vendor: 'Avis', amount: '180.69', expenseAccountId: A['6500'], paidFromAccountId: A['2100'] }), 201);
  ok(await call('POST', `${b}/time-entries`, { userId: me.id, jobId: j151.id, date: '2026-11-20', hours: '3' }), 201);
  const visit = ok(await call('POST', `${b}/time-entries`, { userId: me.id, jobId: j143.id, date: '2026-11-17', hours: '6' }), 201);
  // A bill on 26-143 passed on to the client, and an invoice on 26-143 that bills the visit and that bill line, half paid.
  const bill = ok(await call('POST', `${b}/bills`, { contactId: avis.id, number: 'AV-1', date: '2026-11-18', lines: [
    { accountId: A['6500'], description: 'Fuel', amount: '42.10', jobId: j143.id, billable: true }] }), 201);
  const inv = ok(await call('POST', `${b}/invoices`, { contactId: nhwic.id, number: '26-143', date: '2026-11-19', jobId: j143.id, clientRef: 'OK00720801', lines: [
    { accountId: A['4000'], description: 'Site visit', quantity: '6', unitPrice: '150', timeEntryId: visit.id },
    { accountId: A['4000'], description: 'Fuel', quantity: '1', unitPrice: '42.10', billedLineId: bill.lines[0].id },
    { comment: true, description: 'Photos attached' }] }), 201);
  assert.equal(inv.totalCents, 94210); // 6 h × $150 = $900.00 + $42.10
  ok(await call('POST', `${b}/payments-received`, { contactId: nhwic.id, date: '2026-11-21', accountId: A['1000'], method: 'check', reference: '501',
    applications: [{ documentId: inv.id, amount: '400' }] }), 201);
  const balance = async () => (await db.pool.query(`SELECT a.code, sum(l.debit_cents - l.credit_cents)::bigint AS n FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE l.company_id = $1 GROUP BY a.code ORDER BY a.code`, [co.id])).rows;
  const before = await balance();

  // The preview changes nothing and says what would move.
  const pv = ok(await call('POST', `${b}/jobs/${j143.id}/merge`, { toJobId: j151.id, preview: true }));
  assert.deepEqual(pv.counts, { time: 1, trips: 1, purchases: 0, road: 0, invoices: 1, bills: 1 });
  assert.deepEqual(pv.problems, []);
  assert.match(pv.lines.join(' | '), /1 time entry \| its share of 1 trip \(OKC Nov 16-18\) \| 1 invoice \(26-143\), re-saved naming Richards \(OK007208-01\)/);
  assert.equal((await call('POST', `${b}/jobs/${j143.id}/merge`, { toJobId: j143.id, preview: true })).status, 400);

  const m = ok(await call('POST', `${b}/jobs/${j143.id}/merge`, { toJobId: j151.id }));
  assert.deepEqual([m.moved, m.deleted], [{ time: 1, trips: 1, purchases: 0, road: 0, invoices: 1, bills: 1 }, false]);
  // 26-143 is closed (the void copies still name it); the trip is 100% on 26-151; both time entries are on 26-151.
  assert.equal(ok(await call('GET', `${b}/jobs?inactive=1`)).find((j) => j.id === j143.id).isActive, false);
  assert.equal(ok(await call('GET', `${b}/jobs`)).some((j) => j.id === j143.id), false);
  assert.deepEqual(ok(await call('GET', `${b}/trips/${trip.id}`)).jobs.map((j) => [j.jobId, j.share]), [[j151.id, '100']]);
  const { rows: te } = await db.pool.query('SELECT job_id FROM time_entries WHERE company_id = $1', [co.id]);
  assert.deepEqual([...new Set(te.map((r) => r.job_id))], [j151.id]);
  // The invoice and bill were re-saved: same numbers and totals, the payment moved, the old copies void.
  const invs = ok(await call('GET', `${b}/invoices?status=all`));
  const live = invs.find((d) => d.status !== 'void');
  assert.deepEqual([live.number, live.totalCents, live.paidCents, live.jobId, live.clientRef], ['26-143', 94210, 40000, j151.id, 'OK00720801']);
  assert.equal(invs.find((d) => d.id === inv.id).status, 'void');
  const liveDoc = ok(await call('GET', `${b}/documents/${live.id}`));
  const liveBill = ok(await call('GET', `${b}/bills?status=all`)).find((d) => d.status !== 'void');
  const billDoc = ok(await call('GET', `${b}/documents/${liveBill.id}`));
  assert.deepEqual([billDoc.number, billDoc.lines[0].jobId, billDoc.lines[0].billable], ['AV-1', j151.id, true]);
  assert.equal(liveDoc.lines[1].billedLineId, billDoc.lines[0].id); // points at the bill's corrected line
  assert.equal(liveDoc.lines[2].comment, true);
  // The trip's rental car is now waiting to be billed on 26-151, alongside its office time.
  const unbilled = ok(await call('GET', `${b}/unbilled?jobId=${j151.id}`));
  assert.deepEqual(unbilled.tripCosts.map((x) => [x.amountCents, x.share]), [[18069, '100']]);
  assert.equal(unbilled.time.length, 1);
  // The books didn't change: every account has the same balance.
  assert.deepEqual(await balance(), before);
  const { rows: [audit] } = await db.pool.query("SELECT payload FROM audit_log WHERE entity = 'job' AND action = 'merge'");
  assert.deepEqual([audit.payload.from.code, audit.payload.invoices, audit.payload.bills], ['26-143', 1, 1]);

  // Both on one trip with part of it billed: refused until the trip is sorted out by hand.
  const trip2 = ok(await call('POST', `${b}/trips`, { name: 'Tulsa', startDate: '2026-11-22', jobs: [{ jobId: j151.id, share: '60' }, { jobId: other.id, share: '40' }] }), 201);
  const tc = ok(await call('POST', `${b}/trips/${trip2.id}/costs`, { date: '2026-11-22', kind: 'tolls', amount: '10.00', expenseAccountId: A['6500'], paidFromAccountId: A['2100'] }), 201);
  ok(await call('POST', `${b}/invoices`, { contactId: nhwic.id, number: '2650', date: '2026-11-22', lines: [
    { accountId: A['4000'], description: 'Tolls', quantity: '0.4', unitPrice: '10', tripCostId: tc.costId, jobId: other.id }] }), 201);
  const refused = ok(await call('POST', `${b}/jobs/${other.id}/merge`, { toJobId: j151.id, preview: true }));
  assert.match(refused.problems[0], /Both projects are on trip Tulsa/);
  assert.equal((await call('POST', `${b}/jobs/${other.id}/merge`, { toJobId: j151.id })).status, 400);
  // Nothing billed on a shared trip: the shares add up (60% + 40% = 100% on 26-151), and the old one's void invoice keeps it closed.
  const trip3 = ok(await call('POST', `${b}/trips`, { name: 'Enid', startDate: '2026-11-23', jobs: [{ jobId: j151.id, share: '60', air: '50' }, { jobId: other.id, share: '40' }] }), 201);
  const lonely = ok(await call('POST', `${b}/jobs`, { code: '26-152', name: 'Typo' }), 201);
  ok(await call('PATCH', `${b}/trips/${trip3.id}`, { jobs: [{ jobId: j151.id, share: '60', air: '50' }, { jobId: lonely.id, share: '40' }] }));
  const typoInv = ok(await call('POST', `${b}/invoices`, { contactId: nhwic.id, number: '2651', date: '2026-11-23', jobId: lonely.id, lines: [
    { accountId: A['4000'], description: 'Nothing', quantity: '1', unitPrice: '1' }] }), 201);
  ok(await call('POST', `${b}/documents/${typoInv.id}/void`, {}));
  const m2 = ok(await call('POST', `${b}/jobs/${lonely.id}/merge`, { toJobId: j151.id }));
  assert.deepEqual([m2.deleted, m2.keepClosed], [false, true]);
  assert.deepEqual(ok(await call('GET', `${b}/trips/${trip3.id}`)).jobs.map((j) => [j.jobId, j.share, j.air]), [[j151.id, '100', '90']]);
  assert.equal(ok(await call('GET', `${b}/jobs?inactive=1`)).find((j) => j.id === lonely.id).isActive, false);
});
