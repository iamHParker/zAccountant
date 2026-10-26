-- 033: Checks received on the road (Homer, 2026-10-26). The road is also when deposits get made: the phone sends a
-- "check received" item (who paid, amount, check number, the invoice numbers it pays) with photos of the check and
-- the remittance. At the desk, Sales → "Checks from the road" turns it into the payment on those invoices; the photos
-- are copied to the payment. payment_id is the payment it became.
ALTER TABLE road_items DROP CONSTRAINT road_items_kind_check;
ALTER TABLE road_items ADD CONSTRAINT road_items_kind_check CHECK (kind IN ('trip', 'cost', 'time', 'check'));
ALTER TABLE road_items ADD COLUMN payment_id uuid;
ALTER TABLE road_items ADD CONSTRAINT road_items_payment_fk FOREIGN KEY (company_id, payment_id) REFERENCES payments(company_id, id);
