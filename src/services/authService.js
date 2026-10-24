// Sign-up, sign-in, two-factor (TOTP), sessions and company memberships.
//
// ℹ️ How a sign-in works: the browser sends email + password; we check the scrypt hash and create a
// session. The session id goes into an HttpOnly cookie (JavaScript in the page cannot read it), and
// only its SHA-256 is stored in the database. The session is "half signed in" until the person
// enters the 6-digit code from their authenticator app; only then can it reach any company data.
import { hashPassword, verifyPassword, DUMMY_HASH, passwordProblems, sha256, randomToken, encryptField, decryptField } from '../security/crypto.js';
import { newTotpSecret, verifyTotp, otpauthUri } from '../security/totp.js';
import { LedgerError } from '../core/ledger.js';
import { PRESET_ROLES, PRESET_KEYS } from '../core/permissions.js';

export class AuthError extends Error {
  constructor(message, status = 401) { super(message); this.name = 'AuthError'; this.status = status; }
}

export const ROLES = PRESET_KEYS;
const IDLE_MINUTES = 30;
const ABSOLUTE_HOURS = 12;
const MAX_FAILED = 10;
const LOCK_MINUTES = 15;

const normEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, mfaEnabled: u.totp_enabled });

async function newSession(db, userId, mfaPassed) {
  const token = randomToken(32);
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, mfa_passed, expires_at) VALUES ($1, $2, $3, now() + interval '${ABSOLUTE_HOURS} hours')`,
    [sha256(token), userId, mfaPassed]);
  return token;
}

export async function signup(db, { email, password, name }) {
  const e = normEmail(email);
  const errors = [];
  if (!EMAIL.test(e) || e.length > 254) errors.push('enter a valid email address');
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) errors.push('enter your name');
  errors.push(...passwordProblems(password, e).map((p) => `password: ${p}`));
  if (errors.length) throw new LedgerError('Sign-up is not valid', errors);
  const { rows: [exists] } = await db.query('SELECT 1 FROM users WHERE email = $1', [e]);
  if (exists) throw new LedgerError('An account with that email already exists. Sign in instead.');
  const { rows: [u] } = await db.query(
    'INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING *', [e, name.trim(), await hashPassword(password)]);
  return { user: publicUser(u), token: await newSession(db, u.id, false), next: 'mfa_setup' };
}

export async function login(db, { email, password }) {
  const e = normEmail(email);
  const { rows: [u] } = await db.query('SELECT * FROM users WHERE email = $1', [e]);
  // Always spend the same time hashing, so response time doesn't reveal whether an email exists.
  const ok = await verifyPassword(typeof password === 'string' ? password : '', u?.password_hash ?? DUMMY_HASH);
  if (u?.locked_until && new Date(u.locked_until) > new Date()) {
    throw new AuthError(`Too many failed attempts. Try again after ${new Date(u.locked_until).toLocaleTimeString('en-US', { timeZone: 'America/Chicago' })} CT.`, 429);
  }
  if (!u || !ok) {
    if (u) {
      await db.query(
        `UPDATE users SET failed_logins = failed_logins + 1,
                locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + interval '${LOCK_MINUTES} minutes' ELSE locked_until END
          WHERE id = $1`, [u.id, MAX_FAILED]);
    }
    throw new AuthError('Email or password is incorrect');
  }
  await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
  return { user: publicUser(u), token: await newSession(db, u.id, false), next: u.totp_enabled ? 'mfa_verify' : 'mfa_setup' };
}

/** Look up a session from its cookie value; extends the idle timer. Returns { session, user } or null. */
export async function getSession(db, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const { rows: [s] } = await db.query(
    `SELECT s.*, u.email, u.name, u.totp_enabled FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND s.last_seen_at > now() - interval '${IDLE_MINUTES} minutes'`,
    [sha256(token)]);
  if (!s) return null;
  await db.query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [s.token_hash]);
  return { session: s, user: { id: s.user_id, email: s.email, name: s.name, mfaEnabled: s.totp_enabled } };
}

export async function logout(db, token) {
  if (typeof token === 'string') await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

/** Step 1 of turning on two-factor: make a secret the person scans/types into their authenticator app. */
export async function mfaSetup(db, userId) {
  const { rows: [u] } = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (u.totp_enabled) throw new AuthError('Two-factor sign-in is already on', 400);
  const secret = newTotpSecret();
  await db.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [userId, encryptField(secret, `user:${userId}`)]);
  return { secret, otpauthUri: otpauthUri(secret, u.email) };
}

function makeRecoveryCodes() {
  const codes = Array.from({ length: 8 }, () => randomToken(6).replace(/[-_]/g, 'x').slice(0, 8).toUpperCase());
  return { codes, hashes: codes.map((c) => sha256(c)) };
}

/** Step 2: confirm the first code; two-factor is now required at every sign-in. Returns one-time recovery codes. */
export async function mfaEnable(db, userId, tokenHash, code) {
  const { rows: [u] } = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (u.totp_enabled) throw new AuthError('Two-factor sign-in is already on', 400);
  if (!u.totp_secret_enc) throw new AuthError('Start two-factor setup first', 400);
  const counter = verifyTotp(decryptField(u.totp_secret_enc, `user:${userId}`), code);
  if (counter === null) throw new AuthError('That code is not correct. Check the time on your phone and try the newest code.', 400);
  const { codes, hashes } = makeRecoveryCodes();
  await db.query('UPDATE users SET totp_enabled = true, totp_last_counter = $2, recovery_codes = $3 WHERE id = $1', [userId, counter, hashes]);
  await db.query('UPDATE sessions SET mfa_passed = true WHERE token_hash = $1', [tokenHash]);
  return { recoveryCodes: codes };
}

/** Check a 6-digit code (or a one-time recovery code). Each code works only once. */
export async function checkSecondFactor(db, userId, { code, recoveryCode }) {
  const { rows: [u] } = await db.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!u.totp_enabled) throw new AuthError('Two-factor sign-in is not set up', 400);
  if (recoveryCode) {
    const h = sha256(String(recoveryCode).trim().toUpperCase());
    if (!u.recovery_codes.includes(h)) throw new AuthError('That recovery code is not valid');
    await db.query('UPDATE users SET recovery_codes = array_remove(recovery_codes, $2) WHERE id = $1', [userId, h]);
    return true;
  }
  const counter = verifyTotp(decryptField(u.totp_secret_enc, `user:${userId}`), code);
  if (counter === null || (u.totp_last_counter != null && counter <= Number(u.totp_last_counter))) {
    throw new AuthError('That code is not correct (or was already used)');
  }
  await db.query('UPDATE users SET totp_last_counter = $2 WHERE id = $1', [userId, counter]);
  return true;
}

export async function mfaVerify(db, userId, tokenHash, input) {
  await checkSecondFactor(db, userId, input);
  // New session id after full sign-in (prevents session fixation).
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  return { token: await newSession(db, userId, true) };
}

// ---- Memberships

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What this user may do in this company: { role, roleName, permissions: Set, departmentId }, or null
 * if they are not a member. A custom role's permissions come from its company_roles row.
 */
export async function getAccess(db, userId, companyId) {
  const { rows: [m] } = await db.query(
    `SELECT m.role, m.department_id, r.name AS custom_name, r.permissions AS custom_permissions
       FROM memberships m LEFT JOIN company_roles r ON r.id = m.custom_role_id
      WHERE m.user_id = $1 AND m.company_id = $2`, [userId, companyId]);
  if (!m) return null;
  const custom = m.role === 'custom';
  return {
    role: m.role, roleName: custom ? m.custom_name : PRESET_ROLES[m.role].label,
    permissions: new Set(custom ? m.custom_permissions : PRESET_ROLES[m.role].permissions), departmentId: m.department_id,
  };
}

export async function getRole(db, userId, companyId) {
  return (await getAccess(db, userId, companyId))?.role ?? null;
}

export async function listMembers(db, companyId) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, m.role, m.custom_role_id AS "roleId", r.name AS "customRoleName",
            m.department_id AS "departmentId", d.name AS "departmentName"
       FROM memberships m JOIN users u ON u.id = m.user_id
       LEFT JOIN company_roles r ON r.id = m.custom_role_id LEFT JOIN departments d ON d.id = m.department_id
      WHERE m.company_id = $1 ORDER BY u.name`, [companyId]);
  return rows.map((r) => ({ ...r, roleName: r.role === 'custom' ? r.customRoleName : PRESET_ROLES[r.role].label }));
}

