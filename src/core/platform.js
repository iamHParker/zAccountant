// Platform roles: the people who run zAccountant itself, as opposed to roles inside one company.
// ℹ️ Set in Railway's Variables, never in the database, so no screen or request can grant one:
//   DEVELOPER_EMAILS  sees the Developer dashboard (beta feedback, server errors) and the Admin dashboard
//   ADMIN_EMAILS      sees the Admin dashboard only
// Both are comma-separated lists of the emails people sign in with.
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const list = (v) => new Set(String(v ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));

/** 'developer', 'admin' or null for a signed-in email. */
export function platformRole(email, env = process.env) {
  const e = String(email ?? '').toLowerCase();
  if (!e) return null;
  if (list(env.DEVELOPER_EMAILS).has(e)) return 'developer';
  if (list(env.ADMIN_EMAILS).has(e)) return 'admin';
  return null;
}

/** The build running now: Railway names the commit it deployed; locally it's the package version only. */
export function appVersion(env = process.env) {
  const sha = env.RAILWAY_GIT_COMMIT_SHA ?? '';
  return `${VERSION}${sha ? `+${sha.slice(0, 7)}` : ''}`;
}
