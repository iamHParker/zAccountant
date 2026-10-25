import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCbor, verifyRegistration, verifyAssertion, WebAuthnError } from '../src/security/webauthn.js';
import { fakeAuthenticator, encodeCbor } from './fakeAuthenticator.js';

const site = { rpId: 'zaccountant.example', origin: 'https://zaccountant.example' };

test('CBOR reader: numbers, strings, maps, and it stops where the item ends', () => {
  const buf = Buffer.concat([encodeCbor(new Map([[1, 2], [-3, Buffer.from([9, 8])], ['fmt', 'none'], [3, [500, -257]]])), Buffer.from([0xff])]);
  const { value, end } = decodeCbor(buf);
  assert.equal(value.get(1), 2);
  assert.deepEqual([...value.get(-3)], [9, 8]);
  assert.equal(value.get('fmt'), 'none');
  assert.deepEqual(value.get(3), [500, -257]);
  assert.equal(end, buf.length - 1); // the trailing 0xff is not part of it
  assert.throws(() => decodeCbor(Buffer.from([0x5a, 0, 0, 0, 9, 1])), WebAuthnError); // a byte string claiming 9 bytes, only 1 there
});

for (const alg of [-7, -257, -8]) {
  test(`passkey made and used to sign in (algorithm ${alg})`, () => {
    const phone = fakeAuthenticator({ ...site, alg });
    const reg = verifyRegistration(phone.create({ challenge: 'reg-challenge-abc', user: { id: 'dXNlcg' } }), { ...site, challenge: 'reg-challenge-abc' });
    assert.equal(reg.credentialId, phone.id);
    assert.equal(reg.alg, alg);
    const saved = { alg: reg.alg, publicKey: reg.publicKey, signCount: reg.signCount };
    const r = verifyAssertion(phone.get({ challenge: 'login-1' }), saved, { ...site, challenge: 'login-1' });
    assert.equal(r.signCount, 1);
  });
}

test('passkey checks refuse the wrong challenge, site, origin, a missing face/PIN step, a bad signature and a copied key', () => {
  const phone = fakeAuthenticator(site);
  const reg = verifyRegistration(phone.create({ challenge: 'c1' }), { ...site, challenge: 'c1' });
  const saved = { alg: reg.alg, publicKey: reg.publicKey, signCount: 5 };
  const ok = (cred, s = saved) => verifyAssertion(cred, s, { ...site, challenge: 'c2' });
  assert.throws(() => ok(phone.get({ challenge: 'other' }, { count: 6 })), /expired/);
  assert.throws(() => ok(phone.get({ challenge: 'c2' }, { count: 6, origin: 'https://evil.example' })), /different site/);
  assert.throws(() => ok(phone.get({ challenge: 'c2' }, { count: 6, site: 'evil.example' })), /different site/);
  assert.throws(() => ok(phone.get({ challenge: 'c2' }, { count: 5 })), /copied/); // counter did not go up
  const tampered = phone.get({ challenge: 'c2' }, { count: 7 });
  const ad = Buffer.from(tampered.response.authenticatorData, 'base64url'); ad[36] ^= 1; // change the counter after signing
  tampered.response.authenticatorData = ad.toString('base64url');
  assert.throws(() => ok(tampered), /could not be checked/);
  assert.equal(ok(phone.get({ challenge: 'c2' }, { count: 8 })).signCount, 8);
  // Apple passkeys always send 0: allowed when the saved counter is 0 too.
  assert.equal(ok(phone.get({ challenge: 'c2' }, { count: 0 }), { ...saved, signCount: 0 }).signCount, 0);
  const lazy = fakeAuthenticator({ ...site, userVerified: false });
  assert.throws(() => verifyRegistration(lazy.create({ challenge: 'c3' }), { ...site, challenge: 'c3' }), /face, fingerprint or PIN/);
  assert.throws(() => verifyRegistration(phone.create({ challenge: 'c4' }), { ...site, challenge: 'c4', rpId: 'other.example' }), /different site/);
});
