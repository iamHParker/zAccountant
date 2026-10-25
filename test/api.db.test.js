// End-to-end tests through HTTP, with the server connected as the RESTRICTED runtime role
// (row-level security on, no UPDATE/DELETE on history) — the same way production runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { withScope } from '../src/db/pool.js';
import { totpCode } from '../src/security/totp.js';

process.env.AUTH_RATE_LIMIT = '1000';
process.env.DEVELOPER_EMAILS = 'dev@example.com';
process.env.ADMIN_EMAILS = 'admin@example.com';

test('HTTP API', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase({ withAppRole: true });
  const logs = [];
  const server = createApp(db.appPool, { log: (line) => logs.push(JSON.parse(line)) }).listen(0, '127.0.0.1');
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
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* a file download */ }
      return { status: r.status, body: json, text, headers: Object.fromEntries(r.headers) };
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

  await t.test('professional-services invoice: saved rates, line dates, project, letterhead, logo, pinned tax rate', async () => {
    const base = `/api/companies/${co.id}`;
    const cust = (await owner.c.call('POST', `${base}/customers`, { name: 'Pool Builder Inc', address: '1 Main St\nIrving, TX 75061', termsDays: 20 })).body;
    const starter = await owner.c.call('POST', `${base}/invoice-items/starter`, { accountId: A['4100'] });
    assert.equal(starter.status, 200, JSON.stringify(starter.body));
    assert.equal(starter.body.added, 10);
    assert.equal((await owner.c.call('POST', `${base}/invoice-items/starter`, { accountId: A['4100'] })).body.added, 0, 'no duplicates');
    const std = starter.body.items.find((x) => x.name === 'Eng Std Rate');
    const upd = await owner.c.call('PATCH', `${base}/invoice-items/${std.id}`, { rate: '425', taxable: true });
    assert.equal(upd.body.rateCents, 42500);
    const rent = starter.body.items.find((x) => x.name === 'Equipment rental');
    assert.equal((await owner.c.call('POST', `${base}/invoice-items`, { name: 'Bad', accountId: A['5000'] })).status, 400, 'must be an income account');

    const pin = await owner.c.call('PUT', `${base}/default-tax-rate`, { rate: '8.25' });
    assert.equal(pin.status, 200, JSON.stringify(pin.body));
    assert.equal((await owner.c.call('GET', base)).body.default_sales_tax_rate, '8.25');
    assert.equal((await owner.c.call('PUT', `${base}/default-tax-rate`, { rate: '25' })).status, 400);
    const lh = await owner.c.call('PUT', `${base}/letterhead`, { address: '1 Woodrock Dr\r\nRound Rock TX 78681', note: 'TAX ID# 00-0000000\nTX Firm 000', footer: 'Thank you' });
    assert.equal(lh.body.address, '1 Woodrock Dr\nRound Rock TX 78681');

    // A 1×1 PNG as the logo; members read it back as a picture (not a download).
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    assert.equal((await owner.c.call('PUT', `${base}/logo`, { picture: 'data:image/png;base64,AAAA' })).status, 400, 'not really a PNG');
    const huge = await owner.c.call('PUT', `${base}/logo`, { picture: `data:image/png;base64,${'A'.repeat(3_000_000)}` });
    assert.equal(huge.status, 413);
    assert.match(huge.body.error, /too large to send \(the limit here is 2 MB\)/);
    assert.equal((await owner.c.call('PUT', `${base}/logo`, { picture: `data:image/png;base64,${png}` })).status, 200);
    assert.ok((await owner.c.call('GET', base)).body.logoVersion);
    const logo = await owner.c.call('GET', `${base}/logo`);
    assert.equal(logo.headers['content-type'], 'image/png');
    assert.match(logo.headers['content-disposition'], /^inline/);

    // Homer's sample: 2.5 h at a special rate of $531.25 (1.25 × $425), taxable at 8.25%, plus equipment rent (not taxed).
    //   2.5 × 531.25 = 1,328.125 → $1,328.13 (half-up);  tax 8.25% × 1,328.13 = 109.5707 → $109.57
    //   rent 1 × 350.00 = $350.00;  total 1,328.13 + 350.00 + 109.57 = $1,787.70
    const i = await owner.c.call('POST', `${base}/invoices`, {
      contactId: cust.id, number: '26-134', date: '2026-10-14', taxRate: '8.25', project: 'Project name\n4424 Main Ave\nAustin, Texas 78731',
      lines: [
        { itemId: std.id, serviceDate: '2026-10-14', accountId: A['4100'], description: 'Report', quantity: '2.5', unitPrice: '531.25', taxable: true },
        { itemId: rent.id, serviceDate: '2026-10-13', accountId: A['4100'], description: 'Crack monitor rent', quantity: '1', unitPrice: '350' },
      ] });
    assert.equal(i.status, 201, JSON.stringify(i.body));
    assert.deepEqual([i.body.subtotalCents, i.body.taxCents, i.body.totalCents], [167813, 10957, 178770]);
    assert.equal(i.body.project, 'Project name\n4424 Main Ave\nAustin, Texas 78731');
    assert.deepEqual(i.body.lines.map((l) => [l.serviceDate, l.itemName, l.amountCents]), [['2026-10-14', 'Eng Std Rate', 132813], ['2026-10-13', 'Equipment rental', 35000]]);
    assert.equal(i.body.contact.termsDays, 20);
    assert.equal((await owner.c.call('POST', `${base}/invoices`, { contactId: cust.id, date: '2026-10-14',
      lines: [{ accountId: A['4100'], amount: '1', serviceDate: '2026-02-30' }] })).status, 400, 'not a real date');

    // Staff may pin the tax rate (they write invoices) but not change rates, the letterhead or the logo.
    const staff = await newUser('inv-staff@example.com');
    await owner.c.call('POST', `${base}/members`, { email: 'inv-staff@example.com', role: 'staff' });
    assert.equal((await staff.c.call('GET', `${base}/invoice-items`)).body.length, 10);
    assert.equal((await staff.c.call('PUT', `${base}/default-tax-rate`, { rate: '' })).status, 200);
    assert.equal((await staff.c.call('PATCH', `${base}/invoice-items/${std.id}`, { rate: '1' })).status, 403);
    assert.equal((await staff.c.call('PUT', `${base}/letterhead`, { address: 'x' })).status, 403);
    assert.equal((await staff.c.call('PUT', `${base}/logo`, { picture: null })).status, 403);
    assert.equal((await staff.c.call('GET', `${base}/logo`)).status, 200);
    const outsider = await newUser('logo-outsider@example.com');
    assert.equal((await outsider.c.call('GET', `${base}/logo`)).status, 404);
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
    // ...and edit a customer (Sales → Customers → edit): every field the form sends, the open invoice kept.
    const ed = await staff.c.call('PATCH', `${base}/contacts/${cust.body.id}`,
      { name: 'Staff Customer LLC', email: 'ap@staffcustomer.com', phone: '512-555-0100', address: '1 Main St, Austin, TX 78701', termsDays: 15 });
    assert.equal(ed.status, 200, JSON.stringify(ed.body));
    const listed = (await staff.c.call('GET', `${base}/customers`)).body.find((c) => c.id === cust.body.id);
    assert.deepEqual([listed.name, listed.email, listed.phone, listed.address, listed.termsDays, listed.openCents],
      ['Staff Customer LLC', 'ap@staffcustomer.com', '512-555-0100', '1 Main St, Austin, TX 78701', 15, 25000]);
    assert.equal((await staff.c.call('PATCH', `${base}/contacts/${cust.body.id}`, { email: 'not an email' })).status, 400);
    // Staff who take payments can photograph the check (and see it); the photo is served only to the company.
    const sPay = await staff.c.call('POST', `${base}/payments-received`, { contactId: cust.body.id, date: '2026-12-16', accountId: A['1000'], method: 'check', reference: '77', applications: [{ documentId: inv.body.id, amount: '10' }] });
    assert.equal(sPay.status, 201, JSON.stringify(sPay.body));
    const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]).toString('base64')}`;
    const ph = await staff.c.call('POST', `${base}/payments/${sPay.body.id}/photos`, { picture: jpeg });
    assert.equal(ph.status, 201, JSON.stringify(ph.body));
    const got = await staff.c.call('GET', `${base}/payments/${sPay.body.id}/photos/${ph.body.id}`);
    assert.equal(got.status, 200);
    assert.match(got.headers['content-type'], /image\/jpeg/);
    assert.equal((await staff.c.call('POST', `${base}/payments/${sPay.body.id}/void`, {})).status, 403);
    assert.equal((await owner.c.call('POST', `${base}/payments/${sPay.body.id}/void`, {})).status, 200);
    // Editing an invoice voids it, so it needs the Void permission (the owner's or accountant's).
    assert.equal((await staff.c.call('PUT', `${base}/documents/${inv.body.id}`, { contactId: cust.body.id, date: '2026-12-15', lines: [{ accountId: A['4100'], amount: '260' }] })).status, 403);
    const ownerEdit = await owner.c.call('PUT', `${base}/documents/${inv.body.id}`, { contactId: cust.body.id, date: '2026-12-15', lines: [{ accountId: A['4100'], amount: '260' }] });
    assert.equal(ownerEdit.status, 200, JSON.stringify(ownerEdit.body));
    assert.deepEqual([ownerEdit.body.number, ownerEdit.body.totalCents], [inv.body.number, 26000]);
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

    // Jobs: approvers, the owner and whoever writes invoices (staff) add them; a viewer can't.
    const job = await foreman.c.call('POST', `${base}/jobs`, { name: 'Smith Residence', code: 'J-101' });
    assert.equal(job.status, 201, JSON.stringify(job.body));
    const viewerRole = (await owner.c.call('POST', `${base}/roles`, { name: 'Look only', permissions: ['time_own'] })).body;
    const looker = await newUser('looker@example.com');
    assert.equal((await owner.c.call('POST', `${base}/members`, { email: 'looker@example.com', role: viewerRole.id })).status, 201);
    assert.equal((await looker.c.call('POST', `${base}/jobs`, { name: 'Nope' })).status, 403);
    assert.equal((await looker.c.call('POST', `${base}/jobs/import`, { text: '2701 Nope' })).status, 403);
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

    // Billing the job: projects pasted from folder names, then the unbilled hours pulled onto an invoice.
    const pasted = await owner.c.call('POST', `${base}/jobs/import`, { text: '"C:\\Projects\\2701 Lee Garage"\n"C:\\Projects\\2702 Ruiz Deck"' });
    assert.equal(pasted.status, 200, JSON.stringify(pasted.body));
    assert.equal(pasted.body.added, 2);
    const cust = (await owner.c.call('POST', `${base}/customers`, { name: 'Smith Family' })).body;
    const unbilled = await owner.c.call('GET', `${base}/unbilled?jobId=${job.body.id}`);
    assert.equal(unbilled.status, 200, JSON.stringify(unbilled.body));
    assert.deepEqual(unbilled.body.time.map((x) => x.quantity), ['9', '9', '9', '9', '9']);
    assert.equal((await worker.c.call('GET', `${base}/unbilled?jobId=${job.body.id}`)).status, 200, 'staff write invoices');
    assert.equal((await looker.c.call('GET', `${base}/unbilled?jobId=${job.body.id}`)).status, 403);
    const income = accts.find((a) => a.type === 'revenue').id;
    const billed = await owner.c.call('POST', `${base}/invoices`, { contactId: cust.id, date: '2026-11-09', jobId: job.body.id,
      lines: [{ accountId: income, description: 'framing', quantity: '9', unitPrice: '95', timeEntryId: unbilled.body.time[0].id }] });
    assert.equal(billed.status, 201, JSON.stringify(billed.body));
    assert.equal(billed.body.totalCents, 85500); // 9 h × $95
    assert.equal((await owner.c.call('GET', `${base}/unbilled?jobId=${job.body.id}`)).body.time.length, 4);
    const twice = await owner.c.call('POST', `${base}/invoices`, { contactId: cust.id, date: '2026-11-09',
      lines: [{ accountId: income, quantity: '9', unitPrice: '95', timeEntryId: unbilled.body.time[0].id }] });
    assert.equal(twice.status, 400);
    assert.ok(twice.body.details.some((d) => /already billed/.test(d)));

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

    // Payroll tax deposit through the API (runtime role, row-level security on).
    const liab = (await owner.c.call('GET', `${base}/reports/payroll-liabilities?from=2026-11-01&to=2026-11-30`)).body;
    const irs = liab.agencies.find((a) => a.form.startsWith('Form 941'));
    const depBody = { agency: irs.agency, form: irs.form, periodStart: '2026-11-01', periodEnd: '2026-11-30', depositDate: '2026-12-15', paidFromAccountId: A['1000'] };
    assert.equal((await worker.c.call('POST', `${base}/payroll-deposits`, depBody)).status, 403);
    const dep = await owner.c.call('POST', `${base}/payroll-deposits`, depBody, { 'Idempotency-Key': 'nov-941' });
    assert.equal(dep.status, 201, JSON.stringify(dep.body));
    assert.equal(dep.body.amountCents, irs.dueCents);
    assert.equal((await owner.c.call('POST', `${base}/payroll-deposits/${dep.body.id}/void`, {})).status, 200);

    // Reports as CSV downloads, side-by-side comparisons and the payroll register.
    const bsCsv = await owner.c.call('GET', `${base}/reports/balance-sheet?asOf=2026-11-30&compare=prior_period&format=csv`);
    assert.equal(bsCsv.status, 200, bsCsv.text);
    assert.match(bsCsv.headers['content-type'], /^text\/csv/);
    assert.equal(bsCsv.headers['content-disposition'], 'attachment; filename="API Co - Balance Sheet 2026-11-30.csv"');
    assert.match(bsCsv.text, /^\uFEFF?API Co\r\nBalance Sheet\r\nAs of 2026-11-30\r\n/);
    assert.match(bsCsv.text, /Account number,Account,2026-11-30,2026-10-31,Change,Change %/);
    assert.match(bsCsv.text, /,Total liabilities and equity,/);
    const bsCmp = (await owner.c.call('GET', `${base}/reports/balance-sheet?asOf=2026-11-30&compare=prior_period`)).body;
    assert.deepEqual([bsCmp.comparison.asOf, bsCmp.comparison.check, bsCmp.check], ['2026-10-31', 0, 0]);
    const isCmp = (await owner.c.call('GET', `${base}/reports/income-statement?from=2026-11-01&to=2026-11-30&compare=prior_year`)).body;
    assert.deepEqual([isCmp.comparison.from, isCmp.comparison.to], ['2025-11-01', '2025-11-30']);
    assert.equal((await owner.c.call('GET', `${base}/reports/income-statement?from=2026-11-01&to=2026-11-30&compare=yesterday`)).status, 400);
    assert.equal((await worker.c.call('GET', `${base}/reports/balance-sheet?format=csv`)).status, 403);
    const reg = await owner.c.call('GET', `${base}/reports/payroll-register?from=2026-11-01&to=2026-12-31`);
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    assert.equal(reg.body.ties, true);
    const regChecks = (await owner.c.call('GET', `${base}/paychecks`)).body.filter((p) => p.payDate >= '2026-11-01' && p.payDate <= '2026-12-31');
    assert.equal(reg.body.rows.length, regChecks.length);
    assert.equal(reg.body.totals.grossCents, regChecks.reduce((t, p) => t + p.grossCents, 0));
    assert.equal((await worker.c.call('GET', `${base}/reports/payroll-register?from=2026-11-01&to=2026-12-31`)).status, 403);
    const regCsv = await owner.c.call('GET', `${base}/reports/payroll-register?from=2026-11-01&to=2026-12-31&format=csv`);
    assert.match(regCsv.text, /Pay date,Employee,Period,Hours,Gross pay,/);
    assert.match(regCsv.text, /\r\nTotal,,,/);

    // Hours by job.
    const sum = (await owner.c.call('GET', `${base}/reports/time-summary?from=2026-11-01&to=2026-11-15`)).body;
    assert.equal(sum.jobs.find((j) => j.jobName === 'Smith Residence').minutes, 45 * 60 + 8 * 60);
    assert.equal((await other.c.call('GET', `${base}/reports/time-summary?from=2026-11-01&to=2026-11-15`)).body.totalMinutes, 8 * 60, 'staff see only their own');
  });

  await t.test('monitoring: request ids, one log line per request (ids only), metrics behind a token', async () => {
    const r = await owner.c.call('GET', `/api/companies/${co.id}/entries?text=secret%20memo`);
    assert.match(r.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    const line = logs.find((l) => l.reqId === r.headers['x-request-id']);
    assert.deepEqual([line.route, line.status, line.method, line.companyId], ['/api/companies/:companyId/entries', 200, 'GET', co.id]);
    assert.ok(line.userId);
    assert.ok(!JSON.stringify(logs).includes('secret memo'), 'query text is never logged');
    assert.ok(!JSON.stringify(logs).includes('@example.com'), 'emails are never logged');
    const failed = logs.find((l) => l.route === '/api/auth/login' && l.status === 401);
    assert.ok(failed, 'a refused sign-in is logged by route, not by who tried');

    const metrics = (path, headers) => fetch(base + path, { headers });
    assert.equal((await metrics('/metrics')).status, 404); // off until METRICS_TOKEN is set
    process.env.METRICS_TOKEN = 'test-metrics-token-1234';
    try {
      assert.equal((await metrics('/metrics', { authorization: 'Bearer wrong' })).status, 401);
      const m = await metrics('/metrics', { authorization: 'Bearer test-metrics-token-1234' });
      assert.equal(m.status, 200);
      const text = await m.text();
      assert.match(text, /http_requests_total\{method="GET",route="\/api\/companies\/:companyId\/entries",status="200"\} \d+/);
      assert.match(text, /http_request_duration_seconds_bucket\{route="\/api\/companies\/:companyId\/entries",le="0.8"\} \d+/);
      assert.match(text, /db_pool_waiting \d+/);
    } finally {
      delete process.env.METRICS_TOKEN;
    }
  });

  await t.test('beta feedback: anyone sends, only developers read; testers cannot see each other\'s reports', async () => {
    // A 1×1 PNG, as the dialog sends a picture (a data URL).
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
    const context = { location: { tab: 'Sales', panel: 'docs', role: 'Owner' }, actions: [{ at: '10:00:01', what: 'click button "Save"' }],
      errors: [{ at: '10:00:02', kind: 'server', message: 'POST /companies/:id/invoices → 400: Pick a customer', reqId: 'abc12345' }], junk: 'x'.repeat(5000) };
    const sent = await owner.c.call('POST', '/api/feedback', { note: 'The invoice total shows $0.00', companyId: co.id, picture: png, context });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.ok(sent.body.number >= 1);
    assert.equal((await owner.c.call('POST', '/api/feedback', { note: '   ' })).status, 400);
    assert.equal((await owner.c.call('POST', '/api/feedback', { note: 'x', picture: 'data:image/png;base64,AAAA' })).status, 400, 'not really a PNG');
    assert.equal((await owner.c.call('POST', '/api/feedback', { note: 'x', picture: 'data:image/gif;base64,R0lGOD' })).status, 400);

    // Not a developer: refused, reads included.
    assert.equal((await owner.c.call('GET', '/api/developer/reports')).status, 403);
    assert.equal((await owner.c.call('GET', '/api/developer/backup')).status, 403);
    const me = await owner.c.call('GET', '/api/auth/me');
    assert.equal(me.body.user.platformRole, null);
    assert.match(me.body.version, /^\d+\.\d+\.\d+/);

    // A second tester sends one; row-level security keeps each tester to their own rows even in raw SQL.
    const other = await newUser('tester2@example.com');
    const s2 = await other.c.call('POST', '/api/feedback', { note: 'Second tester', companyId: co.id }); // not a member: company not recorded
    assert.equal(s2.status, 201);
    const otherId = (await other.c.call('GET', '/api/auth/me')).body.user.id;
    const seen = await withScope(db.appPool, { userId: otherId }, (c) => c.query('SELECT note, company_id FROM feedback_reports'));
    assert.deepEqual(seen.rows.map((r) => [r.note, r.company_id]), [['Second tester', null]]);

    const dev = await newUser('dev@example.com');
    assert.equal((await dev.c.call('GET', '/api/auth/me')).body.user.platformRole, 'developer');
    const sum = await dev.c.call('GET', '/api/developer/summary');
    assert.equal(sum.status, 200);
    assert.ok(sum.body.counts.users >= 3 && sum.body.counts.companies >= 1);
    const list = await dev.c.call('GET', '/api/developer/reports?status=new');
    assert.equal(list.body.counts.new, 2);
    const first = list.body.reports.find((r) => r.number === sent.body.number);
    assert.deepEqual([first.page, first.hasPicture, first.pictureSource, first.status], ['Sales', true, 'screen', 'new']);
    const full = (await dev.c.call('GET', `/api/developer/reports/${first.id}`)).body;
    assert.equal(full.context.junk.length, 1001, 'long strings are cut');
    assert.match(full.claudeDraft, /The invoice total shows \$0\.00/);
    assert.match(full.claudeDraft, /request abc12345/);
    assert.ok(!full.claudeDraft.includes('owner@example.com'), 'the write-up for Claude leaves out who sent it');
    const pic = await dev.c.call('GET', `/api/developer/reports/${first.id}/picture`);
    assert.equal(pic.headers['content-type'], 'image/png');

    assert.equal((await dev.c.call('PATCH', `/api/developer/reports/${first.id}`, { status: 'bogus' })).status, 400);
    assert.equal((await dev.c.call('PATCH', `/api/developer/reports/${first.id}`, { status: 'sent_to_claude', claudeText: 'Fix the total.', developerNote: 'seen' })).status, 200);
    const after = (await dev.c.call('GET', `/api/developer/reports/${first.id}`)).body;
    assert.deepEqual([after.status, after.claudeDraft, after.developerNote, after.updatedBy], ['sent_to_claude', 'Fix the total.', 'seen', 'dev@example.com']);
    // The runtime login can't rewrite what the tester sent.
    await assert.rejects(db.appPool.query('UPDATE feedback_reports SET note = $1', ['changed']), /permission denied/);
    assert.ok(!JSON.stringify(logs).includes('invoice total'), 'the note is never logged');

    // Backup: a pg_dump custom-format file ("PGDMP" is its first 5 bytes), made with the owner login.
    process.env.MIGRATION_DATABASE_URL = db.url;
    try {
      const r = await fetch(`${base}/api/developer/backup`, { headers: { cookie: dev.c.cookie } });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition'), /zaccountant-backup-\d{4}-\d{2}-\d{2}-pg\d+\.dump/);
      const bytes = Buffer.from(await r.arrayBuffer());
      assert.equal(bytes.subarray(0, 5).toString(), 'PGDMP');
      assert.ok(logs.some((l) => l.msg === 'backup downloaded'));
    } finally {
      delete process.env.MIGRATION_DATABASE_URL;
    }
  });

  await t.test('plans: admins switch features per company and the server refuses what the plan leaves out', async () => {
    const coInfo = (await owner.c.call('GET', `/api/companies/${co.id}`)).body;
    assert.deepEqual([coInfo.plan, coInfo.features], ['beta', ['payroll', 'tax', 'timesheets']], 'every company starts on Beta tester with everything');
    assert.equal((await owner.c.call('GET', '/api/admin/companies')).status, 403);
    assert.equal((await owner.c.call('PUT', `/api/admin/companies/${co.id}/plan`, { plan: 'individual', reason: 'x' })).status, 403);

    const adm = await newUser('admin@example.com');
    assert.equal((await adm.c.call('GET', '/api/developer/reports')).status, 403, 'an admin is not a developer');
    const list = await adm.c.call('GET', '/api/admin/companies');
    assert.equal(list.status, 200);
    const row = list.body.companies.find((c) => c.id === co.id);
    assert.deepEqual([row.name, row.owners, row.plan, row.planIsDefault], ['API Co', 'owner@example.com', 'beta', true]);
    assert.ok(!JSON.stringify(list.body.companies).includes('Cents"'), 'no amounts from anyone\'s books');

    const put = (body) => adm.c.call('PUT', `/api/admin/companies/${co.id}/plan`, body);
    assert.equal((await put({ plan: 'gold', reason: 'x' })).status, 400);
    assert.equal((await put({ plan: 'individual', addOns: ['bank'], reason: 'x' })).status, 400);
    assert.equal((await put({ plan: 'individual' })).status, 400, 'a reason is required');
    const set = await put({ plan: 'individual', addOns: ['timesheets'], reason: 'Paid by check for November' });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual(set.body.features, ['timesheets']);

    // Payroll is now refused by the server, books and timesheets still work.
    const pr = await owner.c.call('GET', `/api/companies/${co.id}/employees`);
    assert.equal(pr.status, 402);
    assert.match(pr.body.error, /Payroll isn't in this company's plan/);
    assert.equal((await owner.c.call('GET', `/api/companies/${co.id}/reports/payroll-register?from=2026-01-01&to=2026-12-31`)).status, 402);
    assert.equal((await owner.c.call('GET', `/api/companies/${co.id}/time-entries`)).status, 200);
    assert.equal((await owner.c.call('GET', `/api/companies/${co.id}/reports/balance-sheet?asOf=2026-12-31`)).status, 200);

    // Members can read their plan but can't write one, even in raw SQL as the app's login.
    const ownerId = (await owner.c.call('GET', '/api/auth/me')).body.user.id;
    await assert.rejects(withScope(db.appPool, { userId: ownerId, companyId: co.id },
      (c) => c.query("UPDATE company_plans SET plan = 'beta' WHERE company_id = $1 RETURNING 1", [co.id]).then((r) => { if (!r.rowCount) throw new Error('row-level security: no rows'); })),
      /row-level security/);
    await assert.rejects(withScope(db.appPool, { userId: ownerId }, (c) => c.query('SELECT * FROM zacc_admin_companies()')), /Only zAccountant admins/);

    // Logged in the change log and in the company's own (verifiable) audit trail.
    const changes = (await adm.c.call('GET', '/api/admin/plan-changes')).body;
    assert.deepEqual([changes[0].companyName, changes[0].from, changes[0].to, changes[0].by], ['API Co', 'Beta tester (default)', 'Family and individuals + timesheets', 'admin@example.com']);
    assert.equal((await owner.c.call('GET', `/api/companies/${co.id}/audit/verify`)).body.ok, true);

    assert.equal((await put({ plan: 'beta', reason: 'Back to testing' })).status, 200);
    assert.equal((await owner.c.call('GET', `/api/companies/${co.id}/employees`)).status, 200);
  });

  await t.test('front page, public prices, and Back up your books (round trip through the importer)', async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /no frills|no-frills/);
    assert.match(await (await fetch(`${base}/app`)).text(), /id="app"/, 'the app moved to /app');
    assert.match(await (await fetch(`${base}/prices`)).text(), /id="plan-list"/, 'prices have their own page');
    const pub = await (await fetch(`${base}/api/public/plans`)).json();
    assert.deepEqual(pub.plans.map((p) => p.key), ['beta', 'individual', 'company']);
    assert.deepEqual(pub.addOns.map((p) => p.key), ['tax', 'timesheets']);
    assert.deepEqual([pub.plans[2].monthlyCents, pub.plans[2].annualCents], [null, null], 'no price invented');
    assert.ok([...pub.plans, ...pub.addOns].every((p) => p.points.length > 0), 'every card has its short points');

    const acc = await owner.c.call('GET', `/api/companies/${co.id}/backup/accounts`);
    assert.equal(acc.status, 200);
    assert.match(acc.headers['content-disposition'], /attachment; filename="API Co - Chart of accounts \d{4}-\d{2}-\d{2}\.csv"/);
    const jr = await owner.c.call('GET', `/api/companies/${co.id}/backup/journal`);
    assert.equal(jr.status, 200);
    assert.match(jr.text, /^\uFEFF?Entry,Date,Memo,Account,Debit,Credit,Source\r\n1,/);
    // Rebuild the books in a new company from the two files: the trial balance must come out the same.
    const copy = (await owner.c.call('POST', '/api/companies', { name: 'Restored Co', homeState: 'CO', fiscalYearStartMonth: 1 })).body;
    const ia = await owner.c.call('POST', `/api/companies/${copy.id}/imports`, { kind: 'accounts', fileName: 'a.csv', content: acc.text });
    assert.equal(ia.status, 201, JSON.stringify(ia.body));
    const ij = await owner.c.call('POST', `/api/companies/${copy.id}/imports`, { kind: 'journal', fileName: 'j.csv', content: jr.text });
    assert.equal(ij.status, 201, JSON.stringify(ij.body));
    const tb = async (id) => (await owner.c.call('GET', `/api/companies/${id}/reports/trial-balance?asOf=2099-12-31`)).body
      .rows.map((r) => `${r.code} ${r.name} ${r.debitCents} ${r.creditCents}`);
    assert.ok((await tb(co.id)).length > 2);
    assert.deepEqual(await tb(copy.id), await tb(co.id));
  });

  await t.test('new-company setup wizard: business type, start date, the checklist, and finishing', async () => {
    const r = await owner.c.call('POST', '/api/companies', { name: 'Wizard Co', homeState: 'TX', fiscalYearStartMonth: 1, entityType: 's_corp', booksStartDate: '2026-01-01' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.id;
    let s = (await owner.c.call('GET', `/api/companies/${id}/setup`)).body;
    assert.equal(s.setupDone, false, 'a new company starts with the setup list showing');
    assert.deepEqual(s.steps, { basics: true, books: false, bank: false, invoicing: false, people: false });
    assert.equal((await owner.c.call('POST', '/api/companies', { name: 'Bad', homeState: 'TX', fiscalYearStartMonth: 1, entityType: 'llp' })).status, 400);
    // Starting fresh: a bank balance against Owner's Capital, dated the day before the books start.
    const accts = (await owner.c.call('GET', `/api/companies/${id}/accounts`)).body;
    const bankAcct = accts.find((a) => a.code === '1000'); const capital = accts.find((a) => a.code === '3000');
    assert.equal((await owner.c.call('POST', `/api/companies/${id}/entries/simple`, { date: '2025-12-31', memo: 'Opening balance, Checking', amount: '12500.00', fromAccountId: capital.id, toAccountId: bankAcct.id })).status, 201);
    s = (await owner.c.call('GET', `/api/companies/${id}/setup`)).body;
    assert.equal(s.steps.books, true); assert.equal(s.steps.bank, true);
    const u = await owner.c.call('PUT', `/api/companies/${id}/setup`, { entityType: 'sole_proprietor', setupDone: true });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(u.body.entity_type, 'sole_proprietor'); assert.equal(u.body.books_start_date, '2026-01-01', 'unchanged when not sent');
    assert.equal((await owner.c.call('GET', `/api/companies/${id}/setup`)).body.setupDone, true);
    assert.equal((await owner.c.call('GET', `/api/companies/${co.id}/setup`)).body.setupDone, false, 'made in this test run, so not set by the migration');
  });

  await t.test('Tax-ready: tax summary by return line, account categories, 1099-NEC and W-2/W-3 totals', async () => {
    const id = (await owner.c.call('POST', '/api/companies', { name: 'Tax Co', homeState: 'TX', fiscalYearStartMonth: 1, entityType: 's_corp' })).body.id;
    const b = `/api/companies/${id}`;
    const acct = Object.fromEntries((await owner.c.call('GET', `${b}/accounts`)).body.map((a) => [a.code, a.id]));
    // A 1099 vendor paid $2,500 by check and $100 by card; another vendor (not marked) paid $3,000.
    const surveyor = (await owner.c.call('POST', `${b}/vendors`, { name: 'Ace Surveying', is1099: true })).body;
    const office = (await owner.c.call('POST', `${b}/vendors`, { name: 'Big Office LLC' })).body;
    let billNo = 0;
    const pay = async (vendor, amount, account, method) => {
      const bill = await owner.c.call('POST', `${b}/bills`, { contactId: vendor.id, number: `B-${++billNo}`, date: '2026-02-01', lines: [{ accountId: acct['6250'], amount }] });
      assert.equal(bill.status, 201, JSON.stringify(bill.body));
      const p = await owner.c.call('POST', `${b}/payments-made`, { contactId: vendor.id, date: '2026-02-15', accountId: acct[account], method, applications: [{ documentId: bill.body.id, amount }] });
      assert.equal(p.status, 201, JSON.stringify(p.body));
    };
    await pay(surveyor, '2500', '1000', 'check');
    await pay(surveyor, '100', '2100', 'card');
    await pay(office, '3000', '1000', 'ach');
    const n = (await owner.c.call('GET', `${b}/reports/tax-1099?year=2026`)).body;
    assert.equal(n.thresholdCents, 200000, '$2,000 for payments made in 2026');
    assert.deepEqual(n.vendors.map((v) => [v.name, v.paidCents, v.byCardCents, v.needsForm]), [['Ace Surveying', 250000, 10000, true]]);
    assert.deepEqual(n.toCheck.map((v) => v.name), ['Big Office LLC']);
    assert.equal(n.formsNeeded, 1);
    const csv = await owner.c.call('GET', `${b}/reports/tax-1099?year=2026&format=csv`);
    assert.match(csv.text, /Ace Surveying,2500\.00,100\.00,yes,no/);

    // One monthly paycheck of $5,000 (Texas: no state income tax).
    const emp = (await owner.c.call('POST', `${b}/employees`, { firstName: 'Ann', lastName: 'Lee', workState: 'TX', payFrequency: 'monthly', payType: 'salary', payRate: '5000', w4: {} })).body;
    const pc = await owner.c.call('POST', `${b}/employees/${emp.id}/paychecks`, { payDate: '2026-03-31', paidFromAccountId: acct['1000'] });
    assert.equal(pc.status, 201, JSON.stringify(pc.body));
    const w2 = (await owner.c.call('GET', `${b}/reports/tax-w2?year=2026`)).body;
    const ann = w2.employees[0];
    assert.equal(ann.box1, 500000); assert.equal(ann.box3, 500000); assert.equal(ann.box5, 500000);
    assert.equal(ann.box4, 31000, '6.2% of 5,000.00'); assert.equal(ann.box6, 7250, '1.45% of 5,000.00');
    assert.deepEqual(ann.state, {}, 'Texas has no state income tax');
    assert.equal(w2.w3.forms, 1); assert.equal(w2.w3.box1, 500000);

    // Form 1120-S: wages on line 8, professional fees under other deductions (5,600.00 = 2,500 + 100 + 3,000).
    let t2 = (await owner.c.call('GET', `${b}/reports/tax-summary?from=2026-01-01&to=2026-12-31`)).body;
    assert.equal(t2.formName, 'Form 1120-S');
    const line = (n) => t2.lines.find((g) => g.line === n)?.cents;
    assert.equal(line('8'), 500000); assert.equal(line('20'), 560000);
    assert.ok(t2.suggestedCount > 0);
    // The owner says the wages were officer pay: line 7 instead.
    assert.equal((await owner.c.call('PUT', `${b}/tax-categories`, { items: [{ accountId: acct['6400'], category: 'officer_compensation' }] })).status, 200);
    t2 = (await owner.c.call('GET', `${b}/reports/tax-summary?from=2026-01-01&to=2026-12-31`)).body;
    assert.equal(line('7'), 500000); assert.equal(line('8'), undefined);
    const cats = (await owner.c.call('GET', `${b}/tax-categories`)).body;
    const wages = cats.accounts.find((a) => a.code === '6400');
    assert.equal(wages.suggested, false); assert.equal(wages.place, 'Line 7: Compensation of officers');
    assert.equal((await owner.c.call('PUT', `${b}/tax-categories`, { items: [{ accountId: acct['6400'], category: 'yacht' }] })).status, 400);
    assert.equal((await owner.c.call('PUT', `${b}/tax-categories`, { items: [{ accountId: acct['1000'], category: 'wages' }] })).status, 400, 'balance-sheet account');
    // Back to the suggestion.
    assert.equal((await owner.c.call('PUT', `${b}/tax-categories`, { items: [{ accountId: acct['6400'], category: null }] })).status, 200);
    assert.equal((await owner.c.call('GET', `${b}/tax-categories`)).body.accounts.find((a) => a.code === '6400').suggested, true);
    // Personal books have no business return.
    await owner.c.call('PUT', `${b}/setup`, { entityType: 'individual' });
    assert.equal((await owner.c.call('GET', `${b}/reports/tax-summary?from=2026-01-01&to=2026-12-31`)).body.form, null);
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
    // Health checks answer any host name (Railway's checker uses an internal one) and reveal nothing.
    const health = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/readyz', headers: { host: 'healthcheck.railway.app' } },
        (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(health, 200);
    assert.equal((await owner.c.call('POST', lock, { through: '2026-01-01' }, { origin: base })).status, 200);
  });
});
