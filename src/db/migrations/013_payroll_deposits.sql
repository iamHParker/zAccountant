-- 013: Payroll tax deposits. Each row records money sent to one tax agency for the taxes of a date
-- range, with the journal entry that moved it (Dr payroll liabilities, Cr bank). Rows never change:
-- a mistaken deposit is voided by a negative row with a reversing entry, like paychecks.
CREATE TABLE payroll_deposits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id),
  agency                text NOT NULL CHECK (length(agency) BETWEEN 1 AND 80),
  form                  text NOT NULL CHECK (length(form) <= 80),
  period_start          date NOT NULL,
  period_end            date NOT NULL CHECK (period_end >= period_start),
  deposit_date          date NOT NULL,
  paid_from_account_id  uuid NOT NULL,
  amount_cents          bigint NOT NULL CHECK (amount_cents <> 0),
  lines                 jsonb NOT NULL,          -- [{ liabilityKey, amountCents }]
  reference             text CHECK (reference IS NULL OR length(reference) <= 100),
  journal_entry_id      uuid NOT NULL,
  voids_deposit_id      uuid,
  idempotency_key       text,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, paid_from_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, voids_deposit_id) REFERENCES payroll_deposits(company_id, id)
);
CREATE UNIQUE INDEX payroll_deposits_idem ON payroll_deposits (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX payroll_deposits_one_void ON payroll_deposits (company_id, voids_deposit_id) WHERE voids_deposit_id IS NOT NULL;
CREATE INDEX payroll_deposits_agency ON payroll_deposits (company_id, agency, form, period_start);
CREATE TRIGGER payroll_deposits_immutable BEFORE UPDATE OR DELETE ON payroll_deposits FOR EACH ROW EXECUTE FUNCTION zacc_immutable();

ALTER TABLE payroll_deposits ENABLE ROW LEVEL SECURITY;
CREATE POLICY payroll_deposits_company ON payroll_deposits USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());
