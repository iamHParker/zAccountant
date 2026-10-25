-- 028: MileIQ import (Homer, 2026-10-25). MileIQ's monthly report (CSV) lists every drive; Trips → Import from MileIQ
-- reads it and posts the business drives as mileage on trips. Each drive's details stay here (the drive log behind
-- each mileage cost), and its fingerprint keeps a drive from being imported twice.
--   * One mileage cost per trip per day, not one per drive. Its amount is MileIQ's own: each drive's miles × rate
--     rounded to the cent, then added up, so the books tie out to MileIQ's report to the penny. A month of 115 drives
--     makes about 25 costs instead of 115 journal entries. Tolls and parking from the file become their own costs.
--   * A drive counts as imported while its cost is posted, or was edited (void + corrected copy). If the cost is
--     voided outright, the drive can be imported again.
CREATE TABLE mileage_drives (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  drive_key     text NOT NULL CHECK (drive_key ~ '^[0-9a-f]{32}$'),
  source        text NOT NULL DEFAULT 'mileiq' CHECK (source IN ('mileiq')),
  drive_date    date NOT NULL,
  start_time    text CHECK (start_time IS NULL OR start_time ~ '^\d{2}:\d{2}$'),
  end_time      text CHECK (end_time IS NULL OR end_time ~ '^\d{2}:\d{2}$'),
  from_place    text CHECK (from_place IS NULL OR length(from_place) <= 200),
  to_place      text CHECK (to_place IS NULL OR length(to_place) <= 200),
  miles         text NOT NULL CHECK (miles ~ '^\d{1,6}(\.\d{1,2})?$'),
  mile_rate     text NOT NULL CHECK (mile_rate ~ '^\d{0,2}(\.\d{1,4})?$'),   -- dollars per mile, as in the file ("0.76")
  parking_cents bigint NOT NULL DEFAULT 0 CHECK (parking_cents >= 0),
  tolls_cents   bigint NOT NULL DEFAULT 0 CHECK (tolls_cents >= 0),
  vehicle       text CHECK (vehicle IS NULL OR length(vehicle) <= 80),
  purpose       text CHECK (purpose IS NULL OR length(purpose) <= 80),
  notes         text CHECK (notes IS NULL OR length(notes) <= 300),
  trip_id       uuid NOT NULL,
  trip_cost_id  uuid NOT NULL,        -- the mileage cost this drive is part of
  imported_by   text,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, trip_id) REFERENCES trips(company_id, id),
  FOREIGN KEY (company_id, trip_cost_id) REFERENCES trip_costs(company_id, id)
);
CREATE INDEX mileage_drives_key ON mileage_drives (company_id, drive_key);
CREATE INDEX mileage_drives_cost ON mileage_drives (trip_cost_id);

ALTER TABLE mileage_drives ENABLE ROW LEVEL SECURITY;
CREATE POLICY mileage_drives_company ON mileage_drives USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());
