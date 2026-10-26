-- 035: PDFs kept with a payment (Homer, 2026-10-26): the bank's deposit confirmation, a remittance emailed as a PDF.
-- They sit beside the check photos in payment_photos (same 3 MB limit, same company-only access, never logged).
ALTER TABLE payment_photos DROP CONSTRAINT payment_photos_picture_type_check;
ALTER TABLE payment_photos ADD CONSTRAINT payment_photos_picture_type_check CHECK (picture_type IN ('image/png', 'image/jpeg', 'application/pdf'));
