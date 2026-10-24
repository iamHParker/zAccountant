-- 004: Row-level security — a second, independent wall between companies.
-- The application sets two per-transaction values: zacc.user_id (who is signed in) and
-- zacc.company_id (which company this request is for). PostgreSQL then hides every row of every
-- other company, even if application code forgot a WHERE clause.
-- Policies apply to the runtime role (zacc_app); the owner role used for migrations bypasses them.

CREATE FUNCTION zacc_current_company() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('zacc.company_id', true), '')::uuid $$;
CREATE FUNCTION zacc_current_user() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('zacc.user_id', true), '')::uuid $$;

-- SECURITY DEFINER so the companies policy can consult memberships without recursion through RLS.
CREATE FUNCTION zacc_is_member(c uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = c AND m.user_id = zacc_current_user()) $$;

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY companies_member ON companies
  USING (id = zacc_current_company() OR zacc_is_member(id))
  WITH CHECK (true);  -- creating a company is allowed; the creator becomes its owner in the same transaction

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_scope ON memberships
  USING (user_id = zacc_current_user() OR company_id = zacc_current_company())
  WITH CHECK (company_id = zacc_current_company());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','journal_entries','journal_lines','audit_log','employees','paychecks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company())', t || '_company', t);
  END LOOP;
END $$;
