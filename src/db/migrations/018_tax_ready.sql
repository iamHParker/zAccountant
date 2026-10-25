-- 018: Tax-ready, level 1 (Homer, 2026-10-24). Each income or expense account can be given a tax category
-- (src/core/taxLines.js), which places it on a line of the company's federal return. No row = the
-- suggested category is used and shown as "suggested".
CREATE TABLE account_tax_categories (
  company_id  uuid NOT NULL REFERENCES companies(id),
  account_id  uuid NOT NULL,
  category    text NOT NULL CHECK (category ~ '^[a-z_]{2,40}$'),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  PRIMARY KEY (company_id, account_id),
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id)
);
ALTER TABLE account_tax_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_tax_categories_company ON account_tax_categories
  USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());
