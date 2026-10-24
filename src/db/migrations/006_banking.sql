-- 006: Banking — imported bank transactions, categorization rules, and reconciliations.

-- One row per transaction the bank reports. Amount is signed: + money in, - money out.
-- A bank transaction is either still to review, posted as a new entry, matched to an entry already
-- in the books, or excluded (e.g. a duplicate the bank sent twice).
CREATE TABLE bank_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  bank_account_id  uuid NOT NULL,
  posted_date      date NOT NULL,
  amount_cents     bigint NOT NULL CHECK (amount_cents <> 0 AND abs(amount_cents) <= 100000000000),
  description      text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  dedupe_key       text NOT NULL,
  source           text NOT NULL CHECK (source IN ('csv','ofx','plaid')),
  import_batch     uuid NOT NULL,
  status           text NOT NULL DEFAULT 'review' CHECK (status IN ('review','posted','matched','excluded')),
  suggested_account_id uuid,
  rule_id          uuid,
  journal_entry_id uuid,
  note             text CHECK (note IS NULL OR length(note) <= 300),
  reviewed_by      text,
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, bank_account_id, dedupe_key),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, bank_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, suggested_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id),
  CHECK ((status IN ('posted','matched')) = (journal_entry_id IS NOT NULL))
);
CREATE INDEX bank_transactions_review ON bank_transactions (company_id, bank_account_id, status, posted_date);
-- One bank transaction per journal entry, so the same entry can't "clear" two bank lines.
CREATE UNIQUE INDEX bank_transactions_one_per_entry ON bank_transactions (company_id, journal_entry_id) WHERE journal_entry_id IS NOT NULL;

CREATE TABLE bank_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  match_text  text NOT NULL CHECK (length(trim(match_text)) BETWEEN 2 AND 100),
  direction   text NOT NULL DEFAULT 'any' CHECK (direction IN ('in','out','any')),
  min_cents   bigint CHECK (min_cents IS NULL OR min_cents >= 0),
  max_cents   bigint CHECK (max_cents IS NULL OR max_cents >= 0),
  account_id  uuid NOT NULL,
  priority    integer NOT NULL DEFAULT 100,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id)
);

-- Bank reconciliation: tick off each book entry that appears on the bank statement until the
-- cleared balance equals the statement's ending balance (difference $0.00), then finish.
CREATE TABLE reconciliations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id),
  bank_account_id     uuid NOT NULL,
  statement_date      date NOT NULL,
  beginning_cents     bigint NOT NULL,
  ending_cents        bigint NOT NULL,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
  completed_by        text,
  completed_at        timestamptz,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, bank_account_id) REFERENCES accounts(company_id, id)
);
-- Only one reconciliation in progress per bank account.
CREATE UNIQUE INDEX reconciliations_one_open ON reconciliations (company_id, bank_account_id) WHERE status = 'open';

CREATE TABLE reconciliation_lines (
  company_id        uuid NOT NULL,
  reconciliation_id uuid NOT NULL,
  journal_line_id   bigint NOT NULL UNIQUE REFERENCES journal_lines(id),  -- a line clears once, ever
  PRIMARY KEY (reconciliation_id, journal_line_id),
  FOREIGN KEY (company_id, reconciliation_id) REFERENCES reconciliations(company_id, id)
);

-- A completed reconciliation is final: its ticked lines can't be added or removed.
CREATE FUNCTION zacc_recon_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM reconciliations WHERE id = COALESCE(NEW.reconciliation_id, OLD.reconciliation_id);
  IF st <> 'open' THEN
    RAISE EXCEPTION 'Reconciliation is completed and cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER reconciliation_lines_open BEFORE INSERT OR DELETE ON reconciliation_lines FOR EACH ROW EXECUTE FUNCTION zacc_recon_open();

CREATE FUNCTION zacc_recon_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'Reconciliation is completed and cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliations_final BEFORE UPDATE OR DELETE ON reconciliations FOR EACH ROW EXECUTE FUNCTION zacc_recon_final();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_transactions','bank_rules','reconciliations','reconciliation_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company())', t || '_company', t);
  END LOOP;
END $$;
