-- 007: Imports of books from QuickBooks / spreadsheets. Each import is one batch; its entries carry
-- source = 'import' and source_ref = the batch id, so the batch can be undone (reversed) as a unit.
CREATE TABLE import_batches (
  id           uuid PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id),
  kind         text NOT NULL CHECK (kind IN ('accounts','opening','journal','iif')),
  file_name    text,
  entry_count  integer NOT NULL,
  total_cents  bigint NOT NULL,
  summary      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','undone')),
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  undone_by    text,
  undone_at    timestamptz,
  UNIQUE (company_id, id)
);
CREATE INDEX journal_entries_source_ref ON journal_entries (company_id, source, source_ref);
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY import_batches_company ON import_batches USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());
