-- 034: Bank statements imported from a PDF (Homer, 2026-10-26), for months the bank no longer offers as CSV or QFX.
-- The rows are read from the statement's text (src/core/bankPdf.js); source 'pdf' records where they came from.
ALTER TABLE bank_transactions DROP CONSTRAINT bank_transactions_source_check;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_source_check CHECK (source IN ('csv', 'ofx', 'plaid', 'pdf'));
