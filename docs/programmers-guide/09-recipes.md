# 9. Recipes: step-by-step changes

## Add an API route

1. Write the operation in the right `src/services/*.js` file. Validate first (collect `errors[]`, throw one
   `LedgerError`), use `withTransaction(db, …)`, and write `appendAudit` for any change.
2. In `src/app.js`, register it in the area's group:
   ```js
   api.post('/companies/:companyId/things', route('admin', ({ db, req, companyId, actor }) => {
     const { name, rate } = req.body ?? {};               // pick fields by name; never pass req.body straight through
     return things.createThing(db, companyId, { name, rate, actor });
   }, 201));
   ```
3. If the URL has a new `:somethingId`, add its name to the UUID list at the top of `route()`.
4. If the feature belongs to a plan add-on, add its path to `GATES` in `src/core/plans.js`.
5. Tests in `api.db.test.js`: success, bad input → 400 with a sentence, wrong role → 403, outsider → 404.
6. Add a row to the README's API table.

## Add a company setting

1. Migration: `ALTER TABLE companies ADD COLUMN … CHECK (…)`.
2. `grant.js`: add the column to `GRANT UPDATE (…) ON companies`.
3. A service function that validates, updates, and audits (`action: 'update_settings'`).
4. A route with the `admin` permission (or a narrower one, if the setting is part of everyday work, as the sales tax
   default is for `invoices`).
5. A card in the Settings section of `index.html`, and a method in `app.js` that saves it and merges the answer into
   `this.company`.
6. A help guide paragraph in `public/help.js`, and the User Guide chapter for its tier.

## Add a report

1. Pure calculation in `src/core/reports.js`, with a built-in proof (totals that must agree).
2. A loader in `reportService.js`.
3. A route built with `report(permission, title, load, rowsFor)`. It answers JSON, or CSV with `?format=csv` (add
   `rowsFor` in `src/core/csv.js`).
4. Add it to `reportTypes` in `app.js` (with `feature` if a plan gates it), and its markup to the Reports section.

## Add next year's payroll tax tables

1. Copy `src/payroll/tables/2026.json` to `2027.json`.
2. Change every value from its official source, and record the source (publication, page, date) in the block.
3. Leave every block `verified: false`. Only the Professional Review Board sets `verified: true`, recording reviewer
   and source.
4. Add unit tests with hand-worked paychecks for each state, using the new values.

## Add a screen element that people can see

Classes only (no inline styles; see chapter 6). Use the words people use, not code names. If it changes how
something works for people, update the matching `public/help.js` guide and the User Guide chapter.

## Before you open a pull request

- [ ] `npm test` passes locally; for UI changes, a Playwright run with screenshots.
- [ ] New table or column: migration + grants + row-level security.
- [ ] Every new route names a permission and has refusal tests.
- [ ] Money stays integer cents; any rounding is explained in a test comment.
- [ ] Error messages are sentences that say what to do.
- [ ] Docs: README API table, help guide, User Guide, this guide if a rule changed, `CLAUDE.md` if a session
      needs to know it.
