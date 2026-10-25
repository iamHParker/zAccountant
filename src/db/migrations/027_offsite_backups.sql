-- 027: Nightly off-site backups (src/jobs/offsiteBackup.js). One row per try: when, how big, where it went, or why
-- it failed. Written by the nightly job (owner login); the Developer dashboard reads it. No business data, no RLS.
CREATE TABLE offsite_backups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of       date NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean,
  bytes       bigint,
  sha256      text,
  object_key  text,
  error       text
);
CREATE INDEX offsite_backups_as_of ON offsite_backups (as_of);
