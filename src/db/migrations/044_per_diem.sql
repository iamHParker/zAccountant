-- Per diem (Homer, 2026-11-23: "I can't add a per diem for food"). A per diem is a flat amount per day for meals
-- (the GSA rate, or the firm's own), billed to the client as days × the daily rate, with no receipts.
--   * Saved invoice rates get a third kind, 'per_day': quantity = days, price = the daily rate. Like a cost passed on,
--     it is not taxed unless the firm ticks "Charge sales tax on it".
--   * A trip cost can be kind 'per_diem': days × daily rate, worked like mileage (miles × rate per mile). days may be
--     a part day such as 2.75 (GSA pays 75% on the first and last travel day); amount_cents = days × rate, rounded
--     half-up once. It posts its own entry like every trip cost, and each project's invoice pulls in its share.
ALTER TABLE invoice_items DROP CONSTRAINT invoice_items_kind_check;
ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_kind_check CHECK (kind IN ('service', 'expense', 'per_day'));

ALTER TABLE trip_costs DROP CONSTRAINT trip_costs_kind_check;
ALTER TABLE trip_costs ADD CONSTRAINT trip_costs_kind_check
  CHECK (kind IN ('airfare','rental_car','lodging','meals','per_diem','tolls','mileage','other'));
ALTER TABLE trip_costs ADD COLUMN days text CHECK (days IS NULL OR days ~ '^\d{1,3}(\.\d{1,2})?$');
ALTER TABLE trip_costs ADD COLUMN day_rate_cents bigint CHECK (day_rate_cents IS NULL OR day_rate_cents BETWEEN 1 AND 10000000);
ALTER TABLE trip_costs ADD CONSTRAINT trip_costs_per_diem_shape
  CHECK ((kind = 'per_diem') = (days IS NOT NULL AND day_rate_cents IS NOT NULL));
