// Gives the runtime database role exactly the rights the app needs — and no more.
// The runtime role cannot UPDATE/DELETE ledger history, cannot disable triggers (it doesn't own the
// tables), and is subject to row-level security. Run with the OWNER connection:
//   MIGRATION_DATABASE_URL=postgres://owner@.../zacc  node src/db/grant.js zacc_app
import { fileURLToPath } from 'node:url';
import { createPool } from './pool.js';

export async function grantRuntimeRole(pool, role) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error('invalid role name');
  const sql = `
    GRANT USAGE ON SCHEMA public TO ${role};
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role};
    GRANT INSERT ON companies, accounts, journal_entries, journal_lines, audit_log, employees, paychecks,
                    recurring_entries, books_checks,
                    users, sessions, memberships TO ${role};
    GRANT UPDATE (next_entry_number, locked_through, sui_rate_pct, calculate_only_payroll, famli_headcount) ON companies TO ${role};
    GRANT UPDATE (totp_secret_enc, totp_enabled, totp_last_counter, recovery_codes, failed_logins, locked_until, password_hash) ON users TO ${role};
    GRANT UPDATE (mfa_passed, last_seen_at, expires_at) ON sessions TO ${role};
    GRANT UPDATE (posted_count, next_date, is_active, last_error) ON recurring_entries TO ${role};
    GRANT DELETE ON sessions TO ${role};
    GRANT UPDATE (role) ON memberships TO ${role};
    GRANT DELETE ON memberships TO ${role};
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role};
    REVOKE ALL ON schema_migrations FROM ${role};`;
  await pool.query(sql);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPool(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL);
  grantRuntimeRole(pool, process.argv[2] ?? 'zacc_app')
    .then(() => console.log('Grants applied'))
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
