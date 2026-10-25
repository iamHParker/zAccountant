// The CPA edit sweep (docs/board/edit-sweep.md), batch 2: master-data edits, through HTTP as the restricted runtime role
// (so each new UPDATE grant in src/db/grant.js is exercised the way production runs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { totpCode } from '../src/security/totp.js';

process.env.AUTH_RATE_LIMIT = '1000';

test('edits: company, accounts, recurring entries, bank rules', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
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
  await call('POST', '/api/auth/signup', { email: 'owner@example.com', name: 'Owner', password: 'a long enough passphrase' });
  const setup = await call('POST', '/api/auth/mfa/setup', {});
  await call('POST', '/api/auth/mfa/enable', { code: totpCode(setup.body.secret, Date.now()) });
  const co = (await call('POST', '/api/companies', { name: 'Parker Engr', homeState: 'TX', fiscalYearStartMonth: 1 })).body;
  const c = `/api/companies/${co.id}`;
  const A = Object.fromEntries((await call('GET', `${c}/accounts`)).body.map((a) => [a.code, a]));
  const ok = (r, status = 200) => assert.equal(r.status, status, JSON.stringify(r.body));
  const refused = (r, re) => { assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(JSON.stringify(r.body), re); };

  await t.test('company name, home state and fiscal-year start', async () => {
    const r = await call('PATCH', `${c}/profile`, { name: 'Parker Engineering, PLLC', homeState: 'CO', fiscalYearStartMonth: 7 });
    ok(r);
    assert.equal(r.body.name, 'Parker Engineering, PLLC');
    assert.equal(r.body.home_state, 'CO');
    assert.equal(r.body.fiscal_year_start_month, 7);
    refused(await call('PATCH', `${c}/profile`, { fiscalYearStartMonth: 13 }), /month from 1 to 12/);
    refused(await call('PATCH', `${c}/profile`, { homeState: 'NY' }), /TX, CO, CA or DC/);
    ok(await call('POST', `${c}/lock`, { through: '2025-12-31' }));
    refused(await call('PATCH', `${c}/profile`, { fiscalYearStartMonth: 1 }), /closed through 2025-12-31/);
    ok(await call('PATCH', `${c}/profile`, { name: 'Parker Engineering' })); // a name change is fine while closed
  });

  await t.test('account kind, turn off only at $0 and when nothing uses it', async () => {
    const supplies = (await call('POST', `${c}/accounts`, { code: '6450', name: 'Field supplies', type: 'expense', subtype: 'operating' })).body;
    ok(await call('PATCH', `${c}/accounts/${supplies.id}`, { subtype: 'cogs' }));
    refused(await call('PATCH', `${c}/accounts/${A['1100'].id}`, { isActive: false }), /built-in/);
    ok(await call('POST', `${c}/entries/simple`, { date: '2026-03-02', memo: 'Gloves', amount: '45.10', fromAccountId: A['1000'].id, toAccountId: supplies.id }), 201);
    refused(await call('PATCH', `${c}/accounts/${supplies.id}`, { isActive: false }), /balance is \$45\.10/);
    const rule = (await call('POST', `${c}/bank-rules`, { matchText: 'home depot', direction: 'out', accountId: supplies.id })).body;
    const e = (await call('POST', `${c}/entries`, { date: '2026-03-03', memo: 'Move to supplies', lines: [{ accountId: A['6300'].id, debit: '45.10' }, { accountId: supplies.id, credit: '45.10' }] }));
    ok(e, 201);
    refused(await call('PATCH', `${c}/accounts/${supplies.id}`, { isActive: false }), /bank rule/);
    ok(await call('DELETE', `${c}/bank-rules/${rule.id}`, {}));
    const off = await call('PATCH', `${c}/accounts/${supplies.id}`, { isActive: false });
    ok(off);
    assert.equal(off.body.isActive, false);
    refused(await call('POST', `${c}/entries/simple`, { date: '2026-03-04', memo: 'x', amount: '1', fromAccountId: A['1000'].id, toAccountId: supplies.id }), /active/i);
    ok(await call('PATCH', `${c}/accounts/${supplies.id}`, { isActive: true }));
  });

  await t.test('recurring entry: change the amount from the next date on, end early, restart', async () => {
    const lines = (amt) => [{ accountId: A['6300'].id, debit: amt }, { accountId: A['1000'].id, credit: amt }];
    const r = (await call('POST', `${c}/recurring`, { name: 'Office rent', frequency: 'monthly', startDate: '2026-04-01', memo: 'Rent', lines: lines('1800') })).body;
    ok(await call('POST', `${c}/recurring/post-due`, {})); // posts April through this month
    const before = (await call('GET', `${c}/recurring`)).body.find((x) => x.id === r.id);
    assert.ok(before.postedCount >= 1);
    const ch = await call('PUT', `${c}/recurring/${r.id}`, { name: 'Office rent (new lease)', memo: 'Rent', lines: lines('1950'), endDate: '2027-03-31' });
    ok(ch);
    assert.equal(ch.body.amountCents, 195000);
    assert.equal(ch.body.postedCount, before.postedCount, 'nothing posted already changes');
    const { body: { entries } } = await call('GET', `${c}/entries?source=recurring`);
    assert.ok(entries.every((e) => e.lines.some((l) => l.debitCents === 180000)), 'posted rent stays $1,800');
    refused(await call('PUT', `${c}/recurring/${r.id}`, { lines: [{ accountId: A['6300'].id, debit: '1' }, { accountId: A['1000'].id, credit: '2' }] }), /balance|equal/i);
    ok(await call('POST', `${c}/recurring/${r.id}/stop`, {}));
    const again = await call('PUT', `${c}/recurring/${r.id}`, { restart: true });
    ok(again);
    assert.equal(again.body.isActive, true);
    const ended = await call('PUT', `${c}/recurring/${r.id}`, { endDate: '2026-04-01' });
    ok(ended);
    assert.equal(ended.body.nextDate, null, 'an end date already passed finishes it');
  });

  await t.test('bank rule edit', async () => {
    const rule = (await call('POST', `${c}/bank-rules`, { matchText: 'shell oil', direction: 'out', accountId: A['6300'].id })).body;
    const r = await call('PUT', `${c}/bank-rules/${rule.id}`, { matchText: 'shell', direction: 'any', accountId: A['1000'].id, min: '10.00' });
    ok(r);
    assert.equal(r.body.matchText, 'shell');
    assert.equal(Number(r.body.minCents), 1000);
    refused(await call('PUT', `${c}/bank-rules/${rule.id}`, { matchText: 'x', accountId: A['1000'].id }), /2-100/);
  });
});
