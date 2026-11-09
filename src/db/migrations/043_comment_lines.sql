-- Comment lines on invoices (Homer, 2026-11-09): free text such as "Weather: return trip needed" or
-- "Tenant no-show, unit 204 skipped". A comment line prints on the invoice in date order with the other lines,
-- but it carries no money: no account, no price, no amount, no tax, and it never reaches the ledger.
ALTER TABLE document_lines ADD COLUMN is_comment boolean NOT NULL DEFAULT false;
ALTER TABLE document_lines ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE document_lines ADD CONSTRAINT document_lines_comment_shape CHECK (
  CASE WHEN is_comment
    THEN account_id IS NULL AND description IS NOT NULL AND amount_cents = 0 AND unit_price_cents = 0 AND NOT taxable
         AND item_id IS NULL AND job_id IS NULL AND NOT billable AND num_nonnulls(time_entry_id, billed_line_id, trip_cost_id) = 0
    ELSE account_id IS NOT NULL
  END);
