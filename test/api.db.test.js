import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import http from 'node:http';

test('HTTP API', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  const server = createApp(db.pool).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { server.close(); await db.drop(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, headers = {}) => fetch(base + path, {
    method, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { 'content-type': 'application/json', ...headers },
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  const co = (await call('POST', '/api/companies', { name: 'API Co', homeState: 'CO' })).body;
  const accts = (await call('GET', `/api/companies/${co.id}/accounts`)).body;
  const A = Object.fromEntries(accts.map((a) => [a.code, a.id]));

  await t.test('simple entry in dollars, balance sheet ties', async () => {
    const r = await call('POST', `/api/companies/${co.id}/entries/simple`, { date: '2026-01-05', memo: 'Sale', fromAccountId: A['4000'], toAccountId: A['1000'], amount: '1,250.00' });
    assert.equal(r.status, 201);
    const bs = await call('GET', `/api/companies/${co.id}/reports/balance-sheet?asOf=2026-12-31`);
    assert.equal(bs.body.totalAssetsCents, 125_000);
    assert.equal(bs.body.balanced, true);
  });

  await t.test('user mistakes are 400 with a readable message, never 500', async () => {
    const cases = [
      ['GET', `/api/companies/${co.id}/entries?limit=-5&from=abc`],
      ['GET', `/api/companies/${co.id}/reports/income-statement?from=2026-02-30&to=2026-03-01`],
      ['GET', `/api/companies/${co.id}/accounts/${A['1000']}/register?from=2026-13-01`],
      ['POST', `/api/companies/${co.id}/lock`, { through: '2026-13-45' }],
      ['POST', `/api/companies/${co.id}/entries`, { date: '2026-01-01', lines: [{ accountId: A['1000'], debitCents: 9007199254740991 }, { accountId: A['4000'], creditCents: 9007199254740991 }] }],
      ['POST', `/api/companies/${co.id}/entries`, '{not json'],
      ['POST', `/api/companies/${co.id}/employees`, { firstName: 'X', lastName: 'Y', workState: 'CO', payFrequency: 'weekly', payType: 'salary', payRate: '99999999999999999' }],
      ['POST', '/api/companies', { name: 'a\u0000b', homeState: 'TX' }],
      ['POST', `/api/companies/${co.id}/entries`, 'x'.repeat(2_000_000)],
    ];
    for (const [m, p, b] of cases) {
      const r = await call(m, p, b);
      assert.ok(r.status >= 400 && r.status < 500, `${m} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(r.body?.error, `${p} has error text`);
      assert.doesNotMatch(r.body.error, /violates|constraint|relation|syntax/i, 'no raw database text');
    }
  });

  await t.test('unknown company is 404', async () => {
    const r = await call('GET', '/api/companies/00000000-0000-0000-0000-000000000000/accounts');
    assert.equal(r.status, 404);
  });

  await t.test('cross-site requests and foreign Host headers are refused (security M1)', async () => {
    const lock = `/api/companies/${co.id}/lock`;
    assert.equal((await call('POST', lock, '{"through":null}', { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await call('POST', lock, { through: '2026-01-01' }, { origin: 'http://evil.example' })).status, 403);
    // fetch() cannot spoof Host, so use the raw http module (as a DNS-rebinding page effectively would)
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/companies', headers: { host: 'attacker.example' } },
        (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 421);
    assert.equal((await call('POST', lock, { through: '2026-01-01' }, { origin: base })).status, 200);
  });
});
