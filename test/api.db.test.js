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
    const enabledAt = Date.now();
    const en = await c.call('POST', '/api/auth/mfa/enable', { code: totpCode(setup.body.secret, enabledAt) });
    assert.equal(en.status, 200, JSON.stringify(en.body));
    assert.equal(en.body.recoveryCodes.length, 8);
    return { c, secret: setup.body.secret, recoveryCodes: en.body.recoveryCodes, enabledAt };
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
    // The code used to enable 2FA was already used → rejected; the next 30-second window works.
    // (Codes are taken from the enable time, not "now", so a window boundary can't make this flaky.)
    assert.equal((await c.call('POST', '/api/auth/mfa/verify', { code: totpCode(owner.secret, owner.enabledAt) })).status, 401);
    assert.equal((await c.call('POST', '/api/auth/mfa/verify', { code: totpCode(owner.secret, owner.enabledAt + 30_000) })).status, 200);
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
    const before = (await owner.c.call('GET', `/api/companies/${co.id}/entries`)).body.entries.length;
    const r = await owner.c.call('POST', `/api/companies/${co.id}/entries`, { date: '2026-01-06', lines: [{ accountId: A['1000'], debit: '5' }, { accountId: A['4000'], credit: '4' }] });
    assert.equal(r.status, 400);
    assert.equal((await owner.c.call('GET', `/api/companies/${co.id}/entries`)).body.entries.length, before);
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

  await t.test('recurring entries, search, duplicate-safe saves and the books check (restricted role)', async () => {
    const base2 = `/api/companies/${co.id}`;
    const rec = await owner.c.call('POST', `${base2}/recurring`, {
      name: 'Office rent', frequency: 'monthly', startDate: '2026-08-01', endDate: '2026-10-01', memo: 'Rent',
      lines: [{ accountId: A['6300'], debit: '1800' }, { accountId: A['1000'], credit: '1800' }] });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    const bad = await owner.c.call('POST', `${base2}/recurring`, { name: 'Bad', frequency: 'monthly', startDate: '2026-08-01',
      lines: [{ accountId: A['6300'], debit: '1' }, { accountId: A['1000'], credit: '2' }] });
    assert.equal(bad.status, 400);
    const due = await owner.c.call('POST', `${base2}/recurring/post-due`, {});
    assert.deepEqual(due.body.posted.map((p) => p.date), ['2026-08-01', '2026-09-01', '2026-10-01']);
    assert.equal((await owner.c.call('POST', `${base2}/recurring/post-due`, {})).body.posted.length, 0, 'never posts twice');
    const list = (await owner.c.call('GET', `${base2}/recurring`)).body;
    assert.equal(list[0].postedCount, 3);
    assert.equal(list[0].nextDate, null);

    // Search
    const found = (await owner.c.call('GET', `${base2}/entries?text=rent&source=recurring`)).body;
    assert.equal(found.total, 3);
    const ranged = (await owner.c.call('GET', `${base2}/entries?accountId=${A['6300']}&from=2026-09-01&to=2026-09-30&min=1800&max=1800`)).body;
    assert.equal(ranged.total, 1);
    const byNumber = (await owner.c.call('GET', `${base2}/entries?text=%23${found.entries[0].number}`)).body;
    assert.equal(byNumber.entries[0].number, found.entries[0].number);
    assert.equal((await owner.c.call('GET', `${base2}/entries?min=abc`)).status, 400);
    assert.equal((await owner.c.call('GET', `${base2}/entries?text=100%25`)).body.total, 0, '% is literal');

    // Same Idempotency-Key twice = one entry
    const body = { date: '2026-10-02', memo: 'Retry me', fromAccountId: A['4000'], toAccountId: A['1000'], amount: '50' };
    const h = { 'idempotency-key': 'save-click-0001' };
    const r1 = await owner.c.call('POST', `${base2}/entries/simple`, body, h);
    const r2 = await owner.c.call('POST', `${base2}/entries/simple`, body, h);
    assert.equal(r1.status, 201); assert.equal(r2.status, 201);
    assert.equal(r1.body.id, r2.body.id);
    assert.equal(r2.body.replayed, true);
    assert.equal((await owner.c.call('GET', `${base2}/entries?text=Retry`)).body.total, 1);

    // Books check: runs as the restricted role and records an anchor
    const chk = await owner.c.call('POST', `${base2}/books-check`, {});
    assert.equal(chk.status, 200, JSON.stringify(chk.body));
    assert.equal(chk.body.ok, true, JSON.stringify(chk.body.problems));
    const latest = (await owner.c.call('GET', `${base2}/books-check`)).body;
    assert.equal(latest.ok, true);
    assert.equal(latest.anchorSeq, chk.body.anchor.seq);

    // Stop
    const stop = await owner.c.call('POST', `${base2}/recurring/${list[0].id}/stop`, {});
    assert.equal(stop.body.isActive, false);
  });

  await t.test('banking through the restricted role: large import, post, rule, reconcile', async () => {
    const b = `/api/companies/${co.id}/bank-accounts/${A['1000']}`;
    // ~1.5 MB file: bigger than the normal 1 MB request limit, allowed for statement imports.
    const rows = Array.from({ length: 30000 }, (_, i) => `11/${String((i % 28) + 1).padStart(2, '0')}/2026,STORE ${i} ${'x'.repeat(20)},-1.00`);
    const big = await owner.c.call('POST', `${b}/import`, { fileName: 'big.csv', content: `Date,Description,Amount\n${rows.join('\n')}`, preview: true });
    assert.equal(big.status, 400, 'over the 5,000-row limit');
    assert.match(big.body.error, /5000/);
    const csv = 'Date,Description,Amount\n11/02/2026,GRAINGER SUPPLY,-310.25\n11/03/2026,CLIENT DEPOSIT,5000.00\n';
    const imp = await owner.c.call('POST', `${b}/import`, { fileName: 'nov.csv', content: csv });
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    assert.equal(imp.body.new, 2);
    const rule = await owner.c.call('POST', `/api/companies/${co.id}/bank-rules`, { matchText: 'grainger', direction: 'out', accountId: A['6200'] });
    assert.equal(rule.status, 201, JSON.stringify(rule.body));
    assert.equal(rule.body.applied, 1);
    const txs = (await owner.c.call('GET', `${b}/transactions`)).body;
    assert.equal(txs.length, 2);
    for (const tx of txs) {
      const r = await owner.c.call('POST', `/api/companies/${co.id}/bank-transactions/${tx.id}/post`, { accountId: tx.suggestedAccountId ?? A['4000'] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const rec = await owner.c.call('POST', `${b}/reconciliations`, { statementDate: '2026-11-30', endingBalance: '0' });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    const sheet = (await owner.c.call('GET', `/api/companies/${co.id}/reconciliations/${rec.body.id}`)).body;
    assert.ok(sheet.lines.length >= 2);
    const tick = await owner.c.call('POST', `/api/companies/${co.id}/reconciliations/${rec.body.id}/lines`, { lineIds: [sheet.lines[0].id], cleared: true });
    assert.equal(tick.status, 200, JSON.stringify(tick.body));
    assert.equal((await owner.c.call('POST', `/api/companies/${co.id}/reconciliations/${rec.body.id}/complete`, {})).status, 400, 'difference not zero');
    assert.equal((await owner.c.call('DELETE', `/api/companies/${co.id}/reconciliations/${rec.body.id}`, {})).status, 200);
    // Another company's member can't see this account's bank lines.
    const other = await newUser('banker@example.com');
    assert.equal((await other.c.call('GET', `${b}/transactions`)).status, 404);
  });

  await t.test('importing books through the restricted role; bookkeepers cannot import', async () => {
    const csv = 'Entry,Date,Memo,Account,Debit,Credit\n1,12/01/2026,Imported rent,6300,100.00,\n1,12/01/2026,Imported rent,1000,,100.00\n';
    const body = { kind: 'journal', fileName: 'je.csv', content: csv };
    const prev = await owner.c.call('POST', `/api/companies/${co.id}/imports/preview`, body);
    assert.equal(prev.status, 200, JSON.stringify(prev.body));
    assert.equal(prev.body.preview, true);
    const r = await owner.c.call('POST', `/api/companies/${co.id}/imports`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const list = (await owner.c.call('GET', `/api/companies/${co.id}/imports`)).body;
    assert.equal(list[0].entries, 1);
    const u = await owner.c.call('POST', `/api/companies/${co.id}/imports/${list[0].id}/undo`, {});
    assert.equal(u.status, 200, JSON.stringify(u.body));
    const bk = await newUser('bk-import@example.com');
    await owner.c.call('POST', `/api/companies/${co.id}/members`, { email: 'bk-import@example.com', role: 'bookkeeper' });
    assert.equal((await bk.c.call('POST', `/api/companies/${co.id}/imports/preview`, body)).status, 403);
  });

  await t.test('invoices, payments and aging through the restricted role', async () => {
    const base = `/api/companies/${co.id}`;
    const cust = await owner.c.call('POST', `${base}/customers`, { name: 'Front Range Builders', termsDays: 30 });
    assert.equal(cust.status, 201, JSON.stringify(cust.body));
    const inv = { contactId: cust.body.id, date: '2026-12-02', taxRate: '2.9', lines: [{ accountId: A['4000'], description: 'Beam calc', amount: '1000', taxable: true }] };
    const i1 = await owner.c.call('POST', `${base}/invoices`, inv, { 'Idempotency-Key': 'api-inv-000001' });
    assert.equal(i1.status, 201, JSON.stringify(i1.body));
    assert.equal(i1.body.totalCents, 102900);
    const again = await owner.c.call('POST', `${base}/invoices`, inv, { 'Idempotency-Key': 'api-inv-000001' });
    assert.equal(again.body.id, i1.body.id);
    assert.equal((await owner.c.call('GET', `${base}/invoices`)).body.length, 1);
    const pay = await owner.c.call('POST', `${base}/payments-received`, { contactId: cust.body.id, date: '2026-12-10', accountId: A['1000'], method: 'ach',
      applications: [{ documentId: i1.body.id, amount: '1029.00' }] });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    const doc = (await owner.c.call('GET', `${base}/documents/${i1.body.id}`)).body;
    assert.equal(doc.status, 'paid');
    const over = await owner.c.call('POST', `${base}/payments-received`, { contactId: cust.body.id, date: '2026-12-11', accountId: A['1000'], applications: [{ documentId: i1.body.id, amount: '1' }] });
    assert.equal(over.status, 400);
    assert.match(over.body.error, /more than its balance/);
    const v = await owner.c.call('POST', `${base}/payments/${pay.body.id}/void`, {});
    assert.equal(v.status, 200, JSON.stringify(v.body));
    const aging = (await owner.c.call('GET', `${base}/reports/ar-aging?asOf=2026-12-31`)).body;
    assert.equal(aging.totals.totalCents, 102900);
    assert.equal(aging.ties, true);
    const direct = await owner.c.call('POST', `${base}/entries/simple`, { date: '2026-12-12', fromAccountId: A['1100'], toAccountId: A['1000'], amount: '5' });
    assert.equal(direct.status, 400);
    assert.match(direct.body.error, /Sales tab/);
    // The runtime role can't rewrite a saved invoice's amounts, even with raw SQL.
    await assert.rejects(db.appPool.query('UPDATE documents SET total_cents = 1'), /permission denied/);
    await assert.rejects(db.appPool.query('DELETE FROM payment_applications'), /permission denied/);
    const outsider = await newUser('ar-outsider@example.com');
    assert.equal((await outsider.c.call('GET', `${base}/invoices`)).status, 404);
  });

  await t.test('payroll run, pay stub and tax liabilities through the restricted role', async () => {
    const base = `/api/companies/${co.id}`;
    const body = { payFrequency: 'monthly', periodStart: '2026-12-01', periodEnd: '2026-12-31', payDate: '2026-12-31', paidFromAccountId: A['1000'] };
    const prev = await owner.c.call('POST', `${base}/payroll-runs/preview`, body);
    assert.equal(prev.status, 200, JSON.stringify(prev.body));
    assert.ok(prev.body.paychecks.length >= 1);
    const run = await owner.c.call('POST', `${base}/payroll-runs`, body, { 'Idempotency-Key': 'api-run-2026-12' });
    assert.equal(run.status, 201, JSON.stringify(run.body));
    assert.equal((await owner.c.call('POST', `${base}/payroll-runs`, body, { 'Idempotency-Key': 'api-run-2026-12' })).body.id, run.body.id);
    assert.equal((await owner.c.call('GET', `${base}/payroll-runs`)).body.length, 1);
    const stub = await owner.c.call('GET', `${base}/paychecks/${run.body.paychecks[0].id}/stub`);
    assert.equal(stub.status, 200, JSON.stringify(stub.body));
    assert.equal(stub.body.periodEnd, '2026-12-31');
    const liab = await owner.c.call('GET', `${base}/reports/payroll-liabilities?from=2026-12-01&to=2026-12-31`);
    assert.equal(liab.status, 200, JSON.stringify(liab.body));
    assert.ok(liab.body.totalCents > 0);
    const bk = await newUser('bk-payroll@example.com');
    await owner.c.call('POST', `${base}/members`, { email: 'bk-payroll@example.com', role: 'bookkeeper' });
    assert.equal((await bk.c.call('GET', `${base}/paychecks/${run.body.paychecks[0].id}/stub`)).status, 403);
    assert.equal((await bk.c.call('POST', `${base}/payroll-runs/preview`, body)).status, 403);
    await assert.rejects(db.appPool.query('UPDATE payroll_runs SET gross_cents = 1'), /permission denied/);
  });

  await t.test('staff role, custom roles and departments', async () => {
    const base = `/api/companies/${co.id}`;
    const dept = await owner.c.call('POST', `${base}/departments`, { name: 'Engineering' });
    assert.equal(dept.status, 201, JSON.stringify(dept.body));
    assert.equal((await owner.c.call('POST', `${base}/departments`, { name: ' engineering ' })).status, 400);
    const pm = await owner.c.call('POST', `${base}/roles`, { name: 'Project Manager', permissions: ['view_books', 'invoices', 'time_approve'] });
    assert.equal(pm.status, 201, JSON.stringify(pm.body));
    assert.equal((await owner.c.call('POST', `${base}/roles`, { name: 'Bookkeeper', permissions: ['post'] })).status, 400, 'built-in name');
    assert.equal((await owner.c.call('POST', `${base}/roles`, { name: 'Bad', permissions: ['fly'] })).status, 400, 'unknown permission');

    const staff = await newUser('staff@example.com');
    const add = await owner.c.call('POST', `${base}/members`, { email: 'staff@example.com', role: 'staff', departmentId: dept.body.id });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    const me = (await staff.c.call('GET', base)).body;
    assert.deepEqual(me.permissions, ['invoices', 'time_own']);
    assert.equal(me.departmentId, dept.body.id);
    // Staff can make invoices...
    assert.equal((await staff.c.call('GET', `${base}/accounts`)).status, 200);
    const cust = await staff.c.call('POST', `${base}/customers`, { name: 'Staff Customer' });
    assert.equal(cust.status, 201, JSON.stringify(cust.body));
    const inv = await staff.c.call('POST', `${base}/invoices`, { contactId: cust.body.id, date: '2026-12-15', lines: [{ accountId: A['4100'], amount: '250' }] });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal((await staff.c.call('GET', `${base}/documents/${inv.body.id}`)).status, 200);
    // ...but can't see the books, bills or payroll, or void.
    for (const path of ['/reports/trial-balance', '/entries', '/bills', '/vendors', '/employees', '/reports/ap-aging']) {
      assert.equal((await staff.c.call('GET', base + path)).status, 403, path);
    }
    assert.equal((await staff.c.call('POST', `${base}/documents/${inv.body.id}/void`, {})).status, 403);
    assert.equal((await staff.c.call('POST', `${base}/entries/simple`, { date: '2026-12-15', fromAccountId: A['4000'], toAccountId: A['1000'], amount: '1' })).status, 403);
    // A vendor's record is off limits even by id.
    const v = (await owner.c.call('POST', `${base}/vendors`, { name: 'Steel Supplier' })).body;
    assert.equal((await staff.c.call('PATCH', `${base}/contacts/${v.id}`, { phone: '1' })).status, 403);

    // Custom role: sees the books and invoices, can't post journal entries.
    const pmUser = await newUser('pm@example.com');
    assert.equal((await owner.c.call('POST', `${base}/members`, { email: 'pm@example.com', role: pm.body.id })).status, 201);
    assert.equal((await pmUser.c.call('GET', `${base}/reports/trial-balance`)).status, 200);
    const denied = await pmUser.c.call('POST', `${base}/entries/simple`, { date: '2026-12-15', fromAccountId: A['4000'], toAccountId: A['1000'], amount: '1' });
    assert.equal(denied.status, 403);
    assert.match(denied.body.error, /Project Manager/);
    const members = (await owner.c.call('GET', `${base}/members`)).body;
    assert.equal(members.find((m) => m.email === 'pm@example.com').roleName, 'Project Manager');
    assert.equal(members.find((m) => m.email === 'staff@example.com').departmentName, 'Engineering');
    // Roles and departments in use can't be deleted; changing a role's checkboxes applies right away.
    assert.equal((await owner.c.call('DELETE', `${base}/roles/${pm.body.id}`, {})).status, 400);
    assert.equal((await owner.c.call('DELETE', `${base}/departments/${dept.body.id}`, {})).status, 400);
    assert.equal((await owner.c.call('PATCH', `${base}/roles/${pm.body.id}`, { name: 'Project Manager', permissions: ['invoices'] })).status, 200);
    assert.equal((await pmUser.c.call('GET', `${base}/reports/trial-balance`)).status, 403);
    assert.equal((await staff.c.call('POST', `${base}/roles`, { name: 'Sneaky', permissions: ['admin'] })).status, 403);
    assert.equal((await staff.c.call('POST', `${base}/members`, { email: 'staff@example.com', role: 'owner' })).status, 403);
  });

  await t.test('timesheets: enter, approve by department, import HoursTracker, pay through payroll', async () => {
    const base = `/api/companies/${co.id}`;
    const eng = (await owner.c.call('GET', `${base}/departments`)).body.find((d) => d.name === 'Engineering');
    const field = (await owner.c.call('POST', `${base}/departments`, { name: 'Field' })).body;
    const lead = (await owner.c.call('POST', `${base}/roles`, { name: 'Crew Lead', permissions: ['time_own', 'time_approve'] })).body;
    const foreman = await newUser('foreman@example.com');
    const worker = await newUser('worker@example.com');
    const other = await newUser('other@example.com');
    assert.equal((await owner.c.call('POST', `${base}/members`, { email: 'foreman@example.com', role: lead.id, departmentId: eng.id })).status, 201);
    assert.equal((await owner.c.call('POST', `${base}/members`, { email: 'worker@example.com', role: 'staff', departmentId: eng.id })).status, 201);
    assert.equal((await owner.c.call('POST', `${base}/members`, { email: 'other@example.com', role: 'staff', departmentId: field.id })).status, 201);
    const members = (await owner.c.call('GET', `${base}/members`)).body;
    const uid = (e) => members.find((m) => m.email === e).id;

    // Jobs: approvers and the owner add them; staff can only pick them.
    const job = await foreman.c.call('POST', `${base}/jobs`, { name: 'Smith Residence', code: 'J-101' });
    assert.equal(job.status, 201, JSON.stringify(job.body));
    assert.equal((await worker.c.call('POST', `${base}/jobs`, { name: 'Nope' })).status, 403);
    assert.equal((await worker.c.call('GET', `${base}/jobs`)).body.length, 1);

    // A week of 9-hour days (Mon–Fri), entered by the worker.
    const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
    const ids = [];
    for (const date of days) {
      const r = await worker.c.call('POST', `${base}/time-entries`, { date, start: '7:00 AM', end: '4:00 PM', jobId: job.body.id, notes: 'framing' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.hours, '9.00');
      ids.push(r.body.id);
    }
    const bad = await worker.c.call('POST', `${base}/time-entries`, { date: '2026-11-02', hours: '16' });
    assert.equal(bad.status, 400, 'more than 24 hours in a day');
    assert.match(bad.body.error, /24 hours/);
    // Staff can't enter time for someone else, or see it.
    assert.equal((await other.c.call('POST', `${base}/time-entries`, { userId: uid('worker@example.com'), date: '2026-11-02', hours: '1' })).status, 400);
    assert.equal((await other.c.call('GET', `${base}/time-entries`)).body.length, 0);
    assert.equal((await other.c.call('PATCH', `${base}/time-entries/${ids[0]}`, { date: '2026-11-02', hours: '1' })).status, 400);

    assert.equal((await worker.c.call('POST', `${base}/time-entries/submit`, { ids })).body.submitted, 5);
    // The worker can't approve their own time; the foreman (same department) sees and approves it.
    assert.equal((await worker.c.call('POST', `${base}/time-entries/review`, { ids, approve: true })).status, 403);
    const seen = (await foreman.c.call('GET', `${base}/time-entries?status=submitted`)).body;
    assert.equal(seen.length, 5);
    // A crew lead in another department couldn't: other is in Field, so the foreman can't approve them.
    const o = (await other.c.call('POST', `${base}/time-entries`, { date: '2026-11-02', hours: '8' })).body;
    await other.c.call('POST', `${base}/time-entries/submit`, { ids: [o.id] });
    const cross = await foreman.c.call('POST', `${base}/time-entries/review`, { ids: [o.id], approve: true });
    assert.equal(cross.status, 400);
    assert.match(cross.body.error, /can't approve/);
    const back = await foreman.c.call('POST', `${base}/time-entries/review`, { ids: [ids[4]], approve: false, note: 'lunch?' });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    await worker.c.call('PATCH', `${base}/time-entries/${ids[4]}`, { date: '2026-11-06', start: '7:00 AM', end: '4:00 PM', breakMinutes: 0 });
    await worker.c.call('POST', `${base}/time-entries/submit`, { ids: [ids[4]] });
    assert.equal((await foreman.c.call('POST', `${base}/time-entries/review`, { ids, approve: true })).body.approved, 5);
    assert.equal((await worker.c.call('PATCH', `${base}/time-entries/${ids[0]}`, { date: '2026-11-02', hours: '1' })).status, 400, 'approved time is locked');

    // HoursTracker import: the next week, two shifts; importing the same file again skips both.
    const csv = 'Job,Clocked In,Clocked Out,Duration,Hourly Rate,Earnings,Comment\n'
      + 'Smith Residence,11/09/2026 7:00 AM,11/09/2026 3:00 PM,8.00,30,240,trim\n'
      + 'New Bridge,11/10/2026 7:00 AM,11/10/2026 1:30 PM,6.50,30,195,survey\n';
    const pre = await worker.c.call('POST', `${base}/time-entries/import`, { fileName: 'hours.csv', content: csv, preview: true });
    assert.equal(pre.status, 200, JSON.stringify(pre.body));
    assert.equal(pre.body.format, 'HoursTracker');
    assert.deepEqual([pre.body.toImport, pre.body.hours, pre.body.newJobs], [2, '14.50', ['New Bridge']]);
    assert.equal((await worker.c.call('POST', `${base}/time-entries/import`, { content: csv, createJobs: true })).status, 400, 'staff can\'t add jobs');
    const imp = await worker.c.call('POST', `${base}/time-entries/import`, { fileName: 'hours.csv', content: csv });
    assert.equal(imp.body.imported, 2);
    const again = await worker.c.call('POST', `${base}/time-entries/import`, { fileName: 'hours.csv', content: csv });
    assert.deepEqual([again.body.imported, again.body.duplicates], [0, 2]);
    const imported = (await worker.c.call('GET', `${base}/time-entries?from=2026-11-09&to=2026-11-15`)).body;
    assert.equal(imported.find((e) => e.date === '2026-11-10').notes, 'Job: New Bridge · survey', 'unknown job kept in the notes');
    assert.equal(imported.find((e) => e.date === '2026-11-09').jobName, 'Smith Residence');

    // Payroll: link the worker to an hourly employee; approved hours fill the run with overtime split.
    const emp = (await owner.c.call('POST', `${base}/employees`, { firstName: 'Wes', lastName: 'Worker', workState: 'CO', payFrequency: 'weekly', payType: 'hourly', payRate: '30.00', w4: { filingStatus: 'single' } })).body;
    assert.equal((await worker.c.call('PATCH', `${base}/employees/${emp.id}/user`, { userId: uid('worker@example.com') })).status, 403);
    assert.equal((await owner.c.call('PATCH', `${base}/employees/${emp.id}/user`, { userId: uid('worker@example.com') })).status, 200);
    const hrs = await owner.c.call('GET', `${base}/payroll-hours?payFrequency=weekly&periodStart=2026-11-01&periodEnd=2026-11-07`);
    assert.equal(hrs.status, 200, JSON.stringify(hrs.body));
    const w = hrs.body.employees.find((e) => e.employeeId === emp.id);
    assert.deepEqual([w.hours, w.overtimeHours, w.doubleTimeHours], ['40.00', '5.00', '0.00']);
    const run = await owner.c.call('POST', `${base}/payroll-runs`, { payFrequency: 'weekly', periodStart: '2026-11-01', periodEnd: '2026-11-07', payDate: '2026-11-13',
      paidFromAccountId: A['1000'], fromTimesheets: true, items: [{ employeeId: emp.id, hours: w.hours, overtimeHours: w.overtimeHours }] });
    assert.equal(run.status, 201, JSON.stringify(run.body));
    assert.equal(run.body.grossCents, 40 * 3000 + 5 * 4500);
    assert.equal(run.body.timeEntriesPaid, 5);
    const paid = (await worker.c.call('GET', `${base}/time-entries?status=paid`)).body;
    assert.equal(paid.length, 5);
    assert.equal((await foreman.c.call('POST', `${base}/time-entries/review`, { ids: [ids[0]], approve: false })).status, 400, 'paid time is final');
    assert.equal((await worker.c.call('DELETE', `${base}/time-entries/${ids[0]}`, {})).status, 400);
    const after = (await owner.c.call('GET', `${base}/payroll-hours?payFrequency=weekly&periodStart=2026-11-01&periodEnd=2026-11-07`)).body;
    assert.equal(after.employees.find((e) => e.employeeId === emp.id).hours, '0.00', 'nothing left to pay');

    // Voiding the paycheck reopens its hours; the next run (a later period) picks them up and says so.
    const pcs = (await owner.c.call('GET', `${base}/paychecks`)).body;
    const wesCheck = pcs.find((p) => p.employee === 'Wes Worker');
    const v = await owner.c.call('POST', `${base}/paychecks/${wesCheck.id}/void`, { reason: 'wrong rate' });
    assert.equal(v.status, 201, JSON.stringify(v.body));
    assert.equal(v.body.timeEntriesReopened, 5);
    assert.equal((await worker.c.call('GET', `${base}/time-entries?status=unpaid`)).body.length, 5);
    // Next week: the two imported shifts, approved now, plus last week's reopened hours.
    const nextIds = imported.map((e) => e.id);
    await worker.c.call('POST', `${base}/time-entries/submit`, { ids: nextIds });
    await foreman.c.call('POST', `${base}/time-entries/review`, { ids: nextIds, approve: true });
    const next = (await owner.c.call('GET', `${base}/payroll-hours?payFrequency=weekly&periodStart=2026-11-08&periodEnd=2026-11-14`)).body.employees.find((e) => e.employeeId === emp.id);
    assert.deepEqual([next.hours, next.overtimeHours], ['54.50', '5.00'], '40 + 14.5 regular, last week\'s 5 overtime');
    assert.ok(next.warnings.some((w) => /45.00 unpaid hours from before this period/.test(w)), JSON.stringify(next.warnings));
    const run2 = await owner.c.call('POST', `${base}/payroll-runs`, { payFrequency: 'weekly', periodStart: '2026-11-08', periodEnd: '2026-11-14', payDate: '2026-11-20',
      paidFromAccountId: A['1000'], fromTimesheets: true, items: [{ employeeId: emp.id, hours: next.hours, overtimeHours: next.overtimeHours }] });
    assert.equal(run2.status, 201, JSON.stringify(run2.body));
    assert.equal(run2.body.timeEntriesPaid, 7);

    // FUTA credit-reduction estimate (owner setting) is validated.
    assert.equal((await owner.c.call('PATCH', `${base}/settings`, { futaCreditReduction: { CA: '9' } })).status, 400);
    assert.equal((await owner.c.call('PATCH', `${base}/settings`, { futaCreditReduction: { NY: '1' } })).status, 400);
    const set = await owner.c.call('PATCH', `${base}/settings`, { futaCreditReduction: { CA: '1.2', CO: '' } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual(set.body.futa_credit_reduction, { CA: '1.2' });

    // Hours by job.
    const sum = (await owner.c.call('GET', `${base}/reports/time-summary?from=2026-11-01&to=2026-11-15`)).body;
    assert.equal(sum.jobs.find((j) => j.jobName === 'Smith Residence').minutes, 45 * 60 + 8 * 60);
    assert.equal((await other.c.call('GET', `${base}/reports/time-summary?from=2026-11-01&to=2026-11-15`)).body.totalMinutes, 8 * 60, 'staff see only their own');
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
