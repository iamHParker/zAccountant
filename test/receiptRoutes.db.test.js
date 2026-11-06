// Reading a receipt through HTTP: the desk route (permission bills) and the Road page's (road key), against a
// stand-in for Anthropic's API (ANTHROPIC_BASE_URL points the SDK at a small local server that answers like Claude).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { totpCode } from '../src/security/totp.js';

process.env.AUTH_RATE_LIMIT = '1000';
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]).toString('base64')}`;

test('receipt reading: off without a key, then desk and phone both read, nothing saved', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  // The stand-in Anthropic API: remembers what it was sent, answers one receipt.
  const seen = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ path: req.url, body: JSON.parse(body), beta: req.headers['anthropic-beta'] });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn',
        usage: { input_tokens: 1600, output_tokens: 80 },
        content: [{ type: 'text', text: JSON.stringify({ isReceipt: true, vendor: 'Hampton Inn Selma', total: '318.44', currency: 'USD',
          date: '2026-10-05', kind: 'lodging', description: 'Hotel, 2 nights' }) }] }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));

  const db = await freshDatabase({ withAppRole: true });
  const server = createApp(db.appPool, { log: () => {} }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { server.close(); fake.close(); await db.drop(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = (bearer = null) => {
    let cookie = '';
    return { call: async (method, path, body) => {
      const r = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      return { status: r.status, body: await r.json().catch(() => null) };
    } };
  };
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

  const desk = client();
  await desk.call('POST', '/api/auth/signup', { email: 'homer@example.com', name: 'Homer', password: 'a long enough passphrase' });
  const setup = (await desk.call('POST', '/api/auth/mfa/setup', {})).body;
  ok(await desk.call('POST', '/api/auth/mfa/enable', { code: totpCode(setup.secret, Date.now()) }));
  const co = ok(await desk.call('POST', '/api/companies', { name: 'Parker Engineering', homeState: 'TX', fiscalYearStartMonth: 1 }), 201);
  const b = `/api/companies/${co.id}`;
  const token = ok(await desk.call('POST', `${b}/road-keys`, { name: 'iPhone' }), 201).url.split('#key=')[1];
  const phone = client(token);

  // No API key on the server: the buttons stay hidden and the routes say so.
  delete process.env.ANTHROPIC_API_KEY;
  assert.deepEqual(ok(await client().call('GET', '/api/public/features')), { receiptReading: false });
  assert.equal(ok(await phone.call('GET', '/api/road')).receiptReading, false);
  assert.equal((await desk.call('POST', `${b}/receipts/read`, { picture: JPEG })).status, 503);
  assert.equal(seen.length, 0);

  // With a key: both routes read, through the SDK, to the stand-in.
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  assert.deepEqual(ok(await client().call('GET', '/api/public/features')), { receiptReading: true });
  assert.equal(ok(await phone.call('GET', '/api/road')).receiptReading, true);
  const expected = { isReceipt: true, vendor: 'Hampton Inn Selma', amount: '318.44', currency: 'USD', date: '2026-10-05', kind: 'lodging', description: 'Hotel, 2 nights' };
  assert.deepEqual(ok(await desk.call('POST', `${b}/receipts/read`, { picture: JPEG })), expected);
  assert.deepEqual(ok(await phone.call('POST', '/api/road/receipt', { picture: JPEG })), expected);
  assert.equal(seen.length, 2);
  assert.match(seen[0].path, /^\/v1\/messages/);
  assert.equal(seen[0].body.model, 'claude-opus-5-5');
  assert.equal(seen[0].body.fallbacks, 'default');
  assert.match(seen[0].beta, /server-side-fallback-2026-07-01/);
  assert.equal(seen[0].body.messages[0].content[0].source.data, JPEG.split(',')[1]);

  // A bad picture is the sender's to fix; a bad key or another company is refused before anything is sent.
  assert.equal((await desk.call('POST', `${b}/receipts/read`, { picture: 'data:text/plain;base64,aGk=' })).status, 400);
  assert.equal((await client('zr_' + 'x'.repeat(43)).call('POST', '/api/road/receipt', { picture: JPEG })).status, 401);
  assert.equal((await client().call('POST', `${b}/receipts/read`, { picture: JPEG })).status, 401);
  assert.equal(seen.length, 2);

  // Nothing was saved: no trip costs, no road items.
  const { rows: [n] } = await db.pool.query('SELECT (SELECT count(*) FROM trip_costs)::int AS costs, (SELECT count(*) FROM road_items)::int AS items');
  assert.deepEqual(n, { costs: 0, items: 0 });
});
