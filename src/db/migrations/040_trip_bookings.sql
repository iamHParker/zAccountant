-- 040: Bookings on a trip (Homer, 2026-11-06). A trip two weeks out is planned ahead: the flight, the hotel and the
-- rental car are booked now, from the phone's Road page or at the desk. A booking is the reservation (who, the
-- confirmation number, the dates, the price if known); it is not money in the books. Money reaches the books only as a
-- trip cost (024), when it is paid: airfare usually the day it is booked, a hotel or rental car at the end of the
-- stay. trip_cost_id is the cost that paid for it ("Paid: record the cost"); a corrected cost carries the link along.
--
-- A booking is a plan, not a saved accounting record, so it is changed in place (every change goes in the audit
-- chain), and a cancelled booking stays on the trip marked cancelled.
CREATE TABLE trip_bookings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  trip_id       uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('airfare', 'lodging', 'rental_car', 'other')),
  vendor        text CHECK (vendor IS NULL OR length(vendor) <= 120),          -- Southwest, Hilton Garden Inn, Avis
  confirmation  text CHECK (confirmation IS NULL OR length(confirmation) <= 40),
  -- Depart / check in / pick up, and return / check out / drop off. Times are optional (a hotel has none to speak of).
  starts_on     date NOT NULL,
  start_time    time,
  ends_on       date CHECK (ends_on IS NULL OR ends_on >= starts_on),
  end_time      time,
  details       text CHECK (details IS NULL OR length(details) <= 500),       -- flight numbers, address, seat, notes
  amount_cents  bigint CHECK (amount_cents IS NULL OR (amount_cents > 0 AND amount_cents <= 100000000000)),  -- the price quoted
  status        text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled')),
  trip_cost_id  uuid,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, trip_id) REFERENCES trips(company_id, id),
  FOREIGN KEY (company_id, trip_cost_id) REFERENCES trip_costs(company_id, id)
);
CREATE INDEX trip_bookings_trip ON trip_bookings (trip_id, starts_on);

ALTER TABLE trip_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_bookings_company ON trip_bookings USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());

-- A booking sent from the Road page waits in the inbox like everything else from the phone; accepting it puts it on
-- the trip (no accounts to choose: it is not in the books). trip_booking_id is the booking it became.
ALTER TABLE road_items DROP CONSTRAINT road_items_kind_check;
ALTER TABLE road_items ADD CONSTRAINT road_items_kind_check CHECK (kind IN ('trip', 'cost', 'time', 'check', 'booking'));
ALTER TABLE road_items ADD COLUMN trip_booking_id uuid;
ALTER TABLE road_items ADD CONSTRAINT road_items_booking_fk FOREIGN KEY (company_id, trip_booking_id) REFERENCES trip_bookings(company_id, id);
