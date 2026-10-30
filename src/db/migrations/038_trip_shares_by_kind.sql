-- 038: A project's share of a trip can differ by kind of cost (Homer, 2026-10-30: one client pays all of the airfare
-- and meals, two clients split the hotel and rental car). Hundredths of a percent like share_bp; NULL = the trip share
-- (share_bp), which travel time always uses. air = airfare, hotel = lodging, car = rental car, rest = everything else
-- (meals, tolls, mileage, other). The invoice's "Pull in unbilled time and costs" bills each cost at its kind's share.
ALTER TABLE trip_jobs ADD COLUMN air_bp integer CHECK (air_bp BETWEEN 0 AND 10000);
ALTER TABLE trip_jobs ADD COLUMN hotel_bp integer CHECK (hotel_bp BETWEEN 0 AND 10000);
ALTER TABLE trip_jobs ADD COLUMN car_bp integer CHECK (car_bp BETWEEN 0 AND 10000);
ALTER TABLE trip_jobs ADD COLUMN rest_bp integer CHECK (rest_bp BETWEEN 0 AND 10000);
