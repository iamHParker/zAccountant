# zAccountant — notes for Claude sessions

Project memory lives here (Claude memory is off for this project). Keep it short and current.

## The person
- **Homer** (GitHub `iamHParker`): structural engineer (geotechnical minor); programs in Fortran, VB, C/C++,
  assembler, Xojo. New to JavaScript and web development: explain plainly, use engineering analogies,
  never assume web jargon is known.

## The product
- Small-business accounting + payroll, built from Homer's master spec (`docs/spec/`).
- Stack: Node 22 / Express, PostgreSQL 16, Vue 3 in the browser with **no build step**, hosted on **Railway**.
- Markets: **TX, CO, CA, DC**. Time zone: **Central (CT)**. Accounting accuracy first; friendly UI second.

## Dates
- **Private alpha: Dec 1, 2026.** Until then Claude may open PRs to `main` and merge its own once CI is green
  (Homer: "Till alpha you have authority to pr to main"). After Dec 1, ask before merging.
- **Board Review #2: Dec 6, 2026** (Professional Review Board walkthrough; Review #1 is `docs/board/review-1.md`).
- **Railway setup instructions for Homer: around Nov 15, 2026.** Homer does the Railway account steps himself.
- **Public launch: Jan 1, 2027.** 2027 payroll tax tables go in during December 2026.
- **Plaid** bank feeds wait until Homer has Plaid keys.

## Decisions Homer made
- Roles, departments, permission checkboxes, timesheets (with HoursTracker CSV import feeding payroll): **all
  before launch** (done: PRs #8, #9).
- Payroll and report polish slid about a week to make room for that.

## Open items
- DC $4,150 per-allowance withholding amount: no official 2026 source (latest FR-230 is 2018). Needs DC OTR
  confirmation before the Board certifies DC.
- All tax-table blocks are `verified: false` until the Board certifies them; companies run in calculate-only mode.

## How the code is built (rules to keep)
- Money is **integer cents**; rounding is half-up with BigInt (`src/core/money.js`). Hours are whole minutes.
- Double-entry ledger enforced by the database (deferred balance trigger), append-only history, period lock,
  HMAC audit chain. AR/AP control accounts accept only document postings.
- Row-level security via `withScope`; the runtime DB role gets column-level grants (`src/db/grant.js`) — add a
  grant for every new table/column the app writes.
- Every API route names a permission (`src/core/permissions.js`); the UI hides what a role can't use, but the
  server is the gatekeeper.
- Payroll engine is pure (`src/payroll/engine.js`); tax values are data in `src/payroll/tables/<year>.json`
  with sources recorded. Tests show hand-worked arithmetic in comments.
- New schema = new numbered file in `src/db/migrations/`.

## Working here
- Tests: `npm test` (needs `DATABASE_URL`, e.g. `postgres://zacc:zacc@localhost:5432/zacc_dev`); each DB test
  file makes its own throwaway database. `npm run test:unit` needs no database.
- Run locally: `npm run migrate`, then `node src/server.js` (`NIGHTLY_JOB=off` to skip the nightly job).
- Browser checks with Playwright before UI PRs; the inline-style CSP means use classes in `public/styles.css`.
- PR bodies start with the claude-projects attribution comment for `iamHParker`; assign PRs to `iamHParker`.
