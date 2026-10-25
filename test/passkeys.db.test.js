// Passkeys through HTTP, with the server connected as the restricted runtime role (as in production).
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { totpCode } from '../src/security/totp.js';
import { fakeAuthenticator } from './fakeAuthenticator.js';

process.env.AUTH_RATE_LIMIT = '1000';

test('passkeys: add one, sign in with it, remove it', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase({ withAppRole: true });
  const server = createApp(db.appPool, { log: (l) => { if (process.env.SHOW_LOG) console.log(l); } }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { server.close(); await db.drop(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    const call = async (method, path, body) => {
      const r = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { call };
  };

  // Homer signs up and turns on the authenticator code (passkeys come after that).
  const desk = client();
  await desk.call('POST', '/api/auth/signup', { email: 'homer@example.com', name: 'Homer', password: 'a long enough passphrase' });
  const setup = (await desk.call('POST', '/api/auth/mfa/setup', {})).body;
  assert.equal((await desk.call('POST', '/api/auth/mfa/enable', { code: totpCode(setup.secret, Date.now()) })).status, 200);

  const phone = fakeAuthenticator({ rpId: '127.0.0.1', origin: base });
  // Adding a passkey asks for the authenticator code again (the one used to turn it on can't be reused).
  assert.equal((await desk.call('POST', '/api/auth/passkeys/options', {})).status, 400);
  let opt = await desk.call('POST', '/api/auth/passkeys/options', { mfaCode: totpCode(setup.secret, Date.now()) });
  if (opt.status !== 200) opt = await desk.call('POST', '/api/auth/passkeys/options', { mfaCode: totpCode(setup.secret, Date.now() + 30_000) });
  assert.equal(opt.status, 200, JSON.stringify(opt.body));
  assert.equal(opt.body.rp.id, '127.0.0.1');
  assert.deepEqual(opt.body.algorithms, [-7, -257, -8]);
  const made = phone.create(opt.body);
  assert.equal((await desk.call('POST', '/api/auth/passkeys', { credential: made, name: '' })).status, 400); // needs a name
  const saved = await desk.call('POST', '/api/auth/passkeys', { credential: made, name: "Homer's iPhone" });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  // The challenge works once.
  assert.equal((await desk.call('POST', '/api/auth/passkeys', { credential: made, name: 'again' })).status, 400);
  const list = (await desk.call('GET', '/api/auth/passkeys')).body;
  assert.deepEqual(list.map((k) => k.name), ["Homer's iPhone"]);

  // On the iPhone: no password, no code; Face ID signs the challenge and the session is fully signed in.
  const road = client();
  const lo = (await road.call('POST', '/api/auth/passkey/options', {})).body;
  const signed = phone.get(lo);
  const login = await road.call('POST', '/api/auth/passkey/login', { credential: signed });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.user.email, 'homer@example.com');
  assert.equal(login.body.next, null);
  assert.equal((await road.call('GET', '/api/companies')).status, 200);
  // Replaying the same answer fails (challenge used up).
  assert.equal((await client().call('POST', '/api/auth/passkey/login', { credential: signed })).status, 400);
  // A different site's answer is refused.
  const lo2 = (await road.call('POST', '/api/auth/passkey/options', {})).body;
  const wrong = await client().call('POST', '/api/auth/passkey/login', { credential: phone.get(lo2, { origin: 'https://evil.example' }) });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /different site/);
  // An unknown passkey.
  const stranger = fakeAuthenticator({ rpId: '127.0.0.1', origin: base });
  const lo3 = (await road.call('POST', '/api/auth/passkey/options', {})).body;
  assert.equal((await client().call('POST', '/api/auth/passkey/login', { credential: stranger.get(lo3) })).status, 401);
  // Half-signed-in sessions (password only) can't list or add passkeys.
  const half = client();
  await half.call('POST', '/api/auth/login', { email: 'homer@example.com', password: 'a long enough passphrase' });
  assert.equal((await half.call('GET', '/api/auth/passkeys')).status, 401);

  // Removing it: the next sign-in with it is refused.
  assert.equal((await desk.call('DELETE', `/api/auth/passkeys/${list[0].id}`, {})).status, 200);
  const lo4 = (await road.call('POST', '/api/auth/passkey/options', {})).body;
  assert.equal((await client().call('POST', '/api/auth/passkey/login', { credential: phone.get(lo4) })).status, 401);
  assert.equal((await desk.call('DELETE', `/api/auth/passkeys/${list[0].id}`, {})).status, 404);
});
