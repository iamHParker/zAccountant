-- 011: Jobs and timesheets. Each member enters time against a job; an approver approves it; approved
-- hours feed the payroll run for the employee linked to that member, and are then marked paid.
CREATE TABLE jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  name         text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  code         text CHECK (code IS NULL OR length(code) <= 30),
  customer_id  uuid,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, customer_id) REFERENCES contacts(company_id, id)
);
CREATE UNIQUE INDEX jobs_name ON jobs (company_id, lower(trim(name)));

-- Which person (sign-in) an employee is, so their approved time can be paid.
ALTER TABLE employees ADD COLUMN user_id uuid REFERENCES users(id);
CREATE UNIQUE INDEX employees_user ON employees (company_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE time_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  job_id          uuid,
  work_date       date NOT NULL,
  minutes         integer NOT NULL CHECK (minutes BETWEEN 1 AND 1440),   -- exact; hours = minutes / 60
  start_time      time,
  end_time        time,
  notes           text CHECK (notes IS NULL OR length(notes) <= 500),
  billable        boolean NOT NULL DEFAULT true,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  review_note     text CHECK (review_note IS NULL OR length(review_note) <= 300),
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  paid_run_id     uuid,                       -- the payroll run that paid these hours
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','hourstracker','csv')),
  import_hash     text,                       -- repeated imports of the same row are skipped
  entered_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, job_id) REFERENCES jobs(company_id, id),
  FOREIGN KEY (company_id, paid_run_id) REFERENCES payroll_runs(company_id, id),
  CHECK (paid_run_id IS NULL OR status = 'approved')
);
CREATE INDEX time_entries_user_date ON time_entries (company_id, user_id, work_date);
CREATE UNIQUE INDEX time_entries_import ON time_entries (company_id, user_id, import_hash) WHERE import_hash IS NOT NULL;

-- Paid hours are history: they can't be changed or deleted (pay stubs depend on them).
CREATE FUNCTION zacc_time_paid_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.paid_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'paid time entries cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER time_entries_paid_final BEFORE UPDATE OR DELETE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION zacc_time_paid_final();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['jobs','time_entries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company())', t || '_company', t);
  END LOOP;
END $$;
