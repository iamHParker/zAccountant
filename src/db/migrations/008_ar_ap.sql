-- 008: Customers & vendors, invoices & bills, payments (accounts receivable / accounts payable).
--
-- Every invoice, bill and payment posts one journal entry; the documents are the detail behind the
-- Accounts Receivable and Accounts Payable balances. Like the ledger, they are never edited or
-- deleted once saved: a mistake is voided (its entry is reversed) and entered again.

ALTER TABLE companies ADD COLUMN next_invoice_number integer NOT NULL DEFAULT 1001;
-- Invoices credit sales tax to this account (new companies get the key from the default chart).
UPDATE accounts SET system_key = 'sales_tax_payable'
 WHERE code = '2200' AND name = 'Sales Tax Payable' AND system_key IS NULL
   AND NOT EXISTS (SELECT 1 FROM accounts x WHERE x.company_id = accounts.company_id AND x.system_key = 'sales_tax_payable');

CREATE TABLE contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  kind        text NOT NULL CHECK (kind IN ('customer','vendor')),
  name        text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  email       text CHECK (email IS NULL OR length(email) <= 200),
  phone       text CHECK (phone IS NULL OR length(phone) <= 40),
  address     text CHECK (address IS NULL OR length(address) <= 500),
  terms_days  integer NOT NULL DEFAULT 30 CHECK (terms_days BETWEEN 0 AND 365),
  is_1099     boolean NOT NULL DEFAULT false,   -- vendor gets a Form 1099-NEC
  is_active   boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX contacts_name ON contacts (company_id, kind, lower(trim(name)));

-- Invoices (to customers) and bills (from vendors).
CREATE TABLE documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  kind             text NOT NULL CHECK (kind IN ('invoice','bill')),
  contact_id       uuid NOT NULL,
  number           text NOT NULL CHECK (length(trim(number)) BETWEEN 1 AND 40),
  doc_date         date NOT NULL,
  due_date         date NOT NULL CHECK (due_date >= doc_date),
  memo             text CHECK (memo IS NULL OR length(memo) <= 500),
  subtotal_cents   bigint NOT NULL CHECK (subtotal_cents >= 0),
  tax_rate         text,                       -- sales tax percent as typed, e.g. '8.25' (invoices only)
  tax_cents        bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents      bigint NOT NULL CHECK (total_cents > 0 AND total_cents = subtotal_cents + tax_cents AND total_cents <= 100000000000),
  journal_entry_id uuid NOT NULL,
  status           text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  void_date        date,
  void_entry_id    uuid,
  voided_by        text,
  voided_at        timestamptz,
  idempotency_key  text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, void_entry_id) REFERENCES journal_entries(company_id, id),
  CHECK ((status = 'void') = (void_entry_id IS NOT NULL AND void_date IS NOT NULL)),
  CHECK (kind = 'invoice' OR (tax_cents = 0 AND tax_rate IS NULL))
);
-- Invoice numbers are unique; a vendor's bill number can't be entered twice (catches paying a bill twice).
CREATE UNIQUE INDEX documents_invoice_number ON documents (company_id, lower(number)) WHERE kind = 'invoice';
CREATE UNIQUE INDEX documents_bill_number ON documents (company_id, contact_id, lower(number)) WHERE kind = 'bill' AND status = 'posted';
CREATE UNIQUE INDEX documents_idem ON documents (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX documents_contact ON documents (company_id, kind, contact_id, doc_date);

CREATE TABLE document_lines (
  id               bigserial PRIMARY KEY,
  company_id       uuid NOT NULL,
  document_id      uuid NOT NULL,
  account_id       uuid NOT NULL,              -- income account (invoice) or expense/asset account (bill)
  description      text CHECK (description IS NULL OR length(description) <= 300),
  quantity         text NOT NULL DEFAULT '1',  -- as typed, up to 4 decimals
  unit_price_cents bigint NOT NULL,
  amount_cents     bigint NOT NULL CHECK (amount_cents >= 0),
  taxable          boolean NOT NULL DEFAULT false,
  FOREIGN KEY (company_id, document_id) REFERENCES documents(company_id, id),
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id)
);

-- Money received from customers / paid to vendors, and which invoices or bills it pays.
CREATE TABLE payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  kind             text NOT NULL CHECK (kind IN ('received','made')),
  contact_id       uuid NOT NULL,
  pay_date         date NOT NULL,
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000000),
  account_id       uuid NOT NULL,              -- bank, cash or credit card account the money moved through
  method           text CHECK (method IS NULL OR method IN ('check','ach','card','cash','wire','other')),
  reference        text CHECK (reference IS NULL OR length(reference) <= 60),   -- check number etc.
  memo             text CHECK (memo IS NULL OR length(memo) <= 500),
  journal_entry_id uuid NOT NULL,
  status           text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  void_date        date,
  void_entry_id    uuid,
  voided_by        text,
  voided_at        timestamptz,
  idempotency_key  text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id),
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, void_entry_id) REFERENCES journal_entries(company_id, id),
  CHECK ((status = 'void') = (void_entry_id IS NOT NULL AND void_date IS NOT NULL))
);
CREATE UNIQUE INDEX payments_idem ON payments (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE payment_applications (
  company_id   uuid NOT NULL,
  payment_id   uuid NOT NULL,
  document_id  uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  PRIMARY KEY (payment_id, document_id),
  FOREIGN KEY (company_id, payment_id) REFERENCES payments(company_id, id),
  FOREIGN KEY (company_id, document_id) REFERENCES documents(company_id, id)
);
CREATE INDEX payment_applications_doc ON payment_applications (document_id);

-- Database backstop: a document can never be paid more than its total, and a voided document
-- can't receive payments (the application code checks the same thing first, with a clear message).
CREATE FUNCTION zacc_no_overpay() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc documents%ROWTYPE; paid bigint;
BEGIN
  SELECT * INTO doc FROM documents WHERE id = NEW.document_id;
  IF doc.status <> 'posted' THEN
    RAISE EXCEPTION 'cannot pay a voided % ', doc.kind USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(a.amount_cents), 0) INTO paid FROM payment_applications a JOIN payments p ON p.id = a.payment_id
   WHERE a.document_id = NEW.document_id AND p.status = 'posted';
  IF paid + NEW.amount_cents > doc.total_cents THEN
    RAISE EXCEPTION 'payment is more than the % balance', doc.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_applications_no_overpay BEFORE INSERT ON payment_applications FOR EACH ROW EXECUTE FUNCTION zacc_no_overpay();

-- Saved amounts never change; only the void fields may be set, once.
CREATE FUNCTION zacc_doc_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'already voided' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_final BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION zacc_doc_final();
CREATE TRIGGER payments_final BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION zacc_doc_final();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts','documents','document_lines','payments','payment_applications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company())', t || '_company', t);
  END LOOP;
END $$;
