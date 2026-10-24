# 8. Testing

Tests are the check calculations. A change isn't done until its tests pass on your machine and in CI (GitHub
Actions, `.github/workflows/`), which runs `npm ci`, `npm test` and `npm audit` on every push.

## Two kinds of tests

| Files | Needs | What they cover |
|---|---|---|
| `test/*.unit.test.js` | nothing | pure functions: money, ledger rules, payroll engine, reports, imports, plans, help, feedback checks |
| `test/*.db.test.js` | `DATABASE_URL` to a PostgreSQL server where the login may `CREATE DATABASE` and `CREATE ROLE` | services and the HTTP API against a real database |

```bash
npm run test:unit                                   # seconds, no database
DATABASE_URL=postgres://zacc:zacc@localhost:5432/zacc_dev npm test   # everything
node --test test/api.db.test.js                     # one file
```

Each DB test file calls `freshDatabase()` (`test/db.js`), which creates its own randomly named database, runs every
migration, and drops the database afterwards. Tests never touch real data and can run in any order.

`freshDatabase({ withAppRole: true })` also creates the restricted runtime login and grants it exactly what
`grant.js` grants. `api.db.test.js` runs the whole web app on that login, the same way production runs. **This is
where a missing grant or a row-level-security mistake shows up.**

## What a good test looks like here

- **Hand-worked arithmetic in a comment** next to the numbers it checks, so a reviewer can verify it with a
  calculator:
  ```js
  //   2.5 × 531.25 = 1,328.125 → $1,328.13 (half-up);  tax 8.25% × 1,328.13 = 109.5707 → $109.57
  assert.deepEqual([i.body.subtotalCents, i.body.taxCents], [167813, 10957]);
  ```
- **Both sides of every rule:** the allowed case, and the refused case with its status and sentence.
- **Permissions:** an outsider gets 404, a role without the permission gets 403, a plan without the feature gets 402.
- **History stays put:** the runtime role can't `UPDATE` or `DELETE` posted rows, even with raw SQL.
- **Reports tie:** after a scenario, the balance sheet balances and the aging equals the control account.

## Checking screens (Playwright)

Before a pull request that changes the UI, run the app and click through it in a real browser:

```bash
DATABASE_URL=… NIGHTLY_JOB=off AUTH_RATE_LIMIT=1000 node src/server.js &
node my-check.mjs        # a Playwright script: sign up, two-step, create a company, use the screen, screenshot
```

In a Playwright script, load the library with `createRequire(import.meta.url)('playwright')`, and get the two-step
code with `totpCode(secret)` from `src/security/totp.js`. To test failures, `page.route('**/api/**', r => r.abort())`
simulates a dropped connection, and `r.fulfill({ status: 502, body: '<h1>Bad gateway</h1>' })` simulates a restart.

## Other checks

- `npm run drill:restore`: restores a backup into a scratch database and proves the books still verify (chapter 10).
- `npm run test:load`: the load test against the 0.8 s target.
- `npm run verify:books`: re-verifies every company's audit chain and ledger.
