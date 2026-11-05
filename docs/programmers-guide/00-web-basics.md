# 0. Web basics for an engineer

Read this first if you come from Fortran, C, VB or Xojo and have never built a web application. It explains the
handful of web ideas the rest of this guide takes for granted, each tied to something you already know, and points to
where zAccountant uses it. Nothing here is specific to accounting.

## The big picture: two programs talking

A desktop program (a Xojo app, say) is one program on one machine: the window, the logic and the data file are all in
the same process. A web application is **two programs on two machines** that talk over the internet:

```
 The person's computer or phone                        Railway (a rented computer in a data centre)
 ┌──────────────────────────────┐   HTTP request       ┌───────────────────────────────┐      SQL       ┌────────────┐
 │ Browser (Safari, Chrome, Edge)│ ───────────────────▶ │ Node.js server  (src/server.js)│ ────────────▶ │ PostgreSQL │
 │ runs public/app.js (Vue)      │ ◀─────────────────── │ Express routes  (src/app.js)   │ ◀──────────── │  database  │
 └──────────────────────────────┘   HTTP response       └───────────────────────────────┘    rows        └────────────┘
```

- The **browser** draws the screens and reacts to clicks. It holds no books; it asks the server for everything.
- The **server** holds the rules: who may do what, how an invoice posts, how a paycheck is worked out.
- The **database** holds the data, and also enforces the most important rules a second time (chapter 2), the way a
  structure has redundant load paths.

The browser and the server never share memory. Everything goes back and forth as messages. That is the single biggest
difference from desktop programming, and most of the rest follows from it.

## HTTP: the message format

Every exchange is one **request** and one **response**, like a transmittal and its reply.

A request has:

| Part | Example | Analogy |
|---|---|---|
| Method (the verb) | `GET` read, `POST` create, `PUT` replace, `PATCH` change part, `DELETE` remove | the action box on a transmittal |
| Path (the address) | `/api/companies/7b…/invoices` | the drawing number |
| Headers | `Content-Type: application/json`, the session cookie | the title block |
| Body (optional) | `{"customerId": "…", "lines": [...]}` | the enclosed drawings |

A response has a **status code**, headers and a body. The status code is a three-digit summary:

| Code | Meaning | zAccountant uses it for |
|---|---|---|
| 200 | OK | success |
| 400 | your request is wrong | a form with a mistake (the body lists every problem), or the books refused it (unbalanced, closed period, already billed) |
| 401 | who are you? | not signed in |
| 402 | payment required | the company's plan doesn't include that feature |
| 403 | not allowed | your role lacks the permission |
| 404 | not found | also used when a company isn't yours, so its existence isn't revealed |
| 413 | too large | a picture or file over the limit |
| 429 | too many requests | too many sign-in tries or requests in a short time |
| 500 | the server failed | a bug: nothing was saved |

Chapter 7 shows how every error becomes one of these codes plus a plain sentence.

## JSON: the data on the wire

The bodies are **JSON** (JavaScript Object Notation), a text format for nested records:

```json
{ "number": "26-134", "date": "2026-11-04", "lines": [ { "quantity": "2.5", "priceCents": 53125 } ] }
```

Think of it as a Fortran derived type or a VB structure written out as text. `{ }` is a record, `[ ]` is an array,
strings are in quotes. zAccountant sends money as **integer cents** (`53125` = $531.25) so no rounding happens on the
way (chapter 2).

## JavaScript and Node.js

**JavaScript** is the only language browsers run. **Node.js** is the same language running on a server, outside a
browser. zAccountant uses JavaScript on both sides, so the browser and the server can share small helpers.

Things that surprise a Fortran or C programmer:

- **No compiler step and no declared types.** A variable can hold a number now and text later. Tests (chapter 8) and
  careful checks at the edges (`cleanLines`, `toCents`) take the place of a type checker.
- **`Number` is a double.** `0.1 + 0.2` is `0.30000000000000004`. That is why money is whole cents and multiplication
  uses `BigInt`, JavaScript's exact integer type (`src/core/money.js`).
- **`async` / `await`.** Asking the database takes milliseconds, which is forever to a CPU. Instead of waiting, a
  function marked `async` says `await db.query(…)`: "park me here and serve other people until the answer comes".
  One Node process serves many people this way without threads. Read `await` as "wait for this result" and the code
  reads top to bottom like ordinary sequential code.
- **Modules.** Each file is a module; `import { toCents } from './money.js'` is like `USE money` in Fortran or
  `#include` in C, but only the names a file `export`s are visible.
- **`npm`** is the package manager. `package.json` lists the libraries the project depends on (Express, pg, Vue…);
  `npm install` downloads them into `node_modules/`; `package-lock.json` pins the exact versions, like a bill of
  materials with part numbers. `npm run <name>` runs a command listed under `scripts` in `package.json`
  (`npm test`, `npm run migrate`).

## Express: routes

**Express** is the library that turns an incoming request into a call to your function. Each **route** pairs a
method and path with a handler:

```js
api.post('/companies/:companyId/invoices/read-pdf', route('invoices', ({ db, req, companyId }) =>
  oldInvoices.readOldInvoice(db, companyId, req.body ?? {})));
```

`api` is the part of the app under `/api`, so the full address is `/api/companies/<id>/invoices/read-pdf`.
`:companyId` is a placeholder filled from the address. `route(...)` is zAccountant's own wrapper (chapter 1): before the
handler runs it checks the sign-in, the company membership, the role's permission and the plan, and it wraps the whole
thing in one database transaction. The collection of routes is called the **API** (application programming interface):
the list of things the browser can ask the server to do.

## PostgreSQL and SQL

