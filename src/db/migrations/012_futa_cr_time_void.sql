-- 012: FUTA credit-reduction estimate per state, and voided paychecks reopen the timesheet hours they paid.
ALTER TABLE companies ADD COLUMN futa_credit_reduction jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(futa_credit_reduction) = 'object');

ALTER TABLE time_entries ADD COLUMN paid_paycheck_id uuid;
ALTER TABLE time_entries ADD FOREIGN KEY (company_id, paid_paycheck_id) REFERENCES paychecks(company_id, id);
ALTER TABLE time_entries ADD CHECK (paid_paycheck_id IS NULL OR paid_run_id IS NOT NULL);

-- Paid hours stay final, with one exception: voiding the paycheck that paid them clears the
-- "paid" marks (and nothing else), so the hours can be paid again.
CREATE OR REPLACE FUNCTION zacc_time_paid_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.paid_run_id IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND NEW.paid_run_id IS NULL AND NEW.paid_paycheck_id IS NULL
       AND (to_jsonb(NEW) - ARRAY['paid_run_id','paid_paycheck_id','updated_at']) = (to_jsonb(OLD) - ARRAY['paid_run_id','paid_paycheck_id','updated_at']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'paid time entries cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
