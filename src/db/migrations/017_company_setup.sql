-- 017: The new-company setup wizard (Homer, 2026-10-24).
--   * entity_type: how the business is organized; it decides which tax return its books feed
--     (Schedule C, 1065, 1120-S, 1120), used by the Tax-ready add-on.
--   * books_start_date: the first day of the books in zAccountant (opening balances are as of the day before).
--   * setup_done: false while the "Finish setting up" list shows on Home. Companies made before the wizard are done.

ALTER TABLE companies ADD COLUMN entity_type text
  CHECK (entity_type IS NULL OR entity_type IN ('individual', 'sole_proprietor', 'single_member_llc', 'partnership', 's_corp', 'c_corp'));
ALTER TABLE companies ADD COLUMN books_start_date date;
ALTER TABLE companies ADD COLUMN setup_done boolean NOT NULL DEFAULT false;
UPDATE companies SET setup_done = true;
