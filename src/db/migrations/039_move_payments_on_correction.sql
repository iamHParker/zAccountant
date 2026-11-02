-- 039: Correcting an invoice or bill that already has payments (Homer, 2026-11-02). Edit still voids the old copy
-- and posts the corrected one; the payments applied to the old copy now move to the corrected copy instead of
-- having to be voided first. The payment itself (its bank entry, reconciliation, photos) is never changed: only
-- payment_applications.document_id, and only along a void → corrected-copy link. This trigger is the database's
-- backstop for that rule; the app checks the same things first with plain messages.
CREATE FUNCTION zacc_application_move() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE src documents%ROWTYPE; dst documents%ROWTYPE; paid bigint;
BEGIN
  IF NEW.payment_id <> OLD.payment_id OR NEW.amount_cents <> OLD.amount_cents OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'a payment application can only move to a corrected copy' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.document_id = OLD.document_id THEN RETURN NEW; END IF;
  SELECT * INTO src FROM documents WHERE id = OLD.document_id;
  SELECT * INTO dst FROM documents WHERE id = NEW.document_id;
  IF src.status <> 'void' OR src.replaced_by_id IS DISTINCT FROM dst.id OR dst.status <> 'posted'
     OR dst.contact_id <> src.contact_id OR dst.kind <> src.kind THEN
    RAISE EXCEPTION 'a payment can only move from a voided % to its corrected copy', src.kind USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT COALESCE(sum(a.amount_cents), 0) INTO paid FROM payment_applications a JOIN payments p ON p.id = a.payment_id
   WHERE a.document_id = NEW.document_id AND p.status = 'posted';
  IF paid + NEW.amount_cents > dst.total_cents THEN
    RAISE EXCEPTION 'payment is more than the % balance', dst.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_applications_move BEFORE UPDATE ON payment_applications FOR EACH ROW EXECUTE FUNCTION zacc_application_move();
