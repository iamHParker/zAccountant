-- Employee edit (CPA edit sweep, batch 3): home address (for the W-2), hire and termination dates.
-- Each paycheck keeps its own copy of the employee's details in `calculation.employee` (no column needed).
ALTER TABLE employees
  ADD COLUMN address jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN hire_date date,
  ADD COLUMN termination_date date;
