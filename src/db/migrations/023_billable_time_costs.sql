-- 023: Bill a project's time and costs on an invoice (Homer, 2026-10-25). Projects are the jobs time is entered
-- against (011); a project can carry its site address. A bill line can name the project it was for and be marked
-- "bill to client" (airfare, rental car, lodging…). On the invoice, "Pull in unbilled time and costs" adds one line
-- per time entry or cost, and the invoice line remembers where it came from (time_entry_id or billed_line_id), so the
-- same hours or cost can't be billed twice. Voiding the invoice frees them again; an edit's corrected copy carries
-- the same links. The invoice itself can name its project (job_id).
ALTER TABLE jobs ADD COLUMN address text CHECK (address IS NULL OR length(address) <= 300);

ALTER TABLE documents ADD COLUMN job_id uuid;
ALTER TABLE documents ADD FOREIGN KEY (company_id, job_id) REFERENCES jobs(company_id, id);

ALTER TABLE document_lines ADD COLUMN job_id uuid;
ALTER TABLE document_lines ADD COLUMN billable boolean NOT NULL DEFAULT false;
ALTER TABLE document_lines ADD COLUMN time_entry_id uuid;
ALTER TABLE document_lines ADD COLUMN billed_line_id bigint REFERENCES document_lines(id);
ALTER TABLE document_lines ADD FOREIGN KEY (company_id, job_id) REFERENCES jobs(company_id, id);
ALTER TABLE document_lines ADD FOREIGN KEY (company_id, time_entry_id) REFERENCES time_entries(company_id, id);
ALTER TABLE document_lines ADD CHECK (NOT billable OR job_id IS NOT NULL);
ALTER TABLE document_lines ADD CHECK (time_entry_id IS NULL OR billed_line_id IS NULL);
CREATE INDEX document_lines_time ON document_lines (time_entry_id) WHERE time_entry_id IS NOT NULL;
CREATE INDEX document_lines_billed ON document_lines (billed_line_id) WHERE billed_line_id IS NOT NULL;
CREATE INDEX document_lines_job ON document_lines (company_id, job_id) WHERE job_id IS NOT NULL;

-- Database backstop (the app checks the same things first, with a clear message):
--   * only an invoice line can bill time or a cost, and only time or a cost marked billable;
--   * a time entry or cost is on at most one invoice that is not void.
-- ℹ️ The advisory lock makes two invoices saved at the same moment take turns, so both can't pass the check.
CREATE FUNCTION zacc_bill_once() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE src text;
BEGIN
  IF NEW.time_entry_id IS NULL AND NEW.billed_line_id IS NULL THEN RETURN NEW; END IF;
  IF (SELECT kind FROM documents WHERE id = NEW.document_id) <> 'invoice' THEN
    RAISE EXCEPTION 'only an invoice can bill time or costs' USING ERRCODE = '23514';
  END IF;
  IF NEW.time_entry_id IS NOT NULL THEN
    src := 'time:' || NEW.time_entry_id;
    IF NOT EXISTS (SELECT 1 FROM time_entries WHERE id = NEW.time_entry_id AND billable AND status <> 'rejected') THEN
      RAISE EXCEPTION 'that time is not billable' USING ERRCODE = '23514';
    END IF;
  ELSE
    src := 'cost:' || NEW.billed_line_id;
    IF NOT EXISTS (SELECT 1 FROM document_lines l JOIN documents d ON d.id = l.document_id
                    WHERE l.id = NEW.billed_line_id AND l.billable AND d.kind = 'bill' AND d.status = 'posted') THEN
      RAISE EXCEPTION 'that cost is not billable' USING ERRCODE = '23514';
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(src));
  IF EXISTS (SELECT 1 FROM document_lines l JOIN documents d ON d.id = l.document_id
              WHERE d.status = 'posted' AND l.document_id <> NEW.document_id
                AND (l.time_entry_id = NEW.time_entry_id OR l.billed_line_id = NEW.billed_line_id)) THEN
    RAISE EXCEPTION 'that time or cost is already billed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_lines_bill_once BEFORE INSERT ON document_lines
  FOR EACH ROW EXECUTE FUNCTION zacc_bill_once();

-- Billed hours are what the client was charged: their date, length, project and billable mark can't change
-- (or be deleted) while the invoice stands. Void or edit the invoice first.
CREATE FUNCTION zacc_time_billed_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM document_lines l JOIN documents d ON d.id = l.document_id
              WHERE l.time_entry_id = OLD.id AND d.status = 'posted')
     AND (TG_OP = 'DELETE' OR NEW.work_date IS DISTINCT FROM OLD.work_date OR NEW.minutes IS DISTINCT FROM OLD.minutes
          OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.billable IS DISTINCT FROM OLD.billable
          OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.status = 'rejected') THEN
    RAISE EXCEPTION 'billed time entries cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER time_entries_billed_final BEFORE UPDATE OR DELETE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION zacc_time_billed_final();

-- A bill whose cost was passed on to a client can't be voided (or edited) while that invoice stands.
CREATE FUNCTION zacc_bill_cost_billed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind = 'bill' AND OLD.status = 'posted' AND NEW.status = 'void' AND EXISTS (
       SELECT 1 FROM document_lines src JOIN document_lines l ON l.billed_line_id = src.id JOIN documents d ON d.id = l.document_id
        WHERE src.document_id = OLD.id AND d.status = 'posted') THEN
    RAISE EXCEPTION 'a cost on this bill is billed to a client' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_bill_cost_billed BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION zacc_bill_cost_billed();
