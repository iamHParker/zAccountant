-- 042: Time in blocks from the Road page (Homer, 2026-11-06). "I assign travel in blocks": travel out, site time,
-- return travel, travel split with the next job's site visit, and office or drafting time typed on the phone because
-- it is quicker than signing in. Each block is its own road item (kind 'block': date, type travel|site|office,
-- start and end, the project, and for travel a second project to split it with, or a trip). Lunch and breaks are the
-- gaps between blocks. At the desk each block becomes a time entry on its project; a split travel block becomes two,
-- half the minutes each (the odd minute to the first), the first ending where the second starts.
-- time_entry_id is the (first) time entry it became; the audit record lists both for a split.
ALTER TABLE road_items DROP CONSTRAINT road_items_kind_check;
ALTER TABLE road_items ADD CONSTRAINT road_items_kind_check CHECK (kind IN ('trip', 'cost', 'time', 'check', 'booking', 'purchase', 'block'));
