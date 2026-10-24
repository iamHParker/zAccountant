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
                    recurring_entries, books_checks, bank_transactions, bank_rules, reconciliations, reconciliation_lines, import_batches,
                    contacts, documents, document_lines, payments, payment_applications, payroll_runs, company_roles, departments,
                    users, sessions, memberships TO ${role};
    GRANT UPDATE (next_entry_number, next_invoice_number, locked_through, sui_rate_pct, calculate_only_payroll, famli_headcount) ON companies TO ${role};
    GRANT UPDATE (totp_secret_enc, totp_enabled, totp_last_counter, recovery_codes, failed_logins, locked_until, password_hash) ON users TO ${role};
    GRANT UPDATE (mfa_passed, last_seen_at, expires_at) ON sessions TO ${role};
    GRANT UPDATE (posted_count, next_date, is_active, last_error) ON recurring_entries TO ${role};
    GRANT UPDATE (status, suggested_account_id, rule_id, journal_entry_id, note, reviewed_by, reviewed_at) ON bank_transactions TO ${role};
    GRANT UPDATE (is_active) ON bank_rules TO ${role};
    GRANT UPDATE (status, completed_by, completed_at) ON reconciliations TO ${role};
    GRANT DELETE ON reconciliations, reconciliation_lines TO ${role};
    GRANT UPDATE (status, undone_by, undone_at) ON import_batches TO ${role};
    GRANT UPDATE (name, email, phone, address, terms_days, is_1099, is_active) ON contacts TO ${role};
    GRANT UPDATE (status, void_date, void_entry_id, voided_by, voided_at) ON documents, payments TO ${role};
    GRANT DELETE ON sessions TO ${role};
    GRANT UPDATE (role, custom_role_id, department_id) ON memberships TO ${role};
    GRANT UPDATE (name, permissions) ON company_roles TO ${role};
    GRANT DELETE ON company_roles, departments TO ${role};
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
