-- 010: Custom roles, departments, and the "staff" preset role.
CREATE TABLE company_roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  name         text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  permissions  text[] NOT NULL,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX company_roles_name ON company_roles (company_id, lower(trim(name)));

CREATE TABLE departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX departments_name ON departments (company_id, lower(trim(name)));

ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships
  ADD COLUMN custom_role_id uuid,
  ADD COLUMN department_id uuid,
  ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner','accountant','bookkeeper','viewer','staff','custom')),
  ADD CONSTRAINT memberships_custom_role CHECK ((role = 'custom') = (custom_role_id IS NOT NULL)),
  ADD FOREIGN KEY (company_id, custom_role_id) REFERENCES company_roles(company_id, id),
  ADD FOREIGN KEY (company_id, department_id) REFERENCES departments(company_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_roles','departments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company())', t || '_company', t);
  END LOOP;
END $$;
