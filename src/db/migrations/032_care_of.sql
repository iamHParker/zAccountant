-- 032: Invoices to an attorney name the attorney's client (Homer, 2026-10-26). The Bill To box then opens with
-- "Client c/o Attorney" (e.g. "Ms Smith c/o Jane Doe, ATTY"). Set when the invoice is saved, like attention.
ALTER TABLE documents ADD COLUMN care_of text CHECK (care_of IS NULL OR length(care_of) <= 120);
