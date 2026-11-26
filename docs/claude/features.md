# Feature notes for Claude sessions

Moved out of the top CLAUDE.md (Homer's 120-line rule). One entry per feature: where it lives and the rules
that aren't obvious from the code. Read the entry for a feature before changing it; add one for a new feature.

- Invoices for professional services (migration 016, `src/services/invoiceSetupService.js`): saved rates/items
  (`invoice_items`, kind service = hours × rate, expense = cost passed on), line `service_date`/`item_id`, invoice
  `project` block, letterhead (address, note with tax ID + TX firm number, closing line), logo in `company_logos`,
  pinned `default_sales_tax_rate`. Layout follows Homer's Excel invoice: Hours, Date, Task, Rate, T, Subtotal.
  Comment lines (migration 043, `is_comment`): text + date only, no account or amount, never posted; bills refuse them.
  Expense split across jobs: quantity `1/N` from the invoice's "Jobs sharing these expenses" box; typed quantities win.
- Projects = `jobs` (+ site address; not plan-gated). Bill lines: project + "bill to client"; invoice "Pull in unbilled
  time and costs" links each line to its time entry / bill line, billed once (trigger, migration 023,
  `src/services/projectService.js`). Projects from pasted folder names (`src/core/projects.js`).
- Project drop-downs (invoice, bill lines, trip shares, Road time) all use `public/projectPick.js`: newest number first
  (the code, or the number at the front of an imported name), label `number · project · customer` (Homer 2026-11-23).
- Trips (024, `tripService.js`): projects with % shares; costs post their own entry (void + copy to edit); travel time =
  time entry with `trip_id`; billed once per project. Per diem (044): trip cost kind `per_diem` = days × rate, and
  invoice rate kind `per_day`; untaxed by default; desk, Road and the inbox fix forms all carry days + rate. Bookings (040, flight/hotel/car) are a plan, not money; Paid → linked cost.
- Passkeys (migration 025, `src/security/webauthn.js`): Face ID / Windows Hello sign-in = both steps; adding one needs a
  fresh authenticator code. Settings card + sign-in button.
- Road page `/road` (migration 026, `src/services/roadService.js`, `public/road.*`): phone key (Bearer, hash only,
  90 days) → inbox `road_items`; Trips → From the road accepts into the books. Offline via IndexedDB + service worker.
  Dismiss is undoable (Homer 2026-11-16): `?status=dismissed` + `POST …/restore` → back to pending; folded card per inbox.
- Road purchases (migration 041, `src/services/purchaseService.js`): Road page Equipment / Supplies buttons → road item
  `purchase` (no trip; equipment has a serial number) → Bills → "Bought on the road" accepts it to 1500 Equipment / 6200
  Office Supplies (or another account) and posts its own entry; Void reverses. Equipment list = posted equipment purchases.
- Road time blocks (migration 042): Time screen = the day in blocks (travel / site / office, start-end, project). Travel can
  be split with a second project by `splitPercent` (default 50; Homer asked for it 2026-11-07; `splitBlock`). Desk → time entries.
- Road inbox **Fix** (Homer 2026-11-23): every inbox item (and Bills' road purchases) can be edited before accepting;
  a refused accept opens the Fix form (accept-all errors carry `itemId`). End before start = past midnight: red warning
  at the desk; the phone needs "Yes, it ran past midnight" ticked and confirms overlapping blocks.
- Road projects (Homer 2026-11-16, no migration): Projects button → lookup (number/name/customer/street, offline from the
  summary, job-number order highest first; form fills in `nextNumber`, warns via `numberClash`; 👤 Customers tab edits any customer) and `POST /api/road/projects` → `addRoadProject` → desk's `createJob`; goes straight on the list (not an inbox
  item); needs `PROJECT_PERMISSIONS` (new customer: `CUSTOMER_PERMISSIONS`); same name = `alreadyThere`. ✏️ Edit project
  (`PUT …/projects/:id` → `updateJob`) and ✏️ Edit customer (`PATCH …/customers/:id` → `updateContact`), online only.
  A line of numbers only ("26-147, 26-148") = those projects (`typedProjects`/`numberList`), never one new project.
- Delete a project (desk Sales → Projects → delete): `projectUses` / `moveProjectUses` / `deleteProject` in
  projectService.js; only when nothing uses it; invoices and bills are never moved; 0% trip lines go with it.
- Merge projects (Homer 2026-11-23): Sales → Projects → merge → `mergeProjects` (projectService.js). Invoices/bills are
  re-saved as void + corrected copy (never updated); the old project is closed, not deleted, once any void document
  names it. Duplicate warning before adding a project: `public/projectSimilar.js` (claim number or street), desk + Road.
- Receipt reading (`src/services/receiptReader.js`, `public/receipt.js`): photo → Claude → vendor/total/date fill empty
  cost boxes, saves nothing. Off until Homer sets `ANTHROPIC_API_KEY` (runbook step 12). Never log the picture.
  Card + trip (2026-11-26): reads the card's last four (`data.card` on Road costs/purchases); desk matches the account
  whose name holds them (`cardAccountFor`). Road cost form has its own trip; receipt date → covering trip or a day run.
- Book file `.zacc` (`src/services/bookFileService.js`): zip of every company table + manifest SHA-256s; QuickBooks
  .iif / Online CSV exports. Whole-file re-import not built yet.
- MileIQ import (migration 028, `src/core/mileiq.js`, `src/services/mileIqService.js`): monthly CSV → one mileage trip
  cost per trip per day, amount = MileIQ's per-drive rounding (ties to its report); `mileage_drives` stops re-imports.
- Home cards (migration 029, `HOME_CARDS` in `public/app.js`, `homeLayoutService.js`): per-person shortcut cards,
  add/remove/move; Statistics card → `GET …/reports/statistics` (12 months, cash, top expenses, AR/AP).
- New-company setup wizard (migration 017): `entity_type`, `books_start_date`, `setup_done`; `GET/PUT …/setup`;
  the `setup` tab; Home's "Finish setting up" list. Entity type feeds Tax-ready (`src/core/entityTypes.js`).
- Tax-ready level 1 (plan feature `tax`, migration 018): `src/core/taxLines.js` (categories → form lines, 1099 threshold
  by year), `src/services/taxService.js`; Reports tabs Tax Summary, 1099-NEC, W-2 / W-3.
