# 3. Security: sign-in, permissions, plans, row-level security

The security is built in layers, like redundant load paths. If one layer fails, the next one still holds.

## Layer 1: the front door (`src/app.js`, `src/services/authService.js`)

- **Host check:** the server answers only its own host names (`ALLOWED_HOSTS` or Railway's domain). This blocks
  "DNS rebinding" attacks.
- **Cross-site requests:** every write must be `application/json` from the same origin.
- **Rate limits:** sign-in attempts per 5 minutes and API requests per minute, per address (`AUTH_RATE_LIMIT`, `API_RATE_LIMIT`).
- **Sessions:** an HTTP-only cookie. A session counts only after two-step sign-in (`mfa_passed`). An account locks
  after 10 wrong passwords.
- **Passkeys** (`src/security/webauthn.js`, migration 025): Face ID, Touch ID, Windows Hello or the device PIN. The
  device keeps the private key; we store only the public key (`passkeys`) and one-time challenges
  (`auth_challenges`, hashed, 5 minutes). A passkey sign-in counts as both steps (the device, plus the face/finger/PIN
  the browser requires with `userVerification: 'required'`), so it starts a session with `mfa_passed`. Adding one
  needs a full sign-in **and** a fresh authenticator code. We check the challenge, the origin, the site's hash, the
  user-verified flag, the signature (ES256, RS256, EdDSA) and that the counter never goes backwards (a copied key).
  No attestation: we ask for `'none'`. Tests use a pretend device (`test/fakeAuthenticator.js`).
- **Secrets at rest:** Social Security numbers and authenticator secrets are encrypted with AES-256-GCM
  (`FIELD_ENCRYPTION_KEY`). Passwords are hashed (scrypt).

## Layer 2: permissions (`src/core/permissions.js`)

Each member of a company has one role. A role is a set of permissions:

| Permission | Lets them |
|---|---|
| `view_books` | see transactions, accounts, banking and reports |
| `post` | record, change and void transactions; banking |
| `invoices` | invoices, customers, customer payments; pin the sales tax rate |
| `bills` | bills, vendors, bill payments |
| `accounts` | change the chart of accounts; import books |
| `close` | close accounting periods |
| `payroll` | employees, paychecks, payroll taxes |
| `audit` | audit-trail checks |
| `admin` | company settings, members, roles, departments, invoice rates, letterhead, logo |
| `time_own`, `time_approve`, `time_all` | timesheets: own, own department's, everyone's |

The built-in roles are Owner (everything), Accountant (everything but `admin`), Bookkeeper, Viewer and Staff. Owners
can make custom roles. **Every route says which permission it needs:** `route('invoices', handler)`, a list meaning
"any of these", or `'member'` for anything every member may see. Reopening closed books also needs the owner plus a
fresh two-step code.

## Layer 3: plans (`src/core/plans.js`)

A company's plan switches features on: Beta tester (everything, free), Family and individuals (books only),
Company (books and payroll), with Tax-ready and Timesheets add-ons. Each plan and add-on has `monthlyCents` and
a reduced `annualCents` (Homer, 2026-10-25: subscriptions that pay for storage). `featureForPath` maps URL paths to features. `route()` answers **402** when the plan lacks the
feature. A company with no plan row is on the Beta tester plan. Plans are changed only in the Admin dashboard, and
each change is logged with a reason in `plan_changes` and the company's audit chain.

**Platform roles** (`src/core/platform.js`) come only from the `DEVELOPER_EMAILS` and `ADMIN_EMAILS` settings,
never from the database, so nobody can grant themselves one. Developers see the Developer dashboard (feedback,
server errors, backup). Admins and developers see the Admin dashboard (plans).

## Layer 4: the database itself

- **Row-level security** (`004_row_level_security.sql` and the policies added since): every company table has a
  policy `company_id = zacc_current_company()`. `withScope` sets that value per request. Even raw SQL through the
  app's login sees only the current company.
- **Restricted login:** the app connects as a runtime role that owns nothing. It can't alter tables, can't
  disable triggers, and can UPDATE only the columns listed in `src/db/grant.js`. Migrations run as the owner
  (`MIGRATION_DATABASE_URL`). At start-up `ensureRuntimeRole` creates or refreshes the runtime login.
- **SECURITY DEFINER functions** (`zacc_admin_companies`, `zacc_platform_counts`) are the only way to look across
  companies. Each one checks the platform role first and returns no amounts from anyone's books.

## The Road page's key (`src/services/roadService.js`)

The phone page `/road` never holds a session. It sends `Authorization: Bearer zr_…` (a road key; only its SHA-256 is
stored in `road_keys`) to four routes under `/api/road`: read open trip and project names, send an item, send a photo,
ask which items were accepted. Each request runs in `withScope` as the key's person and company and needs that
person's `bills` permission now, so removing the person or changing their role shuts the key. Items land in
`road_items` (pending); only **Accept** at the desk (permission `bills`) posts them, through the normal Trips code.
Keys last 90 days, at most 5 per person per company, revocable. The key travels in the link's `#` part, which browsers
never send to a server, and the page removes it from the address bar.

## Checklist for anything new

- [ ] The route names the narrowest permission that fits.
- [ ] A new table has `company_id`, row-level security and a policy, and its grants are in `grant.js`.
- [ ] A new column the app writes is in the `GRANT UPDATE (...)` list.
- [ ] Ids from the URL are in the UUID list in `route()`, and service functions check them again.
- [ ] Nothing secret goes into logs, audit payloads, error messages or feedback reports.
- [ ] A test proves an outsider gets 404 and a role without the permission gets 403.
