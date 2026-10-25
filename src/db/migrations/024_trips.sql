-- 024: Trips (Homer, 2026-10-25). A trip holds what one trip cost (airfare, rental car, lodging, tolls that show up
-- weeks later…) and the travel time, and the projects it served, each with its share of the trip in percent
-- (a major client may carry most of it; a few smaller ones a little; shares may add up to less than 100%, and the
-- rest is not billed). Each project's invoice pulls in its share of every cost and travel hour; the invoice line
-- quantity is the share (60% → 0.6 × the cost), and a quantity typed on the invoice overrides it.
--   * A trip cost posts its own journal entry (Dr the expense account, Cr the bank, credit card or owner account it
--     was paid from). Like every saved record it is never changed in place: Edit voids it and posts a corrected copy
--     (replaced_by_id); its receipt photos move to the copy.
--   * Travel time is a time entry with trip_id instead of a job.
--   * Billed once per project: an invoice line for a trip cost or trip travel time names the project (job_id), and
--     no two posted invoices bill the same cost or hour for the same project.
CREATE TABLE trips (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  start_date  date NOT NULL,
  end_date    date CHECK (end_date IS NULL OR end_date >= start_date),
  notes       text CHECK (notes IS NULL OR length(notes) <= 500),
  is_active   boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);
CREATE INDEX trips_date ON trips (company_id, start_date DESC);

-- A project's share of a trip, in hundredths of a percent (6000 = 60.00%).
CREATE TABLE trip_jobs (
  company_id  uuid NOT NULL,
  trip_id     uuid NOT NULL,
  job_id      uuid NOT NULL,
  share_bp    integer NOT NULL CHECK (share_bp BETWEEN 0 AND 10000),
  PRIMARY KEY (trip_id, job_id),
  FOREIGN KEY (company_id, trip_id) REFERENCES trips(company_id, id),
  FOREIGN KEY (company_id, job_id) REFERENCES jobs(company_id, id)
);

CREATE TABLE trip_costs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  trip_id              uuid NOT NULL,
  cost_date            date NOT NULL,
  vendor               text CHECK (vendor IS NULL OR length(vendor) <= 120),
  description          text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 300),
  -- What it was (quick picks on the form). Mileage is miles × a rate per mile the user types (the IRS standard
  -- mileage rate, or their own); amount_cents = miles × rate, rounded half-up once.
  kind                 text NOT NULL DEFAULT 'other' CHECK (kind IN ('airfare','rental_car','lodging','meals','tolls','mileage','other')),
  miles                text CHECK (miles IS NULL OR miles ~ '^\d{1,6}(\.\d{1,2})?$'),
  mile_rate_cents      text CHECK (mile_rate_cents IS NULL OR mile_rate_cents ~ '^\d{1,4}(\.\d{1,2})?$'),
  amount_cents         bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000000),
  expense_account_id   uuid NOT NULL,
  paid_from_account_id uuid NOT NULL,
  journal_entry_id     uuid NOT NULL,
  status               text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  void_date            date,
  void_entry_id        uuid,
  voided_by            text,
  voided_at            timestamptz,
  replaced_by_id       uuid,
  idempotency_key      text,
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, trip_id) REFERENCES trips(company_id, id),
  FOREIGN KEY (company_id, expense_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, paid_from_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, void_entry_id) REFERENCES journal_entries(company_id, id),
  CHECK ((status = 'void') = (void_entry_id IS NOT NULL AND void_date IS NOT NULL)),
  CHECK ((kind = 'mileage') = (miles IS NOT NULL AND mile_rate_cents IS NOT NULL))
);
CREATE INDEX trip_costs_trip ON trip_costs (trip_id);
CREATE UNIQUE INDEX trip_costs_idem ON trip_costs (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Receipt photos, like the check photos on a payment (021). Never logged.
CREATE TABLE trip_cost_photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  trip_cost_id uuid NOT NULL REFERENCES trip_costs(id),
  picture      bytea NOT NULL CHECK (octet_length(picture) <= 3145728),
  picture_type text NOT NULL CHECK (picture_type IN ('image/png', 'image/jpeg')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text
);
CREATE INDEX trip_cost_photos_cost ON trip_cost_photos (trip_cost_id);

ALTER TABLE time_entries ADD COLUMN trip_id uuid;
ALTER TABLE time_entries ADD FOREIGN KEY (company_id, trip_id) REFERENCES trips(company_id, id);
ALTER TABLE time_entries ADD CHECK (trip_id IS NULL OR job_id IS NULL);

ALTER TABLE document_lines ADD COLUMN trip_cost_id uuid;
ALTER TABLE document_lines ADD FOREIGN KEY (company_id, trip_cost_id) REFERENCES trip_costs(company_id, id);
ALTER TABLE document_lines ADD CHECK (num_nonnulls(time_entry_id, billed_line_id, trip_cost_id) <= 1);
CREATE INDEX document_lines_trip_cost ON document_lines (trip_cost_id) WHERE trip_cost_id IS NOT NULL;

ALTER TABLE trips ENABLE ROW LEVEL SECURITY;
CREATE POLICY trips_company ON trips USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());
ALTER TABLE trip_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_jobs_company ON trip_jobs USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());
ALTER TABLE trip_costs ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_costs_company ON trip_costs USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());
ALTER TABLE trip_cost_photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_cost_photos_company ON trip_cost_photos
  USING (company_id = zacc_current_company()) WITH CHECK (company_id = zacc_current_company());

