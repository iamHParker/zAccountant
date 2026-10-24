-- 016: Invoices for professional services (Homer's queue, 2026-10-24).
--   * a company's usual sales tax rate, filled in on each new invoice;
--   * the company logo, printed on invoices;
--   * saved rates and items (Eng Std Rate, Drafting, Equipment rental, Lodging…) that fill an invoice line;
--   * a date on each invoice line (the day the work was done or the cost was incurred);
--   * the invoice letterhead: the company's address, a note under it (tax ID, engineering firm number) and a
--     closing line ("Thank you for…"), and on each invoice the project it is for (name and site address).

ALTER TABLE companies ADD COLUMN default_sales_tax_rate text
  CHECK (default_sales_tax_rate IS NULL OR default_sales_tax_rate ~ '^\d{1,2}(\.\d{1,4})?$');
ALTER TABLE companies ADD COLUMN invoice_address text CHECK (invoice_address IS NULL OR length(invoice_address) <= 300);
ALTER TABLE companies ADD COLUMN invoice_note text CHECK (invoice_note IS NULL OR length(invoice_note) <= 300);
ALTER TABLE companies ADD COLUMN invoice_footer text CHECK (invoice_footer IS NULL OR length(invoice_footer) <= 300);
ALTER TABLE documents ADD COLUMN project text CHECK (project IS NULL OR length(project) <= 300);

-- One logo per company. ℹ️ Kept out of the companies table so the picture's bytes don't travel with every
-- request that reads the company.
CREATE TABLE company_logos (
  company_id   uuid PRIMARY KEY REFERENCES companies(id),
  picture      bytea NOT NULL CHECK (octet_length(picture) <= 1048576),
  picture_type text NOT NULL CHECK (picture_type IN ('image/png', 'image/jpeg')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);

-- Saved rates and items. kind 'service' is billed by the hour (quantity = hours, price = hourly rate);
-- kind 'expense' is a cost passed on to the client (equipment rental, lodging, airfare…), usually quantity 1.
-- rate_cents NULL means "type the price on the invoice" (a motel bill is different every time).
CREATE TABLE invoice_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  kind        text NOT NULL CHECK (kind IN ('service', 'expense')),
  rate_cents  bigint CHECK (rate_cents IS NULL OR rate_cents BETWEEN 0 AND 100000000),
  taxable     boolean NOT NULL DEFAULT false,
  account_id  uuid NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id)
);
CREATE UNIQUE INDEX invoice_items_name ON invoice_items (company_id, lower(trim(name)));

ALTER TABLE document_lines ADD COLUMN service_date date;
ALTER TABLE document_lines ADD COLUMN item_id uuid;
ALTER TABLE document_lines ADD FOREIGN KEY (company_id, item_id) REFERENCES invoice_items(company_id, id);

ALTER TABLE company_logos ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_logos_company ON company_logos
  USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());
ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_items_company ON invoice_items
  USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());
