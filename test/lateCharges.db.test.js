// Late charges (Homer, 2026-10-29): 6% a year and a $35 late-statement fee, after a 30-day grace (60 for a homeowner's
// November/December invoices). Through HTTP as the restricted runtime role, so the new grants are exercised.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { totpCode } from '../src/security/totp.js';

process.env.AUTH_RATE_LIMIT = '1000';

test('late charges: settings, preview, one invoice per customer per month', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
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
  await call('POST', '/api/auth/signup', { email: 'owner@example.com', name: 'Owner', password: 'a long enough passphrase' });
  const setup = await call('POST', '/api/auth/mfa/setup', {});
  await call('POST', '/api/auth/mfa/enable', { code: totpCode(setup.body.secret, Date.now()) });
  const co = ok(await call('POST', '/api/companies', { name: 'Late Co', homeState: 'TX', fiscalYearStartMonth: 1 }), 201);
  const c = `/api/companies/${co.id}`;
  const A = Object.fromEntries(ok(await call('GET', `${c}/accounts`)).map((a) => [a.code, a.id]));

  // Off until a rate or fee is set.
  assert.equal(ok(await call('GET', `${c}/late-charges/settings`)).on, false);
  assert.equal(ok(await call('GET', `${c}/late-charges/preview?asOf=2027-01-20`)).count, 0);
  assert.equal((await call('PUT', `${c}/late-charges/settings`, { apr: '99' })).status, 400);
  const s = ok(await call('PUT', `${c}/late-charges/settings`, { apr: '6%', fee: '35.00', graceDays: 30, holidayGraceDays: 60 }));
  assert.deepEqual([s.apr, s.feeCents, s.graceDays, s.holidayGraceDays, s.on], ['6', 3500, 30, 60, true]);

  const cust = async (name, more = {}) => ok(await call('POST', `${c}/customers`, { name, termsDays: 30, ...more }), 201);
  const firm = await cust('A Builder LLC');
  const home = await cust('A Homeowner', { isHomeowner: true });
  const kind = await cust('A Neighbor', { noLateCharges: true });
  assert.equal(home.isHomeowner, true);
  const invoice = async (contact, date, dueDate, amount, more = {}) => ok(await call('POST', `${c}/invoices`, { contactId: contact.id, date, dueDate,
    lines: [{ accountId: A['4100'], description: 'Engineering', amount }], ...more }), 201);
  // Both fell due Nov 20. The company's grace ends Dec 20; the homeowner's ends Jan 19.
  const f1 = await invoice(firm, '2026-10-21', '2026-11-20', '1000');
  await invoice(home, '2026-10-21', '2026-11-20', '800');
  await invoice(kind, '2026-10-21', '2026-11-20', '500');
  const plan = await invoice(firm, '2026-10-21', null, '600', { plan: { count: 3, firstDue: '2026-11-01' } });
  const exempt = await invoice(firm, '2026-10-21', '2026-11-20', '200', { noLateCharges: true });
  assert.equal(exempt.noLateCharges, true);
  // 400.00 paid on the company's invoice: 600.00 left past due.
  ok(await call('POST', `${c}/payments-received`, { contactId: firm.id, date: '2026-12-01', accountId: A['1000'], method: 'check',
    applications: [{ documentId: f1.id, amount: '400' }] }), 201);

  // Jan 15: only the company is charged. 600.00 × 6% ÷ 12 = 3.00 interest + 35.00 fee = 38.00.
  let p = ok(await call('GET', `${c}/late-charges/preview?asOf=2027-01-15`));
  assert.deepEqual(p.customers.map((x) => [x.name, x.pastDueCents, x.interestCents, x.feeCents]), [['A Builder LLC', 60000, 300, 3500]]);
  assert.deepEqual(p.customers[0].invoices.map((d) => d.number), [f1.number]); // not the plan, not the exempt invoice
  assert.ok(!p.customers[0].invoices.some((d) => d.id === plan.id));
  // Jan 25: the homeowner's 60 days are up too. 800.00 → 4.00 + 35.00.
  p = ok(await call('GET', `${c}/late-charges/preview?asOf=2027-01-25`));
  assert.deepEqual(p.customers.map((x) => [x.name, x.totalCents]), [['A Builder LLC', 3800], ['A Homeowner', 3900]]);
  assert.equal(p.totalCents, 7700);

  const run = ok(await call('POST', `${c}/late-charges`, { asOf: '2027-01-25' }), 201);
  assert.deepEqual(run.invoices.map((x) => [x.name, x.totalCents]), [['A Builder LLC', 3800], ['A Homeowner', 3900]]);
  const lc = ok(await call('GET', `${c}/documents/${run.invoices[0].documentId}`));
  assert.equal(lc.lateChargeMonth, '2027-01');
  assert.match(lc.lines[0].description, /^Finance charge: 6% a year, one month on \$600\.00 past due/);
  assert.equal(lc.lines[1].description, 'Late statement fee');
  // Not twice in January.
  assert.equal(ok(await call('GET', `${c}/late-charges/preview?asOf=2027-01-31`)).count, 0);
  assert.equal((await call('POST', `${c}/late-charges`, { asOf: '2027-01-31' })).status, 400);
  // February: the late-charge invoices themselves are not charged (no interest on interest), the original is again.
  p = ok(await call('GET', `${c}/late-charges/preview?asOf=2027-02-25`));
  assert.deepEqual(p.customers.map((x) => [x.name, x.pastDueCents]), [['A Builder LLC', 60000], ['A Homeowner', 80000]]);
  // Editing a late-charge invoice keeps it one (still counts for January).
  const edited = ok(await call('PUT', `${c}/documents/${lc.id}`, { contactId: firm.id, date: '2027-01-25',
    lines: [{ accountId: lc.lines[0].accountId, description: 'Late statement fee', amount: '35' }] }));
  assert.equal(edited.lateChargeMonth, '2027-01');
  assert.equal(ok(await call('GET', `${c}/late-charges/preview?asOf=2027-01-31`)).count, 0);
  // The income account was added once.
  const accts = ok(await call('GET', `${c}/accounts`)).filter((a) => a.key === 'late_charges');
  assert.deepEqual(accts.map((a) => [a.code, a.name]), [['4910', 'Late Charges & Finance Charges']]);
  // Marking the customer "no late charges" later takes them off the list.
  ok(await call('PATCH', `${c}/contacts/${home.id}`, { noLateCharges: true }));
  p = ok(await call('GET', `${c}/late-charges/preview?asOf=2027-02-25`));
  assert.deepEqual(p.customers.map((x) => x.name), ['A Builder LLC']);
  // An invoice can be excused later through Change details.
  ok(await call('PATCH', `${c}/documents/${f1.id}`, { noLateCharges: true }));
  assert.equal(ok(await call('GET', `${c}/late-charges/preview?asOf=2027-02-25`)).count, 0);
});