/**
 * Add an existing user to a company, or change their role/department. `role` is a built-in role
 * (owner, accountant, bookkeeper, viewer, staff) or the id of a custom role. Email invitations come
 * with email delivery in a later sprint.
 */
export async function addMember(db, companyId, { email, role, departmentId = null }) {
  let preset = role;
  let customId = null;
  if (typeof role === 'string' && UUIDISH.test(role)) {
    const { rows: [r] } = await db.query('SELECT id FROM company_roles WHERE company_id = $1 AND id = $2', [companyId, role]);
    if (!r) throw new LedgerError('That role does not exist in this company');
    preset = 'custom'; customId = r.id;
  } else if (!ROLES.includes(role)) throw new LedgerError(`role must be one of ${ROLES.join(', ')}, or a custom role`);
  if (departmentId != null && departmentId !== '') {
    if (typeof departmentId !== 'string' || !UUIDISH.test(departmentId)) throw new LedgerError('That department does not exist');
    const { rows: [d] } = await db.query('SELECT id FROM departments WHERE company_id = $1 AND id = $2', [companyId, departmentId]);
    if (!d) throw new LedgerError('That department does not exist');
  } else departmentId = null;
  const { rows: [u] } = await db.query('SELECT id, email, name FROM users WHERE email = $1', [normEmail(email)]);
  if (!u) throw new LedgerError('No zAccountant user has that email. Ask them to sign up first.');
  if (preset !== 'owner') {
    const { rows: owners } = await db.query("SELECT user_id FROM memberships WHERE company_id = $1 AND role = 'owner'", [companyId]);
    if (owners.length === 1 && owners[0].user_id === u.id) throw new LedgerError('A company must keep at least one owner');
  }
  await db.query(
    `INSERT INTO memberships (company_id, user_id, role, custom_role_id, department_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role, custom_role_id = EXCLUDED.custom_role_id, department_id = EXCLUDED.department_id`,
    [companyId, u.id, preset, customId, departmentId]);
  return { ...u, role: preset, roleId: customId, departmentId };
}

export async function removeMember(db, companyId, userId) {
  const { rows: owners } = await db.query("SELECT user_id FROM memberships WHERE company_id = $1 AND role = 'owner'", [companyId]);
  if (owners.length === 1 && owners[0].user_id === userId) throw new LedgerError('A company must keep at least one owner');
  await db.query('DELETE FROM memberships WHERE company_id = $1 AND user_id = $2', [companyId, userId]);
}