The database is **PostgreSQL**. Data lives in **tables** (like spreadsheets with fixed, typed columns). You ask for or
change data with **SQL**:

```sql
SELECT number, total_cents FROM documents WHERE kind = 'invoice' AND status = 'posted';
```

Key words:

- **Primary key:** the column that identifies a row (`id`, a random UUID such as `7b3e…`).
- **Foreign key:** a column pointing at another table's row (`documents.contact_id` → `contacts.id`). The database
  refuses a pointer to a row that doesn't exist, like a drawing reference to a sheet that isn't in the set.
- **Constraint / trigger:** rules the database checks itself (a `CHECK` that hours are positive; a trigger that every
  entry balances). They hold even if the JavaScript has a bug.
- **Transaction:** a group of changes that all happen or none do (`BEGIN` … `COMMIT`, or `ROLLBACK`). An invoice
  writes the invoice, its lines, its journal entry and an audit row in one transaction, so a crash halfway leaves
  nothing behind.
- **Migration:** a numbered SQL file that changes the schema (`src/db/migrations/040_….sql`). They run in order, once
  each, like revisions to a drawing set (chapter 4).
- **Row-level security:** a PostgreSQL feature that hides rows from other companies inside the database itself
  (chapter 3).

## The browser side: HTML, CSS and Vue

- **HTML** is the page's structure: headings, tables, buttons, input boxes (`public/index.html`).
- **CSS** is the appearance: colours, spacing, fonts, print layout (`public/styles.css`).
- **Vue** is a library that keeps the page in step with your data. You write `{{ invoice.number }}` in the HTML, and
  whenever `invoice.number` changes in JavaScript, Vue updates the page. It is like a drawing whose dimensions are
  linked to a calculation table: change the table and the drawing redraws (chapter 6).
- **`fetch`** is how the browser sends a request to the server. zAccountant wraps it in `api()` in `public/app.js`.
- **No build step.** Many web projects run a "bundler" that compiles the browser code before deploying it.
  zAccountant doesn't: the files in `public/` are served as written, except that the server compiles the HTML
  screens once (chapter 6). Edit a file, reload the page.

## Sign-in: cookies and sessions

The web has no memory between requests: each one arrives on its own. To know it's still you, the server gives the
browser a **cookie** at sign-in: a long random token the browser sends back with every request, like a site badge.
The server looks the token up in its `sessions` table. zAccountant's cookie is `HttpOnly` (page scripts can't read it)
and `SameSite=Strict` (other websites can't make your browser send it), and it lasts 12 hours. A session counts only
after the two-step code or a passkey (chapter 3).

The Road page on the phone uses a different badge: a **bearer key** sent in the `Authorization` header, because a
phone link shouldn't carry a full sign-in.

## Security words you will meet

| Word | Plain meaning |
|---|---|
| HTTPS / TLS | the connection is encrypted; Railway provides it |
| CSRF (cross-site request forgery) | another website tricking your browser into sending a request to ours; blocked by `SameSite` cookies and by accepting only JSON from our own address |
| CSP (Content Security Policy) | a header telling the browser to run only scripts and styles from our own server. It is why the screens use classes from `styles.css` instead of inline `style="…"` |
| Rate limit | at most so many requests or sign-in tries per minute from one address, to stop guessing |
| Hash | a one-way fingerprint (SHA-256). Same input, same fingerprint; the input can't be worked back out |
| HMAC | a hash mixed with a secret key, so only someone with the key can produce it (the audit chain) |
| AES-256-GCM | the encryption used for Social Security numbers, authenticator secrets and backups |
| Passkey (WebAuthn) | sign-in with Face ID / Touch ID / Windows Hello: the device keeps a private key, the server only the public half |

## From your computer to the live site

```
 your edit ─▶ git commit ─▶ push a branch to GitHub ─▶ pull request ─▶ CI runs the tests ─▶ merge into main ─▶ Railway deploys
```

- **Git** keeps every version of every file. A **commit** is one saved set of changes with a message. A **branch** is
  a separate line of work, so `main` (what is live) is never half-edited.
- **GitHub** stores the repository online. A **pull request** (PR) is a proposal to merge a branch into `main`: a
  place to see the changes and discuss them, like a drawing submitted for review.
- **CI** (continuous integration, `.github/workflows/ci.yml`) runs on GitHub's computers for every push: it installs
  the libraries, runs every test against a real PostgreSQL 16, and checks the libraries for known security problems.
  A red ✗ means don't merge.
- **Railway** watches `main`. When a PR merges, it builds a fresh copy of the server from the `Dockerfile` (a recipe
  for the machine: Node 22, the PostgreSQL tools, our code), starts it, runs any new migrations, checks `/readyz`, and
  only then retires the old copy. Chapter 10 and `docs/runbooks/railway-setup.md` have the details.
- **Environment variables** are settings given to the server from outside the code (database address, secret keys).
  On Railway they are on the app service's **Variables** tab; on your computer you set them in the terminal. The
  README lists every one. Secrets never go in the code.

## Running it on your own computer

The README's "Running it on your computer" has the commands. In short: install Node 22 and PostgreSQL 16, then

1. `npm install`: download the libraries.
2. Make an empty database and set `DATABASE_URL` to point at it.
3. `npm run migrate`: build the tables.
4. `npm run seed` (optional): a demo company and a demo user.
5. `npm run dev`: start the server, which restarts itself when you save a file. Open `http://localhost:3000`.
6. `npm run test:unit` (seconds, no database) or `npm test` (everything) before you push.

`localhost` means "this computer"; `3000` is the **port**, a numbered door on the computer that the server listens at.
