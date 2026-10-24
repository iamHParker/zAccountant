-- 015: Plans. Which plan and add-ons each company has (the list of plans is in src/core/plans.js), and an
-- append-only log of every change. A company with no row is on the default plan (Beta tester).
-- ℹ️ Members of a company can read its row (the app needs to know what to switch on) but only a platform admin
-- or developer, through the Admin dashboard, can write one.
CREATE TABLE company_plans (
  company_id  uuid PRIMARY KEY REFERENCES companies(id),
  plan        text NOT NULL CHECK (plan ~ '^[a-z_]{1,30}$'),
  add_ons     text[] NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL
);

CREATE TABLE plan_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  company_name text NOT NULL,          -- as it was then, so the log reads on its own
  old_plan    text,
  old_add_ons text[],
  new_plan    text NOT NULL,
  new_add_ons text[] NOT NULL,
  reason      text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  changed_by  text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plan_changes_time ON plan_changes (changed_at);
CREATE TRIGGER plan_changes_immutable BEFORE UPDATE OR DELETE ON plan_changes FOR EACH ROW EXECUTE FUNCTION zacc_immutable();

CREATE FUNCTION zacc_is_platform_admin() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(zacc_current_platform_role() IN ('admin', 'developer'), false) $$;

ALTER TABLE company_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_plans_scope ON company_plans
  USING (company_id = zacc_current_company() OR zacc_is_platform_admin())
  WITH CHECK (zacc_is_platform_admin());
ALTER TABLE plan_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY plan_changes_scope ON plan_changes USING (zacc_is_platform_admin()) WITH CHECK (zacc_is_platform_admin());

-- The Admin dashboard's list of companies. ℹ️ SECURITY DEFINER so it can see every company (row-level security
-- otherwise shows only your own), so it refuses anyone but a platform admin or developer. It returns what billing
-- needs: names, owners, sizes and dates, never an amount from anyone's books.
CREATE FUNCTION zacc_admin_companies()
  RETURNS TABLE (id uuid, name text, home_state text, created_at timestamptz, owners text, members bigint,
                 employees bigint, last_activity timestamptz, plan text, add_ons text[], plan_updated_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT zacc_is_platform_admin() THEN
    RAISE EXCEPTION 'Only zAccountant admins may list companies' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT c.id, c.name, c.home_state::text, c.created_at,
           (SELECT string_agg(u.email, ', ' ORDER BY u.email) FROM memberships m JOIN users u ON u.id = m.user_id
             WHERE m.company_id = c.id AND m.role = 'owner'),
           (SELECT count(*) FROM memberships m WHERE m.company_id = c.id),
           (SELECT count(*) FROM employees e WHERE e.company_id = c.id),
           (SELECT max(s.last_seen_at) FROM sessions s JOIN memberships m ON m.user_id = s.user_id WHERE m.company_id = c.id),
           p.plan, p.add_ons, p.updated_at
      FROM companies c LEFT JOIN company_plans p ON p.company_id = c.id
     ORDER BY c.created_at DESC;
END $$;
