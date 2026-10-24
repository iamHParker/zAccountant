-- 003: Users, sessions, two-factor sign-in, company memberships, encrypted employee fields.

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL CHECK (email = lower(email) AND length(email) <= 254),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  password_hash     text NOT NULL,
  totp_secret_enc   text,                    -- AES-GCM encrypted; key outside the database
  totp_enabled      boolean NOT NULL DEFAULT false,
  totp_last_counter bigint,                  -- a code can be used only once
  recovery_codes    text[] NOT NULL DEFAULT '{}',  -- sha256 hashes of one-time recovery codes
  failed_logins     integer NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email ON users (email);

CREATE TABLE sessions (
  token_hash     text PRIMARY KEY,           -- sha256 of the cookie value; the raw token is never stored
  user_id        uuid NOT NULL REFERENCES users(id),
  mfa_passed     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE memberships (
  company_id  uuid NOT NULL REFERENCES companies(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL CHECK (role IN ('owner','accountant','bookkeeper','viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

ALTER TABLE employees ADD COLUMN ssn_enc text, ADD COLUMN ssn_last4 char(4);
