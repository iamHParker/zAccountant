-- 029: Home page cards (Homer, 2026-10-25): shortcut cards next to "Record a transaction" and a Statistics card,
-- each person adding, removing and moving their own. One row per person per company, so the arrangement follows
-- them from the desk to the phone. layout = { "left": [card ids], "right": [card ids] }; the card catalog lives in
-- the browser (public/app.js HOME_CARDS), which skips an id it doesn't know.
CREATE TABLE home_layouts (
  company_id  uuid NOT NULL REFERENCES companies(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  layout      jsonb NOT NULL CHECK (octet_length(layout::text) <= 2000),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);
ALTER TABLE home_layouts ENABLE ROW LEVEL SECURITY;
-- Only your own arrangement, in the company you're working in.
CREATE POLICY home_layouts_own ON home_layouts
  USING (company_id = zacc_current_company() AND user_id = zacc_current_user())
  WITH CHECK (company_id = zacc_current_company() AND user_id = zacc_current_user());
