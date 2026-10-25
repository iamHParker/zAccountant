// Home page: each person's own card arrangement, and the Statistics card's numbers.
// Through HTTP with the restricted runtime role (column grants and row-level security tested too).
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { totpCode } from '../src/security/totp.js';

process.env.AUTH_RATE_LIMIT = '1000';

test('Home cards and Statistics', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase({ withAppRole: true });
  const server = createApp(db.appPool, { log: () => {} }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { server.close(); await db.drop(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body) => {
      const r = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: r.status, body: await r.json().catch(() => null) };
    };
  };
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  async function newUser(email) {
    const call = client();
    await call('POST', '/api/auth/signup', { email, name: email.split('@')[0], password: 'a long enough passphrase' });
    const setup = (await call('POST', '/api/auth/mfa/setup', {})).body;
    ok(await call('POST', '/api/auth/mfa/enable', { code: totpCode(setup.secret, Date.now()) }));
    return call;
  }
  const homer = await newUser('homer@example.com');
  const staff = await newUser('staff@example.com');
  const co = ok(await homer('POST', '/api/companies', { name: 'Parker Engineering', homeState: 'TX', fiscalYearStartMonth: 1 }), 201);
  const b = `/api/companies/${co.id}`;
  ok(await homer('POST', `${b}/members`, { email: 'staff@example.com', role: 'staff' }), 201);

  // Nothing arranged yet: null (the browser shows its standard cards).
  assert.deepEqual(ok(await homer('GET', `${b}/home-layout`)), { layout: null });
  ok(await homer('PUT', `${b}/home-layout`, { left: ['stats'], right: ['invoice', 'mileiq'] }));
  ok(await homer('PUT', `${b}/home-layout`, { left: ['stats', 'pnl'], right: ['mileiq', 'invoice'] })); // moved: saved again
  assert.deepEqual(ok(await homer('GET', `${b}/home-layout`)).layout, { left: ['stats', 'pnl'], right: ['mileiq', 'invoice'] });
  for (const bad of [{ left: ['stats', 'stats'] }, { left: 'stats' }, { right: ['<script>'] }, { right: Array.from({ length: 31 }, (_, i) => `c${i}`) }]) {
    assert.equal((await homer('PUT', `${b}/home-layout`, bad)).status, 400, JSON.stringify(bad));
  }
  // Each person has their own: staff (no "see the books") can arrange theirs but can't see Statistics.
  assert.deepEqual(ok(await staff('GET', `${b}/home-layout`)), { layout: null });
  ok(await staff('PUT', `${b}/home-layout`, { left: [], right: ['invoice'] }));
  assert.deepEqual(ok(await homer('GET', `${b}/home-layout`)).layout.right, ['mileiq', 'invoice']);
  assert.equal((await staff('GET', `${b}/reports/statistics`)).status, 403);
  const { rows } = await db.appPool.query('SELECT count(*)::int AS n FROM home_layouts'); // no company/user set: RLS shows nothing
  assert.equal(rows[0].n, 0);

  // Statistics: income, expenses and cash by month; largest expenses this year; who owes whom.
  const A = Object.fromEntries(ok(await homer('GET', `${b}/accounts`)).map((a) => [a.code, a.id]));
  const entry = (date, lines) => homer('POST', `${b}/entries`, { date, memo: 'test', lines });
  ok(await entry('2025-09-30', [{ accountId: A['1000'], debit: '1000' }, { accountId: A['3000'], credit: '1000' }]), 201); // before the 12 months
  ok(await entry('2025-11-05', [{ accountId: A['1000'], debit: '500' }, { accountId: A['4000'], credit: '500' }]), 201);
  ok(await entry('2026-03-10', [{ accountId: A['6300'], debit: '800' }, { accountId: A['1000'], credit: '800' }]), 201);
  ok(await entry('2026-10-02', [{ accountId: A['6600'], debit: '120.50' }, { accountId: A['1000'], credit: '120.50' }]), 201);
  ok(await entry('2026-10-03', [{ accountId: A['1000'], debit: '2000' }, { accountId: A['4000'], credit: '2000' }]), 201);
  const s = ok(await homer('GET', `${b}/reports/statistics?asOf=2026-10-25`));
  assert.deepEqual(s.months.map((m) => m.month), ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  // Cash: $1,000 before Nov; +$500 in Nov = $1,500; −$800 in Mar = $700; Oct −$120.50 + $2,000 = $2,579.50.
  assert.deepEqual(s.months.map((m) => m.cashEndCents), [150000, 150000, 150000, 150000, 70000, 70000, 70000, 70000, 70000, 70000, 70000, 257950]);
  assert.deepEqual([s.months[0].incomeCents, s.months[4].expensesCents, s.months[11].profitCents], [50000, 80000, 187950]);
  assert.deepEqual(s.topExpenses.map((x) => [x.code, x.cents]), [['6300', 80000], ['6600', 12050]]);
  assert.deepEqual(s.receivable, { totalCents: 0, overdueCents: 0, count: 0 });
  assert.equal(s.fiscalYearStart, '2026-01-01');
});
