// A pretend phone for passkey tests: makes a key pair and answers create/get the way Face ID or Windows Hello would.
import { createHash, generateKeyPairSync, sign, randomBytes } from 'node:crypto';

const sha256 = (b) => createHash('sha256').update(b).digest();
const b64 = (b) => Buffer.from(b).toString('base64url');

/** Just enough CBOR writing for COSE keys and the attestation object. */
export function encodeCbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(encodeCbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [encodeCbor(k), encodeCbor(x)])]);
  throw new Error('cannot encode');
}

export function fakeAuthenticator({ rpId, origin, alg = -7, userVerified = true }) {
  const keys = alg === -7 ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : alg === -8 ? generateKeyPairSync('ed25519') : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = keys.publicKey.export({ format: 'jwk' });
  const cose = alg === -7 ? new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])
    : alg === -8 ? new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, 'base64url')]])
      : new Map([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, 'base64url')], [-2, Buffer.from(jwk.e, 'base64url')]]);
  const credId = randomBytes(32);
  let counter = 0;
  let userHandle = null;
  const authData = (withCred, count, site = rpId) => {
    const flags = 0x01 | (userVerified ? 0x04 : 0) | (withCred ? 0x40 : 0);
    const c = Buffer.alloc(4); c.writeUInt32BE(count);
    const parts = [sha256(site), Buffer.from([flags]), c];
    if (withCred) { const len = Buffer.alloc(2); len.writeUInt16BE(credId.length); parts.push(Buffer.alloc(16), len, credId, encodeCbor(cose)); }
    return Buffer.concat(parts);
  };
  const clientData = (type, challenge, o = origin) => Buffer.from(JSON.stringify({ type, challenge, origin: o, crossOrigin: false }));
  return {
    id: b64(credId),
    set counter(n) { counter = n; },
    /** Answer navigator.credentials.create(options) — options as the server sent them. */
    create(options, { origin: o = origin } = {}) {
      userHandle = options.user?.id ?? null;
      const att = encodeCbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData(true, counter)]]));
      return { id: b64(credId), rawId: b64(credId), type: 'public-key',
        response: { clientDataJSON: b64(clientData('webauthn.create', options.challenge, o)), attestationObject: b64(att), transports: ['internal'] } };
    },
    /** Answer navigator.credentials.get(options). */
    get(options, { origin: o = origin, site = rpId, count } = {}) {
      if (count === undefined) { counter += 1; count = counter; }
      const ad = authData(false, count, site);
      const cd = clientData('webauthn.get', options.challenge, o);
      const data = Buffer.concat([ad, sha256(cd)]);
      const signature = sign(alg === -8 ? null : 'sha256', data, keys.privateKey);
      return { id: b64(credId), rawId: b64(credId), type: 'public-key',
        response: { clientDataJSON: b64(cd), authenticatorData: b64(ad), signature: b64(signature), userHandle } };
    },
  };
}
