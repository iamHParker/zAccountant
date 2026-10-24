-- 005: Recurring entries, duplicate-safe posting, and the nightly books check.

-- Idempotency key: if the browser retries a "Save" (flaky connection, double click), the same key
-- returns the entry already posted instead of posting it twice.
ALTER TABLE journal_entries ADD COLUMN idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) <= 120);
CREATE UNIQUE INDEX journal_entries_idempotency ON journal_entries (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Recurring entry templates (rent, loan payments, monthly depreciation...).
-- Occurrence n is computed from start_date + n periods (never from the previous date), so a
-- template that starts on the 31st posts on Jan 31, Feb 28, Mar 31 ... without drifting.
CREATE TABLE recurring_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  name          text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  frequency     text NOT NULL CHECK (frequency IN ('weekly','monthly','quarterly','yearly')),
  start_date    date NOT NULL,
  end_date      date CHECK (end_date IS NULL OR end_date >= start_date),
  memo          text CHECK (memo IS NULL OR length(memo) <= 500),
  lines         jsonb NOT NULL,          -- [{accountId, debitCents, creditCents, memo}]
  posted_count  integer NOT NULL DEFAULT 0 CHECK (posted_count >= 0),
  next_date     date,                    -- null when finished
  is_active     boolean NOT NULL DEFAULT true,
  last_error    text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);
CREATE INDEX recurring_entries_due ON recurring_entries (company_id, next_date) WHERE is_active;

-- Nightly check results, and the chain fingerprint ("anchor") taken each night. The same anchor is
-- also written to the server log (kept outside the database) so deleting the newest audit rows is
-- detectable: tomorrow's check must still find last night's anchor in the chain.
CREATE TABLE books_checks (
  id          bigserial PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies(id),
  run_at      timestamptz NOT NULL DEFAULT now(),
  as_of       date NOT NULL,
  ok          boolean NOT NULL,
  audit_rows  integer NOT NULL,
  anchor_seq  integer,
  anchor_hash text,
  details     jsonb NOT NULL
);
CREATE INDEX books_checks_latest ON books_checks (company_id, run_at DESC);
CREATE TRIGGER books_checks_immutable BEFORE UPDATE OR DELETE ON books_checks FOR EACH ROW EXECUTE FUNCTION zacc_immutable();

ALTER TABLE recurring_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY recurring_entries_company ON recurring_entries USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());
ALTER TABLE books_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY books_checks_company ON books_checks USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());
