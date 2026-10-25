-- 026: The Road page (Homer, 2026-10-25). On a business trip the owner jots down costs, receipt photos, travel time
-- and new project numbers on the phone, even with no signal, and sends them when online. The phone holds only a
-- limited "road key": it can drop items into an inbox and read the names of open trips and projects, nothing else.
-- Back at the desk each item is reviewed and accepted into the books (or dismissed).
--
-- road_keys has no row-level security (like sessions): the key is looked up by its hash before the company is
-- known. It holds no business data, and every query on it names the company and the person.
CREATE TABLE road_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  token_hash    text NOT NULL,              -- sha256 of the key; the key itself is shown once, as a QR code
  name          text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE UNIQUE INDEX road_keys_token ON road_keys (token_hash);
CREATE INDEX road_keys_owner ON road_keys (company_id, user_id);

-- What came in from the road. data is what the phone sent, checked on arrival (see src/services/roadService.js).
CREATE TABLE road_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  key_id         uuid NOT NULL REFERENCES road_keys(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  client_id      text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9_-]{8,64}$'),   -- the phone's own id, so a resend is not a copy
  kind           text NOT NULL CHECK (kind IN ('trip', 'cost', 'time')),
  data           jsonb NOT NULL CHECK (octet_length(data::text) <= 8000),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
  trip_id        uuid,     -- an accepted trip item: the trip it made
  trip_cost_id   uuid,     -- an accepted cost: the trip cost it posted
  time_entry_id  uuid,     -- accepted travel time: its time entry
  received_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_by    text,
  reviewed_at    timestamptz,
  UNIQUE (key_id, client_id),
  FOREIGN KEY (company_id, trip_id) REFERENCES trips(company_id, id),
  FOREIGN KEY (company_id, trip_cost_id) REFERENCES trip_costs(company_id, id),
  CHECK ((status = 'pending') = (reviewed_at IS NULL))
);
CREATE INDEX road_items_pending ON road_items (company_id, received_at) WHERE status = 'pending';

-- Receipt photos taken on the road; copied to the trip cost when the item is accepted. Never logged.
CREATE TABLE road_photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  item_id      uuid NOT NULL REFERENCES road_items(id),
  client_id    text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  picture      bytea NOT NULL CHECK (octet_length(picture) <= 3145728),
  picture_type text NOT NULL CHECK (picture_type IN ('image/png', 'image/jpeg')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, client_id)
);

ALTER TABLE road_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY road_items_company ON road_items USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());
ALTER TABLE road_photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY road_photos_company ON road_photos USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());
