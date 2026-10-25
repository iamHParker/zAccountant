-- 020: Edit an invoice, bill or payment (Homer, 2026-10-25). A saved record is never changed in place: Edit voids
-- it and posts the corrected copy in one step. replaced_by_id on the voided record points at the corrected copy
-- (set with the void, the one update the record allows). A corrected invoice keeps its number, so a number is
-- unique among invoices that were not replaced.
-- ℹ️ No foreign key: the void is written just before the copy it points at (the number must be free first), and
-- the app's nested transactions check constraints at each step. Both are written in one transaction.
ALTER TABLE documents ADD COLUMN replaced_by_id uuid;
ALTER TABLE payments ADD COLUMN replaced_by_id uuid;
DROP INDEX documents_invoice_number;
CREATE UNIQUE INDEX documents_invoice_number ON documents (company_id, lower(number)) WHERE kind = 'invoice' AND replaced_by_id IS NULL;
