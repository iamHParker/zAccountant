-- 022: Divisions, adjusters and claim numbers (Homer, 2026-10-25). A customer with several divisions is
-- entered once per division ("DWH - SATX", "DWH - AUS"); group_name ("Part of": DWH) lets reports total them.
-- Each customer keeps a short list of people (claims adjusters: name, email, phone) in people (a JSON array,
-- checked by the server). An invoice records who it is for (attention), the address it is sent to (send_to)
-- and the client's claim or job number (client_ref); like the rest of an invoice these are set once, when
-- it is saved, and an edit makes a corrected copy.
ALTER TABLE contacts ADD COLUMN group_name text CHECK (group_name IS NULL OR length(group_name) <= 120);
ALTER TABLE contacts ADD COLUMN people jsonb NOT NULL DEFAULT '[]'
  CHECK (jsonb_typeof(people) = 'array' AND jsonb_array_length(people) <= 50);
ALTER TABLE documents ADD COLUMN attention text CHECK (attention IS NULL OR length(attention) <= 120);
ALTER TABLE documents ADD COLUMN send_to text CHECK (send_to IS NULL OR length(send_to) <= 200);
ALTER TABLE documents ADD COLUMN client_ref text CHECK (client_ref IS NULL OR length(client_ref) <= 60);
