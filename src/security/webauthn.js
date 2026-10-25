// Passkeys (WebAuthn): sign in with Face ID, Touch ID, Windows Hello or the device's PIN (Homer, 2026-10-25).
//
// ℹ️ How it works, in plain terms. When a person adds a passkey, their phone or computer makes a key pair: the
// private half never leaves the device (it sits in the secure chip, unlocked only by their face, finger or PIN),
// and the public half is sent here and saved. To sign in, the server sends a random "challenge"; the device signs
// it after the person looks at it or touches it, and the server checks the signature with the saved public half.
// Nothing typed, so nothing a camera over the shoulder can read, and nothing a fake site can reuse (the browser
// signs only for this site's address).
//
// Only what we need is checked here: no attestation (we don't need to know who made the device, so we ask for
// 'none'), algorithms ES256, RS256 and EdDSA, and user verification is required (the face/finger/PIN step).
import { createHash, createPublicKey, verify as cryptoVerify, timingSafeEqual } from 'node:crypto';

export class WebAuthnError extends Error {
  constructor(message) { super(message); this.name = 'WebAuthnError'; }
}

export const ALGORITHMS = [-7, -257, -8]; // ES256 (P-256), RS256, EdDSA (Ed25519): COSE numbers, preferred first

const sha256 = (b) => createHash('sha256').update(b).digest();
const fromB64url = (s, what) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s) || s.length > 100_000) throw new WebAuthnError(`${what} is not valid`);
  return Buffer.from(s, 'base64url');
};

/**
 * Minimal CBOR reader (RFC 8949), enough for what authenticators send: unsigned/negative integers, byte and text
 * strings, arrays, maps, true/false/null. Returns { value, end } so the caller knows where the item stopped.
 */
export function decodeCbor(buf, start = 0) {
  let pos = start;
  const need = (n) => { if (pos + n > buf.length) throw new WebAuthnError('CBOR data is cut short'); };
  const readLength = (info) => {
    if (info < 24) return info;
    if (info === 24) { need(1); return buf[pos++]; }
    if (info === 25) { need(2); const v = buf.readUInt16BE(pos); pos += 2; return v; }
    if (info === 26) { need(4); const v = buf.readUInt32BE(pos); pos += 4; return v; }
    if (info === 27) {
      need(8); const v = buf.readBigUInt64BE(pos); pos += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new WebAuthnError('CBOR number too large');
      return Number(v);
    }
    throw new WebAuthnError('CBOR indefinite lengths are not supported');
  };
  const item = (depth) => {
    if (depth > 16) throw new WebAuthnError('CBOR nested too deeply');
    need(1);
    const b = buf[pos++];
    const major = b >> 5, info = b & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new WebAuthnError('CBOR value type not supported');
    }
    const n = readLength(info);
    switch (major) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: { need(n); const v = buf.subarray(pos, pos + n); pos += n; return Buffer.from(v); }
      case 3: { need(n); const v = buf.toString('utf8', pos, pos + n); pos += n; return v; }
      case 4: { const a = []; for (let i = 0; i < n; i++) a.push(item(depth + 1)); return a; }
      case 5: {
        const m = new Map();
        for (let i = 0; i < n; i++) { const k = item(depth + 1); m.set(k, item(depth + 1)); }
        return m;
      }
      default: throw new WebAuthnError('CBOR tags are not supported');
    }
  };
  const value = item(0);
  return { value, end: pos };
}

/** A COSE public key (as sent by the authenticator) → { alg, jwk } that Node's crypto can use. */
export function coseToJwk(cose) {
  if (!(cose instanceof Map)) throw new WebAuthnError('The public key is not valid');
  const kty = cose.get(1), alg = cose.get(3);
  const b64 = (v) => { if (!Buffer.isBuffer(v)) throw new WebAuthnError('The public key is not valid'); return v.toString('base64url'); };
  if (alg === -7 && kty === 2 && cose.get(-1) === 1) return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64(cose.get(-2)), y: b64(cose.get(-3)) } };
  if (alg === -257 && kty === 3) return { alg, jwk: { kty: 'RSA', n: b64(cose.get(-1)), e: b64(cose.get(-2)) } };
  if (alg === -8 && kty === 1 && cose.get(-1) === 6) return { alg, jwk: { kty: 'OKP', crv: 'Ed25519', x: b64(cose.get(-2)) } };
  throw new WebAuthnError('That kind of passkey is not supported');
}

