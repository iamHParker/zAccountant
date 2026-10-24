-- 002: Payroll.
-- SSNs/bank details are NOT stored yet; they arrive in Sprint 1 with field-level encryption.

CREATE TABLE employees (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  first_name       text NOT NULL,
  last_name        text NOT NULL,
  work_state       char(2) NOT NULL CHECK (work_state IN ('TX','CO','CA','DC')),
  pay_frequency    text NOT NULL CHECK (pay_frequency IN ('weekly','biweekly','semimonthly','monthly')),
  pay_type         text NOT NULL CHECK (pay_type IN ('salary','hourly')),
  pay_rate_cents   bigint NOT NULL CHECK (pay_rate_cents >= 0),   -- per period for salary, per hour for hourly
  w4               jsonb NOT NULL DEFAULT '{}'::jsonb,
  state_elections  jsonb NOT NULL DEFAULT '{}'::jsonb,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);

CREATE TABLE paychecks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id),
  employee_id       uuid NOT NULL,
  pay_date          date NOT NULL,
  tax_year          smallint NOT NULL,
  gross_cents       bigint NOT NULL,
  net_pay_cents     bigint NOT NULL,
  calculation       jsonb NOT NULL,          -- full engine output, for audit & pay stub
  tables_verified   boolean NOT NULL,
  journal_entry_id  uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id)
);
CREATE INDEX paychecks_ytd ON paychecks (company_id, employee_id, tax_year, pay_date);
CREATE TRIGGER paychecks_immutable BEFORE UPDATE OR DELETE ON paychecks FOR EACH ROW EXECUTE FUNCTION zacc_immutable();
