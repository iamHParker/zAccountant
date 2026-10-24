// End-to-end tests through HTTP, with the server connected as the RESTRICTED runtime role
// (row-level security on, no UPDATE/DELETE on history) — the same way production runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { totpCode } from '../src/security/totp.js';

process.env.AUTH_RATE_LIMIT = '1000';

test('HTTP API', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase({ withAppRole: true });
  const server = createApp(db.appPool).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { server.close(); await db.drop(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** A browser-like client that keeps its session cookie. */
  const client = () => {
    let cookie = '';
    const call = async (method, path, body, headers = {}) => {
      const r = await fetch(base + path, {
        method, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { call, get cookie() { return cookie; } };
  };
  // Codes are accepted within ±1 30-second step of real time.
  const code = (secret, step = 0) => totpCode(secret, Date.now() + step * 30_000);

  /** Sign up + turn on two-factor; returns { c, secret }. */
  async function newUser(email) {
    const c = client();
    const s = await c.call('POST', '/api/auth/signup', { email, name: email.split('@')[0], password: 'a long enough passphrase' });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal(s.body.next, 'mfa_setup');
    const setup = await c.call('POST', '/api/auth/mfa/setup', {});
    assert.match(setup.body.otpauthUri, /^otpauth:\/\/totp\//);
    const en = await c.call('POST', '/api/auth/mfa/enable', { code: code(setup.body.secret) });
    assert.equal(en.status, 200, JSON.stringify(en.body));
    assert.equal(en.body.recoveryCodes.length, 8);
    return { c, secret: setup.body.secret, recoveryCodes: en.body.recoveryCodes };
  }

  const owner = await newUser('owner@example.com');
  const co = (await owner.c.call('POST', '/api/companies', { name: 'API Co', homeState: 'CO', fiscalYearStartMonth: 1 })).body;
  const accts = (await owner.c.call('GET', `/api/companies/${co.id}/accounts`)).body;
  const A = Object.fromEntries(accts.map((a) => [a.code, a.id]));

  await t.test('signed-out and half-signed-in requests are refused', async () => {
    assert.equal((await client().call('GET', '/api/companies')).status, 401);
    const c = client();
    await c.call('POST', '/api/auth/signup', { email: 'half@example.com', name: 'Half', password: 'a long enough passphrase' });
    const r = await c.call('GET', '/api/companies');
    assert.equal(r.status, 401);
    assert.equal(r.body.next, 'mfa_setup');
    assert.equal((await client().call('POST', '/api/auth/signup', { email: 'x@example.com', name: 'X', password: 'short' })).status, 400);
  });

  await t.test('sign in again requires password and a fresh two-factor code; codes are single-use', async () => {
    const c = client();
    assert.equal((await c.call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'wrong password!!' })).status, 401);
    const l = await c.call('POST', '/api/auth/login', { email: 'OWNER@example.com', password: 'a long enough passphrase' });
    assert.equal(l.body.next, 'mfa_verify');
    assert.equal((await c.call('GET', '/api/companies')).status, 401);
    // The code used to enable 2FA (current window) was already used → rejected; next window works.
    assert.equal((await c.call('POST', '/api/auth/mfa/verify', { code: code(owner.secret) })).status, 401);
    assert.equal((await c.call('POST', '/api/auth/mfa/verify', { code: code(owner.secret, 1) })).status, 200);
    assert.equal((await c.call('GET', '/api/companies')).body.length, 1);
    // Recovery codes work once
    const c2 = client();
    await c2.call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'a long enough passphrase' });
    assert.equal((await c2.call('POST', '/api/auth/mfa/verify', { recoveryCode: owner.recoveryCodes[0] })).status, 200);
    const c3 = client();
    await c3.call('POST', '/api/auth/login', { email: 'owner@example.com', password: 'a long enough passphrase' });
    assert.equal((await c3.call('POST', '/api/auth/mfa/verify', { recoveryCode: owner.recoveryCodes[0] })).status, 401);
    // Logout ends the session
    await c.call('POST', '/api/auth/logout', {});
    assert.equal((await c.call('GET', '/api/companies')).status, 401);
  });

  await t.test('account locks after 10 wrong passwords', async () => {
    await newUser('lockme@example.com');
    const c = client();
    for (let i = 0; i < 10; i++) await c.call('POST', '/api/auth/login', { email: 'lockme@example.com', password: `wrong password ${i}` });
    const r = await c.call('POST', '/api/auth/login', { email: 'lockme@example.com', password: 'a long enough passphrase' });
    assert.equal(r.status, 429);
  });

  await t.test('simple entry in dollars, balance sheet ties', async () => {
    const r = await owner.c.call('POST', `/api/companies/${co.id}/entries/simple`, { date: '2026-01-05', memo: 'Sale', fromAccountId: A['4000'], toAccountId: A['1000'], amount: '1,250.00' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const bs = await owner.c.call('GET', `/api/companies/${co.id}/reports/balance-sheet?asOf=2026-12-31`);
    assert.equal(bs.body.totalAssetsCents, 125_000);
    assert.equal(bs.body.balanced, true);
    const v = await owner.c.call('GET', `/api/companies/${co.id}/audit/verify`);
    assert.equal(v.body.ok, true, JSON.stringify(v.body));
  });

  await t.test('an unbalanced entry is rejected at the savepoint and nothing is saved', async () => {
    const before = (await owner.c.call('GET', `/api/companies/${co.id}/entries`)).body.length;
    const r = await owner.c.call('POST', `/api/companies/${co.id}/entries`, { date: '2026-01-06', lines: [{ accountId: A['1000'], debit: '5' }, { accountId: A['4000'], credit: '4' }] });
    assert.equal(r.status, 400);
    assert.equal((await owner.c.call('GET', `/api/companies/${co.id}/entries`)).body.length, before);
  });

  await t.test('other users cannot see or touch a company they do not belong to', async () => {
    const stranger = await newUser('stranger@example.com');
    assert.deepEqual((await stranger.c.call('GET', '/api/companies')).body, []);
    assert.equal((await stranger.c.call('GET', `/api/companies/${co.id}/accounts`)).status, 404);
    assert.equal((await stranger.c.call('POST', `/api/companies/${co.id}/entries/simple`, { date: '2026-01-05', fromAccountId: A['4000'], toAccountId: A['1000'], amount: '1' })).status, 404);
  });

  await t.test('roles: viewer reads only; bookkeeper posts but cannot run payroll or change settings', async () => {
    const viewer = await newUser('viewer@example.com');
    const bk = await newUser('bookkeeper@example.com');
    assert.equal((await owner.c.call('POST', `/api/companies/${co.id}/members`, { email: 'viewer@example.com', role: 'viewer' })).status, 201);
    assert.equal((await owner.c.call('POST', `/api/companies/${co.id}/members`, { email: 'bookkeeper@example.com', role: 'bookkeeper' })).status, 201);
    assert.equal((await viewer.c.call('GET', `/api/companies/${co.id}/reports/trial-balance`)).status, 200);
    assert.equal((await viewer.c.call('POST', `/api/companies/${co.id}/entries/simple`, { date: '2026-01-07', fromAccountId: A['4000'], toAccountId: A['1000'], amount: '1' })).status, 403);
    assert.equal((await bk.c.call('POST', `/api/companies/${co.id}/entries/simple`, { date: '2026-01-07', fromAccountId: A['4000'], toAccountId: A['1000'], amount: '1' })).status, 201);
    assert.equal((await bk.c.call('POST', `/api/companies/${co.id}/employees`, { firstName: 'A', lastName: 'B', workState: 'CO', payFrequency: 'monthly', payType: 'salary', payRate: '1000' })).status, 403);
    assert.equal((await bk.c.call('PATCH', `/api/companies/${co.id}/settings`, { suiRatePct: '1.0' })).status, 403);
    assert.equal((await bk.c.call('POST', `/api/companies/${co.id}/members`, { email: 'bookkeeper@example.com', role: 'owner' })).status, 403);
    // Owner cannot demote the last owner (themselves)
    assert.equal((await owner.c.call('POST', `/api/companies/${co.id}/members`, { email: 'owner@example.com', role: 'viewer' })).status, 400);
    const members = (await viewer.c.call('GET', `/api/companies/${co.id}/members`)).body;
    assert.equal(members.length, 3);
  });

  await t.test('reopening closed books needs the owner and a fresh two-factor code', async () => {
    assert.equal((await owner.c.call('POST', `/api/companies/${co.id}/lock`, { through: '2026-01-31' })).status, 200);
    const noCode = await owner.c.call('POST', `/api/companies/${co.id}/lock`, { through: null, reason: 'CPA adjustments' });
    assert.equal(noCode.status, 401);
    // Each code works once; simulate the clock moving on since the owner's last sign-in code.
    await db.pool.query("UPDATE users SET totp_last_counter = 0 WHERE email = 'owner@example.com'");
    const ok = await owner.c.call('POST', `/api/companies/${co.id}/lock`, { through: null, reason: 'CPA adjustments', mfaCode: code(owner.secret) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  await t.test('SSN is encrypted at rest; API shows last 4 only', async () => {
    const r = await owner.c.call('POST', `/api/companies/${co.id}/employees`, {
      firstName: 'Kim', lastName: 'Ortiz', workState: 'CO', payFrequency: 'monthly', payType: 'salary', payRate: '5000', ssn: '123-45-6789', w4: {},
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.ssnLast4, '6789');
    assert.equal(JSON.stringify(r.body).includes('12345'), false);
    const { rows: [e] } = await db.pool.query('SELECT ssn_enc FROM employees WHERE id = $1', [r.body.id]);
    assert.match(e.ssn_enc, /^v1:/);
    assert.equal(e.ssn_enc.includes('6789'), false);
    assert.equal((await owner.c.call('POST', `/api/companies/${co.id}/employees`, { firstName: 'Bad', lastName: 'Ssn', workState: 'CO', payFrequency: 'monthly', payType: 'salary', payRate: '1', ssn: '666-12-3456' })).status, 400);
  });

  await t.test('row-level security hides other companies even from raw SQL as the app role', async () => {
    const other = (await owner.c.call('POST', '/api/companies', { name: 'Second Co', homeState: 'TX', fiscalYearStartMonth: 1 })).body;
    const c = await db.appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('zacc.company_id', $1, true)", [co.id]);
      const { rows } = await c.query('SELECT DISTINCT company_id FROM accounts');
      assert.deepEqual(rows.map((r) => r.company_id), [co.id]);
      await assert.rejects(c.query('UPDATE journal_lines SET debit_cents = 1'), /permission denied/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      const none = await c.query('SELECT count(*)::int AS n FROM journal_entries');
      assert.equal(none.rows[0].n, 0, 'no company in scope → no rows');
      await assert.rejects(c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable'), /must be owner/);
      await c.query('ROLLBACK');
    } finally { c.release(); }
    assert.ok(other.id);
  });

  await t.test('user mistakes are 4xx with a readable message, never 500', async () => {
    const cases = [
      ['GET', `/api/companies/${co.id}/entries?limit=-5&from=abc`],
      ['GET', `/api/companies/${co.id}/reports/income-statement?from=2026-02-30&to=2026-03-01`],
      ['GET', `/api/companies/${co.id}/accounts/${A['1000']}/register?from=2026-13-01`],
      ['POST', `/api/companies/${co.id}/lock`, { through: '2026-13-45' }],
      ['POST', `/api/companies/${co.id}/entries`, { date: '2026-01-01', lines: [{ accountId: A['1000'], debitCents: 9007199254740991 }, { accountId: A['4000'], creditCents: 9007199254740991 }] }],
      ['POST', `/api/companies/${co.id}/entries`, '{not json'],
      ['POST', `/api/companies/${co.id}/employees`, { firstName: 'X', lastName: 'Y', workState: 'CO', payFrequency: 'weekly', payType: 'salary', payRate: '99999999999999999' }],
      ['POST', `/api/companies/${co.id}/employees`, { firstName: 5, lastName: [], workState: 'CO' }],
      ['POST', '/api/companies', { name: 'a\u0000b', homeState: 'TX', fiscalYearStartMonth: 1 }],
      ['POST', '/api/companies', { name: 'ok', homeState: 'NY' }],
      ['POST', `/api/companies/${co.id}/entries`, 'x'.repeat(2_000_000)],
      ['GET', '/api/companies/00000000-0000-0000-0000-000000000000/accounts'],
    ];
    for (const [m, p, b] of cases) {
      const r = await owner.c.call(m, p, b);
      assert.ok(r.status >= 400 && r.status < 500, `${m} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(r.body?.error, `${p} has error text`);
      assert.doesNotMatch(r.body.error, /violates|constraint|relation|syntax/i, 'no raw database text');
    }
  });

  await t.test('cross-site requests and foreign Host headers are refused', async () => {
    const lock = `/api/companies/${co.id}/lock`;
    assert.equal((await owner.c.call('POST', lock, '{"through":null}', { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await owner.c.call('POST', lock, { through: '2026-01-01' }, { origin: 'http://evil.example' })).status, 403);
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/companies', headers: { host: 'attacker.example' } },
        (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 421);
    assert.equal((await owner.c.call('POST', lock, { through: '2026-01-01' }, { origin: base })).status, 200);
  });
});
