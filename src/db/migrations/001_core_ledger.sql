-- 001: Core ledger.
-- The database itself enforces the accounting rules (defense in depth): even if application
-- code has a bug, PostgreSQL will refuse an unbalanced entry, any edit/delete of posted
-- history, or a posting into a locked period.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE companies (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL CHECK (length(trim(name)) > 0),
  home_state             char(2) NOT NULL CHECK (home_state IN ('TX','CO','CA','DC')),
  fiscal_year_start_month smallint NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  locked_through         date,               -- books closed through this date (inclusive)
  calculate_only_payroll boolean NOT NULL DEFAULT true,
  sui_rate_pct           text,               -- assigned state unemployment rate, e.g. '2.7'
  next_entry_number      integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  code        text NOT NULL,
  name        text NOT NULL,
  type        text NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  subtype     text,
  cash_flow   text CHECK (cash_flow IN ('cash','operating','investing','financing')),
  system_key  text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, system_key),
  UNIQUE (company_id, id),
  CHECK ((type IN ('asset','liability','equity')) = (cash_flow IS NOT NULL))
);

CREATE TABLE journal_entries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id),
  entry_number       integer NOT NULL,
  entry_date         date NOT NULL,
  memo               text,
  source             text NOT NULL DEFAULT 'manual',  -- manual | simple | payroll | import | reversal | bank
  source_ref         text,
  reverses_entry_id  uuid REFERENCES journal_entries(id),
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, entry_number),
  UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX journal_entries_one_reversal ON journal_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX journal_entries_company_date ON journal_entries (company_id, entry_date);

CREATE TABLE journal_lines (
  id            bigserial PRIMARY KEY,
  entry_id      uuid NOT NULL,
  company_id    uuid NOT NULL,
  account_id    uuid NOT NULL,
  entry_date    date NOT NULL,
  debit_cents   bigint NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents  bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  memo          text,
  CHECK ((debit_cents > 0) <> (credit_cents > 0)),
  FOREIGN KEY (company_id, entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id)   -- line must use its own company's account
);
CREATE INDEX journal_lines_ledger ON journal_lines (company_id, account_id, entry_date);
CREATE INDEX journal_lines_entry ON journal_lines (entry_id);

-- Every entry must balance, checked at COMMIT (deferred) so lines can be inserted one by one.
CREATE FUNCTION zacc_check_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; c bigint; n int;
BEGIN
  SELECT coalesce(sum(debit_cents),0), coalesce(sum(credit_cents),0), count(*)
    INTO d, c, n FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'Unbalanced journal entry %: debits % <> credits % (% lines)', NEW.entry_id, d, c, n
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zacc_check_entry_balanced();

-- Entries must have lines; checked at commit too.
CREATE FUNCTION zacc_check_entry_has_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_lines WHERE entry_id = NEW.id) THEN
    RAISE EXCEPTION 'Journal entry % has no lines', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_entries_have_lines AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zacc_check_entry_has_lines();

-- Line date must equal its entry's date (denormalized for fast ledgers).
CREATE FUNCTION zacc_line_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT entry_date INTO NEW.entry_date FROM journal_entries WHERE id = NEW.entry_id;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_lines_date BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION zacc_line_date();

-- Posted history is immutable. Corrections are made with reversing entries.
CREATE FUNCTION zacc_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; post a reversing entry instead', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION zacc_immutable();
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION zacc_immutable();
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries EXECUTE FUNCTION zacc_immutable();
CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON journal_lines EXECUTE FUNCTION zacc_immutable();

-- No posting into a closed period.
CREATE FUNCTION zacc_period_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked date;
BEGIN
  SELECT locked_through INTO locked FROM companies WHERE id = NEW.company_id;
  IF locked IS NOT NULL AND NEW.entry_date <= locked THEN
    RAISE EXCEPTION 'Books are closed through %; cannot post an entry dated %', locked, NEW.entry_date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_period_open BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION zacc_period_open();

-- Tamper-evident audit trail: each row stores SHA-256(prev_hash || payload); see services/audit.js.
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies(id),
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  actor       text,
  payload     jsonb NOT NULL,
  prev_hash   text NOT NULL,
  hash        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_company ON audit_log (company_id, id);
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION zacc_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log EXECUTE FUNCTION zacc_immutable();
