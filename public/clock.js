// Travel time from the clock (Homer, 2026-10-26): start, end and breaks instead of adding up the hours by hand.
// The server works the hours out again from the same three numbers (src/core/timesheets.js); this copy only shows
// them while typing. One entry per day: a three-day trip is three entries, each with its own breaks.

/** "0:45", "1:30", "0.75", "45m", "1h 15m" -> minutes, or null. Same rules as the server's parseDuration. */
export function durationMinutes(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  let r;
  if ((r = /^(\d{1,3}):([0-5]\d)$/.exec(s))) return Number(r[1]) * 60 + Number(r[2]);
  if ((r = /^(?:(\d{1,3})\s*h(?:ours?|rs?)?)?\s*(?:(\d{1,4})\s*m(?:in(?:utes?|s)?)?)?$/.exec(s)) && (r[1] || r[2])) return Number(r[1] ?? 0) * 60 + Number(r[2] ?? 0);
  if ((r = /^(\d{1,3}(?:\.\d+)?|\.\d+)\s*(?:h|hr|hrs|hours?)?$/.exec(s))) return Math.round(Number(r[1]) * 60);
  return null;
}

export const hhmm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

/** Start and end from <input type="time"> ("07:30", "17:45"); past midnight counts as the next morning. */
export function clockTime(start, end, breaks) {
  if (!start || !end) return null;
  const at = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  let span = at(end) - at(start); if (span <= 0) span += 1440;
  const off = String(breaks ?? '').trim() ? durationMinutes(breaks) : 0;
  if (off == null) return { error: 'Type the breaks like 0:45 (45 minutes) or 1:30.' };
  const minutes = span - off;
  if (minutes <= 0) return { error: 'The breaks are as long as the whole day.' };
  return { minutes, hours: hhmm(minutes), text: `${hhmm(span)} from ${start} to ${end}${off ? `, less ${hhmm(off)} of breaks` : ''} = ${hhmm(minutes)} h` };
}

/** The day after an ISO date (for "Save, then next day"). */
export function nextDay(iso) {
  const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
