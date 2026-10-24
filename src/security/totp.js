// Time-based one-time passwords (RFC 6238) — the 6-digit codes from an authenticator app
// (Google Authenticator, Microsoft Authenticator, 1Password, Authy...).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

/** The 6-digit code for a secret at a given time step (30-second windows). */
export function totpCode(secret, timeMs = Date.now(), step = 0) {
  const counter = Math.floor(timeMs / 1000 / 30) + step;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/** Accepts the current code or one step either side (clock drift). Returns the matched counter or null. */
export function verifyTotp(secret, code, timeMs = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return null;
  const c = Buffer.from(code.trim());
  for (const step of [0, -1, 1]) {
    if (timingSafeEqual(Buffer.from(totpCode(secret, timeMs, step)), c)) return Math.floor(timeMs / 30000) + step;
  }
  return null;
}

export function otpauthUri(secret, email) {
  const label = encodeURIComponent(`zAccountant:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=zAccountant&algorithm=SHA1&digits=6&period=30`;
}