/** Read the authenticator data block: rpIdHash, flags, signCount and, at registration, the new credential. */
export function parseAuthData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 37) throw new WebAuthnError('Authenticator data is not valid');
  const flags = buf[32];
  const out = {
    rpIdHash: buf.subarray(0, 32), signCount: buf.readUInt32BE(33),
    userPresent: Boolean(flags & 0x01), userVerified: Boolean(flags & 0x04), hasCredential: Boolean(flags & 0x40),
  };
  if (out.hasCredential) {
    if (buf.length < 55) throw new WebAuthnError('Authenticator data is not valid');
    const idLen = buf.readUInt16BE(53);
    if (idLen > 1023 || buf.length < 55 + idLen) throw new WebAuthnError('Authenticator data is not valid');
    out.credentialId = Buffer.from(buf.subarray(55, 55 + idLen));
    out.credentialKey = decodeCbor(buf, 55 + idLen).value;
  }
  return out;
}

function checkClientData(b64, { type, challenge, origin }) {
  const raw = fromB64url(b64, 'Client data');
  let c;
  try { c = JSON.parse(raw.toString('utf8')); } catch { throw new WebAuthnError('Client data is not valid'); }
  if (c?.type !== type) throw new WebAuthnError('Client data is for the wrong step');
  const got = typeof c.challenge === 'string' ? Buffer.from(c.challenge, 'base64url') : Buffer.alloc(0);
  const want = Buffer.from(challenge, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new WebAuthnError('That sign-in request has expired. Try again.');
  if (c.origin !== origin) throw new WebAuthnError('That passkey answered for a different site');
  if (c.crossOrigin === true) throw new WebAuthnError('That passkey answered for a different site');
  return raw;
}

function checkAuthData(auth, rpId) {
  if (!auth.rpIdHash.equals(sha256(rpId))) throw new WebAuthnError('That passkey is for a different site');
  if (!auth.userPresent || !auth.userVerified) throw new WebAuthnError('The device did not confirm it was you (face, fingerprint or PIN). Try again.');
}

/**
 * Check a new passkey (navigator.credentials.create's answer). `credential` is what the browser sent, with its
 * binary fields in base64url. Returns { credentialId, alg, publicKey (JWK as JSON text), signCount, transports }.
 */
export function verifyRegistration(credential, { challenge, origin, rpId }) {
  const r = credential?.response ?? {};
  checkClientData(r.clientDataJSON, { type: 'webauthn.create', challenge, origin });
  const att = decodeCbor(fromB64url(r.attestationObject, 'Attestation')).value;
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new WebAuthnError('Attestation is not valid');
  const auth = parseAuthData(att.get('authData'));
  checkAuthData(auth, rpId);
  if (!auth.hasCredential) throw new WebAuthnError('The device sent no passkey');
  const rawId = fromB64url(credential.rawId ?? credential.id, 'Passkey id');
  if (!rawId.equals(auth.credentialId)) throw new WebAuthnError('Passkey id does not match');
  const { alg, jwk } = coseToJwk(auth.credentialKey);
  createPublicKey({ key: jwk, format: 'jwk' }); // throws on a malformed key
  const transports = Array.isArray(r.transports)
    ? r.transports.filter((t) => typeof t === 'string' && /^[a-z-]{1,20}$/.test(t)).slice(0, 8) : [];
  return { credentialId: auth.credentialId.toString('base64url'), alg, publicKey: JSON.stringify(jwk), signCount: auth.signCount, transports };
}

/**
 * Check a sign-in (navigator.credentials.get's answer) against the saved passkey { alg, publicKey, signCount }.
 * Returns { signCount } to save. A counter that goes backwards means the passkey was copied: refused.
 */
export function verifyAssertion(credential, saved, { challenge, origin, rpId }) {
  const r = credential?.response ?? {};
  const clientData = checkClientData(r.clientDataJSON, { type: 'webauthn.get', challenge, origin });
  const authBuf = fromB64url(r.authenticatorData, 'Authenticator data');
  const auth = parseAuthData(authBuf);
  checkAuthData(auth, rpId);
  const signature = fromB64url(r.signature, 'Signature');
  const key = createPublicKey({ key: JSON.parse(saved.publicKey), format: 'jwk' });
  const data = Buffer.concat([authBuf, sha256(clientData)]);
  const ok = cryptoVerify(saved.alg === -8 ? null : 'sha256', data, key, signature);
  if (!ok) throw new WebAuthnError('That passkey could not be checked');
  const before = Number(saved.signCount ?? 0);
  if ((auth.signCount !== 0 || before !== 0) && auth.signCount <= before) {
    throw new WebAuthnError('That passkey looks copied (its counter went backwards). Remove it and add it again.');
  }
  return { signCount: auth.signCount };
}
