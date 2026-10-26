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
                    contacts, documents, document_lines, payments, payment_applications, payroll_runs, company_roles, departments, jobs, time_entries, payroll_deposits,
                    users, sessions, memberships, feedback_reports, company_plans, plan_changes,
                    company_logos, invoice_items, account_tax_categories, payment_photos, trips, trip_jobs, trip_costs, trip_cost_photos,
                    passkeys, auth_challenges, road_keys, road_items, road_photos, mileage_drives, home_layouts TO ${role};
    GRANT UPDATE (next_entry_number, next_invoice_number, locked_through, sui_rate_pct, calculate_only_payroll, famli_headcount, futa_credit_reduction, default_sales_tax_rate,
                  invoice_address, invoice_note, invoice_footer, entity_type, books_start_date, setup_done, name, home_state, fiscal_year_start_month) ON companies TO ${role};
    GRANT UPDATE (totp_secret_enc, totp_enabled, totp_last_counter, recovery_codes, failed_logins, locked_until, password_hash, name) ON users TO ${role};
    GRANT UPDATE (mfa_passed, last_seen_at, expires_at) ON sessions TO ${role};
    GRANT UPDATE (posted_count, next_date, is_active, last_error, name, memo, lines, end_date) ON recurring_entries TO ${role};
    GRANT UPDATE (status, suggested_account_id, rule_id, journal_entry_id, note, reviewed_by, reviewed_at) ON bank_transactions TO ${role};
    GRANT UPDATE (is_active, match_text, direction, min_cents, max_cents, account_id, priority) ON bank_rules TO ${role};
    GRANT UPDATE (status, completed_by, completed_at) ON reconciliations TO ${role};
    GRANT DELETE ON reconciliations, reconciliation_lines TO ${role};
    GRANT UPDATE (status, undone_by, undone_at) ON import_batches TO ${role};
    GRANT UPDATE (name, email, phone, address, terms_days, is_1099, is_active, group_name, people) ON contacts TO ${role};
    GRANT UPDATE (name, subtype, cash_flow, is_active) ON accounts TO ${role};
    GRANT UPDATE (name) ON departments TO ${role};
    GRANT UPDATE (status, void_date, void_entry_id, voided_by, voided_at, replaced_by_id) ON documents, payments TO ${role};
    GRANT UPDATE (memo, due_date, client_ref, project, attention, send_to, care_of) ON documents TO ${role};
    GRANT UPDATE (void_date, void_reason, voided_by, voided_at) ON payroll_runs TO ${role};
    GRANT DELETE ON bank_transactions TO ${role};
    GRANT DELETE ON sessions TO ${role};
    GRANT UPDATE (sign_count, last_used_at, name) ON passkeys TO ${role};
    GRANT DELETE ON passkeys, auth_challenges TO ${role};
    GRANT UPDATE (last_used_at, revoked_at) ON road_keys TO ${role};
    GRANT UPDATE (status, reviewed_by, reviewed_at, trip_id, trip_cost_id, time_entry_id) ON road_items TO ${role};
    GRANT UPDATE (role, custom_role_id, department_id) ON memberships TO ${role};
    GRANT UPDATE (name, permissions) ON company_roles TO ${role};
    GRANT DELETE ON company_roles, departments TO ${role};
    GRANT DELETE ON memberships TO ${role};
    GRANT UPDATE (user_id, first_name, last_name, work_state, pay_frequency, pay_type, pay_rate_cents, w4, state_elections,
      ssn_enc, ssn_last4, address, active, hire_date, termination_date) ON employees TO ${role};
    GRANT UPDATE (name, code, customer_id, address, is_active) ON jobs TO ${role};
    GRANT UPDATE (job_id, trip_id, work_date, minutes, start_time, end_time, notes, billable, status, review_note, reviewed_by, reviewed_at, paid_run_id, paid_paycheck_id, updated_at) ON time_entries TO ${role};
    GRANT DELETE ON time_entries TO ${role};
    GRANT UPDATE (name, start_date, end_date, notes, is_active) ON trips TO ${role};
    GRANT UPDATE (layout, updated_at) ON home_layouts TO ${role};
    GRANT UPDATE (share_bp) ON trip_jobs TO ${role};
    GRANT DELETE ON trip_jobs, trip_cost_photos TO ${role};
    GRANT UPDATE (status, void_date, void_entry_id, voided_by, voided_at, replaced_by_id) ON trip_costs TO ${role};
    GRANT UPDATE (category, updated_at, updated_by) ON account_tax_categories TO ${role};
    GRANT DELETE ON account_tax_categories TO ${role};
    GRANT UPDATE (status, claude_text, developer_note, updated_at, updated_by) ON feedback_reports TO ${role};
    GRANT UPDATE (plan, add_ons, updated_at, updated_by) ON company_plans TO ${role};
    GRANT UPDATE (picture, picture_type, updated_at, updated_by) ON company_logos TO ${role};
    GRANT DELETE ON company_logos, payment_photos TO ${role};
    GRANT UPDATE (name, kind, rate_cents, taxable, account_id, is_active) ON invoice_items TO ${role};
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role};
    REVOKE ALL ON schema_migrations FROM ${role};`;
  await pool.query(sql);
}

/**
 * Make sure the login in `runtimeUrl` (the app's DATABASE_URL) exists with that password and has exactly
 * the runtime rights. Runs at start-up with the owner connection, so on Railway nobody has to type SQL.
 * Does nothing when the app connects as the owner itself (local development).
 */
export async function ensureRuntimeRole(ownerPool, runtimeUrl) {
  const u = new URL(runtimeUrl);
  const role = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  const { rows: [me] } = await ownerPool.query('SELECT current_user AS name, current_database() AS db');
  if (!role || role === me.name) return { role: me.name, created: false, skipped: true };
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error('The DATABASE_URL user name may use only lower-case letters, digits and _');
  if (password.length < 16) throw new Error('The DATABASE_URL password must be at least 16 characters');
  const client = await ownerPool.connect();
  try {
    const { rows: [exists] } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    const pw = client.escapeLiteral(password);
    // A new role has PostgreSQL's defaults: not a superuser, can't create roles or databases, can't skip
    // row-level security. The app's login can do nothing beyond the grants below.
    await client.query(exists ? `ALTER ROLE ${role} WITH LOGIN PASSWORD ${pw}` : `CREATE ROLE ${role} WITH LOGIN PASSWORD ${pw}`);
    const { rows: [r] } = await client.query('SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb AS too_strong FROM pg_roles WHERE rolname = $1', [role]);
    if (r.too_strong) throw new Error(`Database role ${role} has more rights than the app should; use a different user name in DATABASE_URL`);
    await client.query(`GRANT CONNECT ON DATABASE ${client.escapeIdentifier(me.db)} TO ${role}`);
  } finally {
    client.release();
  }
  await grantRuntimeRole(ownerPool, role);
  return { role, skipped: false };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPool(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL);
  grantRuntimeRole(pool, process.argv[2] ?? 'zacc_app')
    .then(() => console.log('Grants applied'))
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
