-- CPA edit sweep, batch 4: void a whole payroll run (so the period can be run again) and reopen the latest
-- bank reconciliation. Both stay on record.

-- A payroll run may be marked void once (its paychecks are voided by the app in the same transaction);
-- nothing else about it changes, and it is never deleted.
ALTER TABLE payroll_runs
  ADD COLUMN void_date date,
  ADD COLUMN void_reason text CHECK (void_reason IS NULL OR length(void_reason) BETWEEN 3 AND 300),
  ADD COLUMN voided_by text,
  ADD COLUMN voided_at timestamptz;
CREATE FUNCTION zacc_run_void_once() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE void_cols text[] := ARRAY['void_date', 'void_reason', 'voided_by', 'voided_at'];
BEGIN
  IF TG_OP = 'DELETE' OR OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL
     OR (to_jsonb(NEW) - void_cols) IS DISTINCT FROM (to_jsonb(OLD) - void_cols) THEN
    RAISE EXCEPTION 'payroll_runs is append-only; a run can only be voided, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER payroll_runs_immutable ON payroll_runs;
CREATE TRIGGER payroll_runs_void_once BEFORE UPDATE OR DELETE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION zacc_run_void_once();
-- The same pay period still can't be paid twice, unless the earlier run was voided.
DROP INDEX payroll_runs_period;
CREATE UNIQUE INDEX payroll_runs_period ON payroll_runs (company_id, pay_frequency, period_start) WHERE voided_at IS NULL;

-- A finished reconciliation may go back to "in progress" only if it is the latest one for its account, and only
-- its status and finish stamp change (the ticks stay, ready to fix). Anything else stays final, as before.
CREATE OR REPLACE FUNCTION zacc_recon_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    IF TG_OP = 'UPDATE' AND NEW.status = 'open' AND NEW.completed_at IS NULL
       AND (NEW.bank_account_id, NEW.statement_date, NEW.beginning_cents, NEW.ending_cents)
           IS NOT DISTINCT FROM (OLD.bank_account_id, OLD.statement_date, OLD.beginning_cents, OLD.ending_cents)
       AND NOT EXISTS (SELECT 1 FROM reconciliations r WHERE r.company_id = OLD.company_id
                         AND r.bank_account_id = OLD.bank_account_id AND r.statement_date > OLD.statement_date) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Reconciliation is completed and cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
