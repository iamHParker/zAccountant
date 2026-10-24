// Password hashing and field-level encryption.
import { scrypt, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, hkdfSync, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 32;

/** Hash a password with scrypt (memory-hard, slows down password guessing). Format: scrypt$N$r$p$salt$hash */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, n, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(key, expected);
}

/** A hash used only to make well-timed fake comparisons when the email doesn't exist. */
export const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(32).toString('base64');

const COMMON = new Set(['password1234', '123456789012', 'qwertyuiopas', 'passwordpassword', 'letmein12345', 'zaccountant123']);
export function passwordProblems(pw, email = '') {
  const problems = [];
  if (typeof pw !== 'string' || pw.length < 12) problems.push('use at least 12 characters');
  else if (pw.length > 200) problems.push('use at most 200 characters');
  else if (COMMON.has(pw.toLowerCase()) || (email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length >= 4)) {
    problems.push('choose a less guessable password');
  }
  return problems;
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

// ---- Field encryption (AES-256-GCM). The master key lives outside the database (env now, cloud KMS later).
// Each company (or user) gets its own derived key, so one leaked derived key exposes only that scope.
const DEV_FIELD_KEY = Buffer.alloc(32, 7).toString('base64');
function masterKey() {
  const k = process.env.FIELD_ENCRYPTION_KEY;
  if (!k) {
    if (process.env.NODE_ENV === 'production') throw new Error('FIELD_ENCRYPTION_KEY must be set in production');
    return Buffer.from(DEV_FIELD_KEY, 'base64');
  }
  const b = Buffer.from(k, 'base64');
  if (b.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return b;
}
const scopedKey = (scope) => Buffer.from(hkdfSync('sha256', masterKey(), Buffer.from('zacc-field-v1'), Buffer.from(String(scope)), 32));

export function encryptField(plaintext, scope) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', scopedKey(scope), iv);
  c.setAAD(Buffer.from(String(scope)));
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decryptField(blob, scope) {
  const [v, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1') throw new Error('unknown encryption version');
  const d = createDecipheriv('aes-256-gcm', scopedKey(scope), Buffer.from(iv, 'base64'));
  d.setAAD(Buffer.from(String(scope)));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
