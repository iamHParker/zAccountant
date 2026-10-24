-- 014: Beta feedback. One row per "Beta feedback" press: what the tester wrote, what the page captured on
-- its own (page, browser, last clicks, recent errors: never what was typed into a field), and an optional
-- picture (the screen, or a photo they attached). The Developer dashboard works through them.
-- ℹ️ The picture can show a tester's books, so only the person who sent a report and developers can read it
-- (row-level security below), and the server never writes the note or the picture to its logs.
CREATE FUNCTION zacc_current_platform_role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('zacc.platform_role', true), '') $$;

CREATE TABLE feedback_reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- "Report 12": what people say
  created_at         timestamptz NOT NULL DEFAULT now(),
  user_id            uuid NOT NULL REFERENCES users(id),
  reporter_name      text NOT NULL,          -- as they were at the time
  reporter_email     text NOT NULL,
  company_id         uuid,                   -- the company open at the time, if any (not a foreign key: reports outlive companies)
  app_version        text NOT NULL DEFAULT '' CHECK (length(app_version) <= 100),
  note               text NOT NULL CHECK (length(trim(note)) > 0 AND length(note) <= 4000),
  context            jsonb NOT NULL DEFAULT '{}',
  picture            bytea CHECK (picture IS NULL OR length(picture) <= 4000000),
  picture_type       text CHECK (picture_type IN ('image/png', 'image/jpeg')),
  picture_source     text CHECK (picture_source IN ('screen', 'photo')),
  status             text NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new', 'reviewing', 'sent_to_claude', 'not_a_defect', 'fixed')),
  claude_text        text CHECK (claude_text IS NULL OR length(claude_text) <= 20000),  -- the developer's edited write-up
  developer_note     text NOT NULL DEFAULT '' CHECK (length(developer_note) <= 4000),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         text,
  CHECK ((picture IS NULL) = (picture_type IS NULL))
);
CREATE INDEX feedback_reports_status ON feedback_reports (status, created_at);

ALTER TABLE feedback_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY feedback_reports_scope ON feedback_reports
  USING (user_id = zacc_current_user() OR zacc_current_platform_role() = 'developer')
  WITH CHECK (user_id = zacc_current_user() OR zacc_current_platform_role() = 'developer');

-- Counts for the Developer dashboard. ℹ️ SECURITY DEFINER so it can count across companies (which row-level
-- security otherwise hides); it returns numbers only, never a name or an amount.
CREATE FUNCTION zacc_platform_counts() RETURNS TABLE (users bigint, companies bigint, signed_in_today bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM companies),
            (SELECT count(DISTINCT user_id) FROM sessions WHERE last_seen_at > now() - interval '24 hours') $$;
