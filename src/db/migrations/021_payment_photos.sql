-- 021: Photos on a payment (Homer, 2026-10-25): the check and the printed remittance that names the invoice,
-- usually taken with an iPhone. A photo is a record kept with the payment, not a deposit. It shows the payer's
-- bank account and routing numbers, so it is only ever served to members of the company, and never logged.
-- When a payment is edited (void + corrected copy), its photos are copied to the corrected payment.
CREATE TABLE payment_photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  payment_id   uuid NOT NULL REFERENCES payments(id),
  picture      bytea NOT NULL CHECK (octet_length(picture) <= 3145728),
  picture_type text NOT NULL CHECK (picture_type IN ('image/png', 'image/jpeg')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text
);
CREATE INDEX payment_photos_payment ON payment_photos (payment_id);
ALTER TABLE payment_photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_photos_company ON payment_photos
  USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());
