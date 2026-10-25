-- 019: Homer's subscription plans (2026-10-25): "Basic" becomes "Company", which now includes payroll, so the
-- old Payroll add-on goes away. Only companies already switched by hand have a row; the change log
-- (plan_changes) keeps the old names as history.
UPDATE company_plans SET plan = 'company' WHERE plan = 'basic';
UPDATE company_plans SET add_ons = array_remove(add_ons, 'payroll') WHERE 'payroll' = ANY (add_ons);
