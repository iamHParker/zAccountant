# Feature notes for Claude sessions

Moved out of the top CLAUDE.md (Homer's 120-line rule). One entry per feature: where it lives and the rules
that aren't obvious from the code. Read the entry for a feature before changing it; add one for a new feature.

- Invoices for professional services (migration 016, `src/services/invoiceSetupService.js`): saved rates/items
  (`invoice_items`, kind service = hours × rate, expense = cost passed on), line `service_date`/`item_id`, invoice
  `project` block, letterhead (address, note with tax ID + TX firm number, closing line), logo in `company_logos`,
  pinned `default_sales_tax_rate`. Layout follows Homer's Excel invoice: Hours, Date, Task, Rate, T, Subtotal.
  Expense split across jobs: quantity `1/N` from the invoice's "Jobs sharing these expenses" box; typed quantities win.
- Projects = `jobs` (+ site address; not plan-gated). Bill lines: project + "bill to client"; invoice "Pull in unbilled
  time and costs" links each line to its time entry / bill line, billed once (trigger, migration 023,
  `src/services/projectService.js`). Projects from pasted folder names (`src/core/projects.js`).
- Trips (024, `tripService.js`): projects with % shares; costs post their own entry (void + copy to edit); travel time =
  time entry with `trip_id`; billed once per project. Bookings (040, flight/hotel/car) are a plan, not money; Paid → linked cost.
- Passkeys (migration 025, `src/security/webauthn.js`): Face ID / Windows Hello sign-in = both steps; adding one needs a
  fresh authenticator code. Settings card + sign-in button.
- Road page `/road` (migration 026, `src/services/roadService.js`, `public/road.*`): phone key (Bearer, hash only,
  90 days) → inbox `road_items`; Trips → From the road accepts into the books. Offline via IndexedDB + service worker.
- Road purchases (migration 041, `src/services/purchaseService.js`): Road page Equipment / Supplies buttons → road item
  `purchase` (no trip; equipment has a serial number) → Bills → "Bought on the road" accepts it to 1500 Equipment / 6200
  Office Supplies (or another account) and posts its own entry; Void reverses. Equipment list = posted equipment purchases.
- Road time blocks (migration 042): Time screen = the day in blocks (travel / site / office, start-end, project). Travel can
  be split evenly with a second project (`splitBlock`; even halves for now; asked Homer 2026-11-06 if he ever splits 70/30). Desk → time entries.
- Receipt reading (`src/services/receiptReader.js`, `public/receipt.js`): photo → Claude → vendor/total/date fill empty
  cost boxes, saves nothing. Off until Homer sets `ANTHROPIC_API_KEY` (runbook step 12). Never log the picture.
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
