-- 025: Passkeys (Homer, 2026-10-25): sign in with Face ID, Touch ID, Windows Hello or the device PIN, so no
-- password is typed where a camera could see it. The password and authenticator code stay as the backup.
-- Only the public half of each key is stored; the private half never leaves the person's device.
CREATE TABLE passkeys (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id),
  credential_id  text NOT NULL CHECK (credential_id ~ '^[A-Za-z0-9_-]+$' AND length(credential_id) BETWEEN 16 AND 1400),  -- base64url, as the device names it
  public_key     text NOT NULL CHECK (length(public_key) <= 2000),                  -- JWK (JSON)
  algorithm      integer NOT NULL CHECK (algorithm IN (-7, -257, -8)),
  sign_count     bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports     text[] NOT NULL DEFAULT '{}',
  name           text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);
CREATE UNIQUE INDEX passkeys_credential ON passkeys (credential_id);
CREATE INDEX passkeys_user ON passkeys (user_id);

-- One-time challenges for adding a passkey (user known) or signing in with one (user not yet known).
-- Only a hash is kept; each is used once and lasts five minutes.
CREATE TABLE auth_challenges (
  challenge_hash text PRIMARY KEY,
  purpose        text NOT NULL CHECK (purpose IN ('register', 'login')),
  user_id        uuid REFERENCES users(id),
  expires_at     timestamptz NOT NULL,
  CHECK ((purpose = 'register') = (user_id IS NOT NULL))
);
CREATE INDEX auth_challenges_expiry ON auth_challenges (expires_at);
