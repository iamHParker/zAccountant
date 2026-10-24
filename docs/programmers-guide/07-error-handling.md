# 7. Error handling

The goal: when something goes wrong, the person sees **one plain sentence that says what to do**, nothing is
half-saved, and a developer can find the cause from the request id, without the logs ever holding private data.

## The contract

| What went wrong | Thrown as | HTTP status | What the person sees |
|---|---|---|---|
| A mistake in what they typed or chose | `LedgerError(message, details[])` (`src/core/ledger.js`) | 400 (404 if the message says "not found") | "Invoice is not valid: line 2: enter a price or amount; due date must be on or after the date" |
| A payroll input or table problem | `PayrollError` | 400 | the engine's sentence |
| Not signed in / two-step not done | handled in `src/app.js` | 401 | the sign-in screen |
| Role lacks the permission | `AuthError(msg, 403)` | 403 | "Your role (Bookkeeper) can't do that. Ask the company owner." |
| Plan lacks the feature | `AuthError(msg, 402)` | 402 | "Payroll isn't in this company's plan. Ask zAccountant to add it." |
| Not a member, or an id that doesn't exist | `AuthError(..., 404)` / UUID check | 404 | "Company not found" (never reveals that someone else's company exists) |
| A database rule caught it | PostgreSQL error code | 400 | a fixed sentence per code, e.g. 23514 → "That would break an accounting rule…" |
| Upload too big | `entity.too.large` | 413 | "That is too large to send (the limit here is 2 MB). Try a smaller file or picture." |
| Malformed JSON | `entity.parse.failed` | 400 | "Request body is not valid JSON" |
| Too many attempts | rate limiter | 429 | "Too many attempts. Please wait a few minutes and try again." |
| Anything else (a bug) | any other error | 500 | "Something went wrong on our side. Nothing was saved." |

Rules for writing errors:
1. **Validate in the service, before touching the database.** Collect every problem into `errors[]` and throw one
   `LedgerError('X is not valid', errors)`, so the person can fix everything in one pass.
2. **Say what to do, in the screen's words:** "choose an income account", not "accountId invalid".
3. **Never put internals in a message:** no SQL, no stack, no ids the person didn't type, no other company's data.
4. **Let the transaction do the cleanup.** Throwing anywhere inside `route()` rolls back the whole request.
   Don't catch errors only to carry on.
5. **The database is the last line.** If JavaScript misses a rule, a constraint or trigger still refuses it, and
   the person gets the fixed sentence for that error code.

## Server side, layer by layer

- **Per request:** the error handler at the end of `src/app.js` maps errors to the table above. Unexpected errors
  are logged as one JSON line (message, error code, request id, route; never the body) and kept in a ring of the last
  100 for the Developer dashboard.
- **The database connection pool** has an `error` listener (`src/db/pool.js`). A connection the database drops
  while idle is logged and replaced. Without the listener, Node would stop the whole server.
- **The process** (`src/server.js`): an unhandled promise rejection is logged and the server keeps going. An
  uncaught exception is logged and the process exits, because its state is unknown after one; Railway starts a
  fresh copy within seconds.
- **Shutting down:** on SIGTERM (every deploy) the server finishes requests in flight, then closes the database
  connections. Anything still running after 10 seconds is cut off and rolled back by PostgreSQL.
- **Start-up:** in production the server refuses to start without its required settings, and names the missing ones.

## Browser side

- `api()` in `public/app.js` turns every failure into a sentence:
  - **No connection** (offline, Wi-Fi dropped): "Can't reach zAccountant. Check your internet connection…". For a
    save it adds "Your change may not have been saved: check, then try again". Entries, invoices, bills and payments
    carry an `Idempotency-Key`, so trying again can't record them twice.
  - **No answer within 2 minutes:** "zAccountant took too long to answer…".
  - **An answer that isn't JSON** (Railway's 502 page during a deploy): "zAccountant is restarting or briefly
    unavailable (error 502). Wait a minute and try again."
  - **A refused request:** the server's sentence.
- Every failure is also recorded for 🐞 Beta feedback (`noteError`), with the request id from the `X-Request-Id`
  header. A developer can then find the matching server log line.
- **A bug in a screen's own code** is caught by Vue's `errorHandler`. It is recorded for Beta feedback and a red
  toast tells the person their saved work is safe and to reload.
- `window.onerror` and `unhandledrejection` are recorded by `feedback.js`.

## Tests for errors

`api.db.test.js` has "user mistakes are 4xx with a readable message, never 500", plus checks for 402, 403, 404 and
413. Every new route should get at least one test that bad input returns a 4xx with a sentence.
