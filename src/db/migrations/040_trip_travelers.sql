-- 040: Trips for every employee who travels (Homer, 2026-11-02). Until now a trip was one person's accumulator; a
-- cost didn't say whose it was. Now:
--   * trip_travelers: who went on a trip (one or more company members, the same people who have timesheets). Two
--     engineers on one site visit share one trip, so its projects and their shares stay in one place.
--   * trip_costs.traveler_id: whose cost each line is. Travel time already names its person (time_entries.user_id).
-- The Trips page picks an employee first, then one of that person's trips; the report "Trips by employee" totals
-- each person's trips, costs and travel time.
CREATE TABLE trip_travelers (
  company_id  uuid NOT NULL,
  trip_id     uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES users(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, user_id),
  FOREIGN KEY (company_id, trip_id) REFERENCES trips(company_id, id)
);
CREATE INDEX trip_travelers_user ON trip_travelers (company_id, user_id);
ALTER TABLE trip_travelers ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_travelers_company ON trip_travelers
  USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());

ALTER TABLE trip_costs ADD COLUMN traveler_id uuid REFERENCES users(id);
CREATE INDEX trip_costs_traveler ON trip_costs (company_id, traveler_id);

-- Costs saved before today: the person who typed them in (a trip was one person's until now), when they are still a
-- member of the company; a cost sent from the phone, the owner of the phone's road key. Anything else stays unnamed
-- ("Not named" on the report) until someone edits it.
UPDATE trip_costs tc SET traveler_id = ri.user_id
  FROM road_items ri WHERE ri.trip_cost_id = tc.id AND tc.traveler_id IS NULL;
UPDATE trip_costs tc SET traveler_id = u.id
  FROM users u JOIN memberships m ON m.user_id = u.id
 WHERE tc.traveler_id IS NULL AND lower(u.email) = lower(tc.created_by) AND m.company_id = tc.company_id;
INSERT INTO trip_travelers (company_id, trip_id, user_id)
  SELECT DISTINCT company_id, trip_id, traveler_id FROM trip_costs WHERE traveler_id IS NOT NULL
  UNION SELECT DISTINCT company_id, trip_id, user_id FROM time_entries WHERE trip_id IS NOT NULL
ON CONFLICT DO NOTHING;
