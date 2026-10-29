-- 037: Late charges (Homer, 2026-10-29): interest on past-due invoices at an APR he sets (6% for now) plus a flat
-- fee for each late statement ($35). Off until an APR or a fee is set. An invoice is charged only after a grace
-- period from its due date: late_grace_days (30), or late_holiday_grace_days (60) for a homeowner's invoice due in
-- November or December. Never charged: invoices on a payment plan, invoices or customers marked no_late_charges,
-- and the late-charge invoices themselves (no interest on interest). Each run posts one ordinary invoice per
-- customer, marked late_charge_month 'YYYY-MM', and a customer is charged at most once a month (the unique index).
ALTER TABLE companies ADD COLUMN late_apr text CHECK (late_apr IS NULL OR late_apr ~ '^[0-9]{1,2}(\.[0-9]{1,4})?$');
ALTER TABLE companies ADD COLUMN late_fee_cents integer CHECK (late_fee_cents IS NULL OR late_fee_cents BETWEEN 0 AND 100000);
ALTER TABLE companies ADD COLUMN late_grace_days smallint NOT NULL DEFAULT 30 CHECK (late_grace_days BETWEEN 0 AND 365);
ALTER TABLE companies ADD COLUMN late_holiday_grace_days smallint NOT NULL DEFAULT 60 CHECK (late_holiday_grace_days BETWEEN 0 AND 365);

ALTER TABLE contacts ADD COLUMN is_homeowner boolean NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN no_late_charges boolean NOT NULL DEFAULT false;

ALTER TABLE documents ADD COLUMN no_late_charges boolean NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN late_charge_month text CHECK (late_charge_month IS NULL OR late_charge_month ~ '^[0-9]{4}-[0-9]{2}$');
ALTER TABLE documents ADD CONSTRAINT documents_late_charge_kind CHECK (late_charge_month IS NULL OR kind = 'invoice');
CREATE UNIQUE INDEX documents_late_charge_once ON documents (company_id, contact_id, late_charge_month)
  WHERE late_charge_month IS NOT NULL AND status = 'posted';
