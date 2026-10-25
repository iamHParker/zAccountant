# 4. The database and migrations

PostgreSQL 16. The schema is a numbered series of SQL files in `src/db/migrations/`. Read them in order and they
tell the story of the product, like a set of as-built drawings with revisions.

| File | Adds |
|---|---|
| `001_core_ledger.sql` | companies, accounts, journal entries and lines, balance and immutability triggers, period lock, audit log |
| `002_payroll.sql` | employees (encrypted SSN), paychecks |
| `003_auth.sql` | users, sessions, memberships |
| `004_row_level_security.sql` | `zacc_current_company()`, `zacc_current_user()`, company policies |
| `005_recurring_and_checks.sql` | recurring entries, nightly books-check results |
| `006_banking.sql` | bank transactions, rules, reconciliations |
| `007_imports.sql` | import batches (undoable) |
| `008_ar_ap.sql` | contacts, documents (invoices and bills), lines, payments, applications |
| `009_payroll_runs.sql` | payroll runs |
| `010_roles_departments.sql` | custom roles, departments |
| `011_timesheets.sql` | jobs, time entries, employee ↔ user link |
| `012_futa_cr_time_void.sql` | FUTA credit reduction; paid time returns when a paycheck is voided |
| `013_payroll_deposits.sql` | payroll tax deposits |
| `014_feedback.sql` | beta feedback reports, platform role, platform counts |
| `015_plans.sql` | company plans, plan change log, admin company list |
| `016_invoice_items.sql` | saved invoice rates/items, line dates, project block, letterhead, logo, default sales tax rate |
| `017_company_setup.sql` | company type of business, books start date, setup-wizard done flag |
| `018_tax_ready.sql` | tax category per income/expense account (Tax-ready level 1) |
| `019_plan_names.sql` | plan renames: Basic → Company (includes payroll) |
| `020_corrections.sql` | `replaced_by_id` on documents and payments (Edit = void + corrected copy); invoice number unique among non-replaced |
| `021_payment_photos.sql` | photos of the check and remittance kept with a payment (RLS by company) |
| `022_customer_people.sql` | customer "Part of" group and people (adjusters); invoice attention, send-to, claim/job number |
| `027_offsite_backups.sql` | one row per nightly off-site backup try (when, size, SHA-256, object key, error); no business data, no RLS |
| `026_road.sql` | Road page: `road_keys` (hash only; no RLS, looked up before the company is known), `road_items` (the phone's inbox; `client_id` makes resends harmless), `road_photos`; RLS on items and photos |
| `025_passkeys.sql` | passkeys (public keys only) and one-time sign-in challenges; no company, so no row-level security (like `users`) |
| `024_trips.sql` | trips, their projects' shares (`trip_jobs.share_bp`), trip costs (own journal entry; kinds incl. mileage), receipt photos, travel time (`time_entries.trip_id`); billed once per project |
| `023_billable_time_costs.sql` | project site address; project + "bill to client" on bill lines; invoice lines linked to the time or cost they bill (billed once, by trigger) |

## How migrations run

`src/db/migrate.js` applies each file not yet listed in `schema_migrations`, in name order, **each in its own
transaction**. A file that fails is rolled back completely and stops the start-up, so a half-built schema never
happens. On Railway this runs every time the server starts (`src/server.js`), as the owner login.

## Writing a migration

1. Make a new file with the next number, for example `019_split_costs.sql`. **Never edit a migration that has
   reached `main`.** Production has already run it, and edits would never run there.
2. Start with a comment that says what the file adds and why, in plain words.
3. Every company table gets:
   - `company_id uuid NOT NULL REFERENCES companies(id)`;
   - `UNIQUE (company_id, id)`, so other tables can use a two-column foreign key that can't point across companies;
   - `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and a policy `company_id = zacc_current_company()`.
4. Put rules in the database where you can: `CHECK` constraints for ranges and lengths, `NOT NULL`, foreign keys,
   and `zacc_immutable()` triggers for history that must never change.
5. Add grants in `src/db/grant.js`: `INSERT` on the new table, `UPDATE (columns…)` only for columns the app
   really changes, `DELETE` only if the feature truly deletes.
6. Run `npm run migrate` locally, then `npm test`. `runtimeRole.db.test.js` and `api.db.test.js` run as the
   restricted login, so a missing grant fails there with "permission denied".

## Conventions

- Primary keys are `uuid` (`gen_random_uuid()`), except line tables, which use `bigserial`.
- Money columns end in `_cents` (`bigint`). Percents are stored as the typed text (`'8.25'`) and converted to ppm
  when used.
- Dates are `date`, read back as `'YYYY-MM-DD'` strings (no time-zone shifts). Timestamps are `timestamptz`.
  Business dates follow Central time (`centralToday()`).
- Who made a row: `created_by` / `updated_by` hold the person's email (the "actor").
- Pictures (logos, feedback screenshots) are `bytea` with a size `CHECK` and a type column. They are never put in
  rows that every request reads.