-- Billed once (023), now also per project for a trip's costs and travel time.
CREATE OR REPLACE FUNCTION zacc_bill_once() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE src text; trip uuid;
BEGIN
  IF NEW.time_entry_id IS NULL AND NEW.billed_line_id IS NULL AND NEW.trip_cost_id IS NULL THEN RETURN NEW; END IF;
  IF (SELECT kind FROM documents WHERE id = NEW.document_id) <> 'invoice' THEN
    RAISE EXCEPTION 'only an invoice can bill time or costs' USING ERRCODE = '23514';
  END IF;
  IF NEW.time_entry_id IS NOT NULL THEN
    SELECT trip_id INTO trip FROM time_entries WHERE id = NEW.time_entry_id AND billable AND status <> 'rejected';
    IF NOT FOUND THEN RAISE EXCEPTION 'that time is not billable' USING ERRCODE = '23514'; END IF;
    src := 'time:' || NEW.time_entry_id;
  ELSIF NEW.trip_cost_id IS NOT NULL THEN
    SELECT trip_id INTO trip FROM trip_costs WHERE id = NEW.trip_cost_id AND status = 'posted';
    IF NOT FOUND THEN RAISE EXCEPTION 'that trip cost is void' USING ERRCODE = '23514'; END IF;
    src := 'trip:' || NEW.trip_cost_id;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM document_lines l JOIN documents d ON d.id = l.document_id
                    WHERE l.id = NEW.billed_line_id AND l.billable AND d.kind = 'bill' AND d.status = 'posted') THEN
      RAISE EXCEPTION 'that cost is not billable' USING ERRCODE = '23514';
    END IF;
    src := 'cost:' || NEW.billed_line_id;
  END IF;
  -- A trip's cost or travel hour is billed to one of the trip's projects; anything else names no project.
  IF trip IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM trip_jobs WHERE trip_id = trip AND job_id = NEW.job_id) THEN
      RAISE EXCEPTION 'that project is not on the trip' USING ERRCODE = '23514';
    END IF;
    src := src || ':' || NEW.job_id;
  ELSIF NEW.job_id IS NOT NULL THEN
    RAISE EXCEPTION 'only a trip is billed per project' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(src));
  IF EXISTS (SELECT 1 FROM document_lines l JOIN documents d ON d.id = l.document_id
              WHERE d.status = 'posted' AND l.document_id <> NEW.document_id AND l.job_id IS NOT DISTINCT FROM NEW.job_id
                AND (l.time_entry_id = NEW.time_entry_id OR l.billed_line_id = NEW.billed_line_id OR l.trip_cost_id = NEW.trip_cost_id)) THEN
    RAISE EXCEPTION 'that time or cost is already billed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zacc_time_billed_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM document_lines l JOIN documents d ON d.id = l.document_id
              WHERE l.time_entry_id = OLD.id AND d.status = 'posted')
     AND (TG_OP = 'DELETE' OR NEW.work_date IS DISTINCT FROM OLD.work_date OR NEW.minutes IS DISTINCT FROM OLD.minutes
          OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.trip_id IS DISTINCT FROM OLD.trip_id OR NEW.billable IS DISTINCT FROM OLD.billable
          OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.status = 'rejected') THEN
    RAISE EXCEPTION 'billed time entries cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

-- A trip cost on an invoice that stands can't be voided (or edited).
CREATE FUNCTION zacc_trip_cost_billed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' AND NEW.status = 'void' AND EXISTS (
       SELECT 1 FROM document_lines l JOIN documents d ON d.id = l.document_id WHERE l.trip_cost_id = OLD.id AND d.status = 'posted') THEN
    RAISE EXCEPTION 'this trip cost is billed to a client' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trip_costs_billed BEFORE UPDATE ON trip_costs FOR EACH ROW EXECUTE FUNCTION zacc_trip_cost_billed();
