-- 009: Payroll runs — pay everyone on a pay schedule at once, for a stated pay period.
CREATE TABLE payroll_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  pay_frequency        text NOT NULL CHECK (pay_frequency IN ('weekly','biweekly','semimonthly','monthly')),
  period_start         date NOT NULL,
  period_end           date NOT NULL CHECK (period_end >= period_start),
  pay_date             date NOT NULL CHECK (pay_date >= period_start),
  paid_from_account_id uuid,
  paycheck_count       integer NOT NULL CHECK (paycheck_count > 0),
  gross_cents          bigint NOT NULL,
  net_pay_cents        bigint NOT NULL,
  employee_tax_cents   bigint NOT NULL,
  employer_tax_cents   bigint NOT NULL,
  deduction_cents      bigint NOT NULL,
  idempotency_key      text,
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, paid_from_account_id) REFERENCES accounts(company_id, id)
);
-- The same pay period can't be run twice for a schedule (catches paying everyone twice).
CREATE UNIQUE INDEX payroll_runs_period ON payroll_runs (company_id, pay_frequency, period_start);
CREATE UNIQUE INDEX payroll_runs_idem ON payroll_runs (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER payroll_runs_immutable BEFORE UPDATE OR DELETE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION zacc_immutable();

ALTER TABLE paychecks
  ADD COLUMN run_id uuid,
  ADD COLUMN period_start date,
  ADD COLUMN period_end date,
  ADD FOREIGN KEY (company_id, run_id) REFERENCES payroll_runs(company_id, id),
  ADD CHECK (period_end IS NULL OR period_end >= period_start);

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY payroll_runs_company ON payroll_runs USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());
