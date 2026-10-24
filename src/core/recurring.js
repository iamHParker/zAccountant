// Dates for recurring entries. Pure functions, no database.
//
// Occurrence n is always measured from the start date, never from the previous occurrence.
// That keeps month-end templates from drifting: a template starting Jan 31 posts on
// Jan 31, Feb 28 (29 in leap years), Mar 31, Apr 30 ... instead of creeping to the 28th forever.
import { isIsoDate } from './ledger.js';

export const FREQUENCIES = Object.freeze({ weekly: { days: 7 }, monthly: { months: 1 }, quarterly: { months: 3 }, yearly: { months: 12 } });

const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // m is 0-based
const iso = (d) => d.toISOString().slice(0, 10);

/** Date of occurrence n (0 = the start date). */
export function occurrenceDate(startDate, frequency, n) {
  const f = FREQUENCIES[frequency];
  if (!f) throw new RangeError(`unknown frequency ${frequency}`);
  if (!isIsoDate(startDate)) throw new RangeError(`bad start date ${startDate}`);
  if (!Number.isInteger(n) || n < 0) throw new RangeError('occurrence must be a whole number ≥ 0');
  const [y, m, d] = startDate.split('-').map(Number);
  if (f.days) return iso(new Date(Date.UTC(y, m - 1, d + f.days * n)));
  const total = (m - 1) + f.months * n;
  const ny = y + Math.floor(total / 12);
  const nm = total % 12;
  return iso(new Date(Date.UTC(ny, nm, Math.min(d, daysInMonth(ny, nm)))));
}

/** Next date to post after `postedCount` occurrences, or null once past the end date. */
export function nextOccurrence({ startDate, frequency, endDate = null }, postedCount) {
  const next = occurrenceDate(startDate, frequency, postedCount);
  return endDate && next > endDate ? null : next;
}
