// Projects from the Road page (Homer, 2026-11-16): look a project up in the field, or add one. A project added on the
// phone is made by the desk's own Add project (createJob), so it is the same as one added at the desk; only a person
// whose role may add projects at the desk can add one from the phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { totpCode } from '../src/security/totp.js';

process.env.AUTH_RATE_LIMIT = '1000';

test('Road projects: look up with customer and site, add like the desk, same name twice is one, roles respected', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
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
      return { status: r.status, body: await r.json().catch(() => null) };
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
  const dwh = ok(await desk.call('POST', `${b}/customers`, { name: 'DWH' }), 201);
  ok(await desk.call('POST', `${b}/jobs`, { code: '26-002', name: '26-002 DWH', customerId: dwh.id, address: '285 Bridgestone Way\nBuda, TX' }), 201);
  const made = ok(await desk.call('POST', `${b}/road-keys`, { name: "Homer's iPhone" }), 201);
  const phone = client(made.url.split('#key=')[1]);

  // Look up: the phone gets each open project's number, customer and site address, and the customer list to pick from.
  const s1 = ok(await phone.call('GET', '/api/road'));
  assert.equal(s1.canAddProjects, true);
  assert.equal(s1.canAddCustomers, true);
  assert.deepEqual(s1.customers.map((c) => c.name), ['DWH']);
  assert.equal(s1.projects[0].customerName, 'DWH');
  assert.equal(s1.projects[0].address, '285 Bridgestone Way\nBuda, TX');

  // Add with a customer from the list: the same row the desk makes.
  const a = ok(await phone.call('POST', '/api/road/projects', { code: '2610', name: '2610 Garcia Barn', customerId: dwh.id, address: ' 12 Ranch Rd\nBoerne, TX ' }), 201);
  assert.equal(a.alreadyThere, false);
  const jobs = ok(await desk.call('GET', `${b}/jobs`));
  const garcia = jobs.find((j) => j.id === a.project.id);
  assert.deepEqual({ code: garcia.code, name: garcia.name, customerName: garcia.customerName, address: garcia.address, isActive: garcia.isActive },
    { code: '2610', name: '2610 Garcia Barn', customerName: 'DWH', address: '12 Ranch Rd\nBoerne, TX', isActive: true });
  const { rows: [audit] } = await db.pool.query("SELECT actor FROM audit_log WHERE entity = 'job' AND entity_id = $1", [garcia.id]);
  assert.equal(audit.actor, 'homer@example.com');

  // Sent twice (signal lost before the answer): one project, the second answer says it was already there.
  const again = ok(await phone.call('POST', '/api/road/projects', { code: '2610', name: '2610 garcia barn' }), 201);
  assert.equal(again.alreadyThere, true);
  assert.equal(again.project.id, garcia.id);

  // No number typed: read from the front of the name. A new customer typed by name is added; a known one is matched.
  const c = ok(await phone.call('POST', '/api/road/projects', { name: '2611 Ortiz Retaining Wall', customerName: 'Ortiz Homes' }), 201);
  assert.equal(c.project.code, '2611');
  assert.equal(c.project.customerName, 'Ortiz Homes');
  const d = ok(await phone.call('POST', '/api/road/projects', { name: 'Trophy Oak', customerName: 'dwh' }), 201);
  assert.equal(d.project.code, null);
  assert.equal(d.project.customerId, dwh.id);
  assert.equal(ok(await desk.call('GET', `${b}/customers`)).filter((x) => x.name === 'Ortiz Homes').length, 1);
  const s2 = ok(await phone.call('GET', '/api/road'));
  assert.deepEqual(s2.projects.map((p) => p.code), ['26-002', '2610', '2611', null]);

  // The desk's checks apply: a name is needed, 80 characters at most, a customer from this company only.
  assert.equal((await phone.call('POST', '/api/road/projects', { name: '  ' })).status, 400);
  assert.equal((await phone.call('POST', '/api/road/projects', { name: 'x'.repeat(81) })).status, 400);
  assert.equal((await phone.call('POST', '/api/road/projects', { name: 'Elsewhere', customerId: '00000000-0000-4000-8000-000000000000' })).status, 400);

  // Roles: a field hand (bills + own time) can look up but not add; a time approver can add, but not new customers.
  const field = ok(await desk.call('POST', `${b}/roles`, { name: 'Field', permissions: ['bills', 'time_own'] }), 201);
  const lead = ok(await desk.call('POST', `${b}/roles`, { name: 'Crew lead', permissions: ['bills', 'time_all'] }), 201);
  const pat = await newUser('pat@example.com');
  ok(await desk.call('POST', `${b}/members`, { email: 'pat@example.com', role: field.id }), 201);
  const patPhone = client(ok(await pat.call('POST', `${b}/road-keys`, { name: "Pat's phone" }), 201).url.split('#key=')[1]);
  const ps = ok(await patPhone.call('GET', '/api/road'));
  assert.equal(ps.canAddProjects, false);
  assert.deepEqual(ps.customers, []);
  assert.equal(ps.projects.length, 4);
  const no = await patPhone.call('POST', '/api/road/projects', { name: '2612 Pat Job' });
  assert.equal(no.status, 400); // 400, not 403: the phone treats 403 as "this key no longer works"
  assert.match(no.body.error, /can't add projects/);
  ok(await desk.call('POST', `${b}/members`, { email: 'pat@example.com', role: lead.id }), 201);
  assert.equal(ok(await patPhone.call('GET', '/api/road')).canAddCustomers, false);
  assert.match((await patPhone.call('POST', '/api/road/projects', { name: '2612 Pat Job', customerName: 'Brand New Co' })).body.error, /can't add customers/);
  ok(await patPhone.call('POST', '/api/road/projects', { name: '2612 Pat Job', customerName: 'DWH' }), 201);
});
