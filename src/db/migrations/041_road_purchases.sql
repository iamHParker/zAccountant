-- 041: Equipment and supplies bought on the road (Homer, 2026-11-06). Not every purchase is on a trip: a laser level
-- from the hardware store, printer paper, survey stakes. The phone's Road page has two buttons for them, Equipment and
-- Supplies, because they belong in different places in the books:
--   * equipment is something that lasts (a tool, a computer): usually a fixed asset (1500 Equipment), depreciated;
--   * supplies are used up (paper, stakes, ink): an expense (6200 Office Supplies).
-- Equipment is also the company's equipment list (Bills → Bought on the road → Equipment list).
-- The desk chooses the account when it accepts the item (it starts on the usual one for the kind) and what paid for it.
-- A purchase is a saved accounting record like a trip cost: it posts its own journal entry, and a change is a void
-- (reversing entry) and, if needed, a new one. Its receipt photos come along from the phone.
CREATE TABLE purchases (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  purchase_date        date NOT NULL,
  category             text NOT NULL CHECK (category IN ('equipment', 'supplies')),
  vendor               text CHECK (vendor IS NULL OR length(vendor) <= 120),
  description          text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 300),
  -- Equipment is tracked as inventory (Homer: "equipment especially over $500 we need for inventory tracking"):
  -- the serial or model number, so a stolen or lent-out tool can be named. Supplies have none.
  serial_number        text CHECK (serial_number IS NULL OR (category = 'equipment' AND length(serial_number) <= 60)),
  amount_cents         bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000000),
  account_id           uuid NOT NULL,          -- debited: Equipment (asset) or Office Supplies (expense), as chosen
  paid_from_account_id uuid NOT NULL,          -- credited: the bank, the card, or paid personally
  job_id               uuid,                   -- the project it was for, if any (a note for now; not billed)
  journal_entry_id     uuid NOT NULL,
  status               text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  void_date            date,
  void_entry_id        uuid,
  voided_by            text,
  voided_at            timestamptz,
  idempotency_key      text,
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, idempotency_key),
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, paid_from_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, job_id) REFERENCES jobs(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, void_entry_id) REFERENCES journal_entries(company_id, id)
);
CREATE INDEX purchases_date ON purchases (company_id, purchase_date DESC);

CREATE TABLE purchase_photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  purchase_id  uuid NOT NULL REFERENCES purchases(id),
  picture      bytea NOT NULL CHECK (octet_length(picture) <= 3145728),
  picture_type text NOT NULL CHECK (picture_type IN ('image/png', 'image/jpeg')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text
);
CREATE INDEX purchase_photos_purchase ON purchase_photos (purchase_id);

ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchases_company ON purchases USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());
ALTER TABLE purchase_photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_photos_company ON purchase_photos USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());

-- From the phone: a road item of kind 'purchase' (data: date, category, amount, vendor, description, project), with
-- photos. purchase_id is the purchase it became at the desk.
ALTER TABLE road_items DROP CONSTRAINT road_items_kind_check;
ALTER TABLE road_items ADD CONSTRAINT road_items_kind_check CHECK (kind IN ('trip', 'cost', 'time', 'check', 'booking', 'purchase'));
ALTER TABLE road_items ADD COLUMN purchase_id uuid;
ALTER TABLE road_items ADD CONSTRAINT road_items_purchase_fk FOREIGN KEY (company_id, purchase_id) REFERENCES purchases(company_id, id);
