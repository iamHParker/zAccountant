// Timesheet arithmetic: reading hours, overtime rules, and reading time-tracking app exports.
// Pure functions, no database. Time is kept in whole minutes (exact); payroll gets hours rounded to
// hundredths only at the very end.
import { createHash } from 'node:crypto';
import { parseCsv, parseBankDate, ImportError, MAX_IMPORT_ROWS } from './bankImport.js';
import { isIsoDate } from './ledger.js';

/**
 * Hours as typed by a person or an app -> whole minutes, or null if it can't be read.
 * Accepts 7.5, "7.50 hrs", "7:30", "7:30:00", "7h 30m", "45m".
 */
export function parseDuration(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  let r;
  if ((r = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(s))) return Number(r[1]) * 60 + Number(r[2]) + Math.round(Number(r[3] ?? 0) / 60);
  if ((r = /^(?:(\d{1,3})\s*h(?:ours?|rs?)?)?\s*(?:(\d{1,4})\s*m(?:in(?:utes?|s)?)?)?$/.exec(s)) && (r[1] || r[2])) return Number(r[1] ?? 0) * 60 + Number(r[2] ?? 0);
  if ((r = /^(\d{1,3}(?:\.\d+)?|\.\d+)\s*(?:h|hr|hrs|hours?)?$/.exec(s))) return Math.round(Number(r[1]) * 60);
  return null;
}

/** "8:05 AM", "08:05", "20:05:30", "8am" -> "08:05" (24-hour), or null. */
export function parseClock(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const r = /^(\d{1,2})(?::(\d{2}))?(?::\d{2}(?:\.\d+)?)? ?(a\.?m\.?|p\.?m\.?)?$/.exec(s);
  if (!r || (r[2] === undefined && !r[3])) return null;
  let h = Number(r[1]);
  const m = Number(r[2] ?? 0);
  if (m > 59) return null;
  if (r[3]) {
    if (h < 1 || h > 12) return null;
    if (r[3].startsWith('p') && h !== 12) h += 12;
    if (r[3].startsWith('a') && h === 12) h = 0;
  } else if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A date with an optional time: "10/14/2026 8:00 AM", "2026-10-14T08:00", "Oct 14, 2026 at 8:00 AM". */
export function parseDateTime(v) {
  let s = String(v ?? '').trim().replace(/^[a-z]{3,9},\s*/i, ''); // drop a leading weekday
  let r;
  if ((r = /^([a-z]{3,9})\.? (\d{1,2}),? (\d{4})(.*)$/i.exec(s))) {
    const mi = MONTHS.indexOf(r[1].slice(0, 3).toLowerCase());
    if (mi < 0) return null;
    s = `${r[3]}-${String(mi + 1).padStart(2, '0')}-${r[2].padStart(2, '0')}${r[4]}`;
  }
  const date = parseBankDate(s.replace('T', ' '));
  if (!date) return null;
  const rest = s.replace('T', ' ').replace(/^\S+/, '').replace(/^\s*(at|,)\s*/i, '').trim().replace(/(z|[+-]\d{2}:?\d{2})$/i, '');
  const time = rest ? parseClock(rest) : null;
  if (rest && !time) return null;
  return { date, time };
}

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Minutes between two clock times on one shift (an end before the start means the shift ran past midnight). */
export function shiftMinutes(start, end) {
  const d = minutesOf(end) - minutesOf(start);
  return d > 0 ? d : d + 1440;
}

const norm = (h) => h.toLowerCase().replace(/[^a-z]/g, '');
const COLUMNS = {
  start: ['clockedin', 'clockin', 'start', 'starttime', 'startdate', 'in', 'timein', 'from'],
  end: ['clockedout', 'clockout', 'end', 'endtime', 'enddate', 'out', 'timeout', 'to'],
  date: ['date', 'day', 'workdate'],
  hours: ['duration', 'hours', 'totalhours', 'total', 'time', 'durationhours', 'hoursworked'],
  breaks: ['breaks', 'break', 'breakduration', 'unpaidbreak'],
  job: ['job', 'jobname', 'project', 'client', 'task'],
  notes: ['comment', 'comments', 'notes', 'note', 'description', 'memo'],
};

/**
 * Read a timesheet export (HoursTracker, or any CSV with similar column names). Each row needs a
 * date (a "Date" column, or a "Clocked In" date-time) and either a duration column or clock in/out
 * times; breaks are subtracted only when the duration comes from clock times.
 * Returns { rows: [{ line, date, start, end, minutes, job, notes, hash }], format }. Throws
 * ImportError listing every bad row: nothing is imported if any row can't be read.
 */
export function readTimesheetCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw new ImportError('The file is empty');
  const all = parseCsv(text.replace(/^﻿/, ''));
  // Some exports put a title line or totals above the header: use the first row that names a date column.
  const headerAt = all.findIndex((r) => r.some((h) => [...COLUMNS.start, ...COLUMNS.date].includes(norm(h))));
  if (headerAt < 0) throw new ImportError('Could not find a header row with a "Date" or "Clocked In" column');
  const header = all[headerAt].map(norm);
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))]));
  if (col.hours < 0 && (col.start < 0 || col.end < 0)) throw new ImportError('The file needs a "Duration" or "Hours" column, or both "Clocked In" and "Clocked Out" columns');
  const body = all.slice(headerAt + 1);
  if (body.length > MAX_IMPORT_ROWS) throw new ImportError(`The file has more than ${MAX_IMPORT_ROWS} rows; split it into smaller files`);
  const rows = [];
  const errors = [];
  body.forEach((r, i) => {
    const line = headerAt + i + 2;
    const cell = (k) => (col[k] >= 0 ? String(r[col[k]] ?? '').trim() : '');
    if (/^(totals?|sum|grand total)\b/i.test(r.find((x) => String(x).trim()) ?? '')) return; // a totals line
    // A start/end cell holds a date and time ("10/14/2026 8:00 AM"), or just a time when there is a Date column.
    const when = (k) => {
      if (!cell(k)) return { ok: true, at: null };
      const dt = parseDateTime(cell(k));
      if (dt) return { ok: true, at: dt };
      const t = parseClock(cell(k));
      return t ? { ok: true, at: { date: null, time: t } } : { ok: false };
    };
    const sw = when('start');
    const ew = when('end');
    if (!sw.ok) { errors.push(`line ${line}: can't read the start "${cell('start')}"`); return; }
    if (!ew.ok) { errors.push(`line ${line}: can't read the end "${cell('end')}"`); return; }
    const s = sw.at;
    const e = ew.at;
    let date = s?.date ?? null;
    if (cell('date')) {
      const d = parseDateTime(cell('date'));
      if (!d) { errors.push(`line ${line}: can't read the date "${cell('date')}"`); return; }
      date = d.date;
    }
    if (!date) { errors.push(`line ${line}: no date`); return; }
    const start = s?.time ?? null;
    const end = e?.time ?? null;
    let minutes = cell('hours') ? parseDuration(cell('hours')) : null;
    if (cell('hours') && minutes == null) { errors.push(`line ${line}: can't read the hours "${cell('hours')}"`); return; }
    if (minutes == null) {
      if (!start || !end) { errors.push(`line ${line}: needs hours, or clock-in and clock-out times`); return; }
      if (e?.date && s?.date) {
        const days = (Date.parse(e.date) - Date.parse(s.date)) / 86_400_000;
        if (days < 0 || days > 1) { errors.push(`line ${line}: the shift ends before it starts, or runs more than a day`); return; }
        minutes = days * 1440 + minutesOf(end) - minutesOf(start);
      } else minutes = shiftMinutes(start, end);
      if (cell('breaks')) {
        const b = parseDuration(cell('breaks'));
        if (b == null) { errors.push(`line ${line}: can't read the breaks "${cell('breaks')}"`); return; }
        minutes -= b;
      }
    }
    if (minutes === 0) return; // an empty clock-in/out, nothing worked
    if (!(minutes > 0 && minutes <= 1440)) { errors.push(`line ${line}: hours must be more than 0 and at most 24`); return; }
    const job = cell('job').slice(0, 80);
    const notes = cell('notes').slice(0, 500);
    const hash = createHash('sha256').update([date, start ?? '', end ?? '', minutes, job.toLowerCase(), notes].join('|')).digest('hex').slice(0, 32);
    rows.push({ line, date, start, end, minutes, job, notes, hash });
  });
  if (errors.length) throw new ImportError(`${errors.length} row(s) could not be read`, errors);
  if (!rows.length) throw new ImportError('The file has no time entries');
  const format = header.includes('clockedin') && header.includes('duration') ? 'HoursTracker' : 'CSV';
  return { rows, format };
}

/** Whole minutes -> hours as a decimal string with 2 places, rounded half-up ("452" min -> "7.53"). */
export function minutesToHours(min) {
  const h = Math.floor((min * 100 + 30) / 60); // hundredths of an hour
  return `${Math.floor(h / 100)}.${String(h % 100).padStart(2, '0')}`;
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = Sunday

/** The first day of the workweek holding `date` (weeks start on `startDay`, 0 = Sunday). */
export function workweekStart(date, startDay = 0) {
  return addDays(date, -((weekday(date) - startDay + 7) % 7));
}

/**
 * Split days worked into regular, overtime (1.5×) and double time (2×), in minutes.
 * `days`: [{ date, minutes }] (one row per date; any order). Federal rule (FLSA): over 40 hours in a
 * workweek is overtime. California adds: over 8 hours in a day is overtime, over 12 is double time,
 * and on the 7th day in a row of one workweek the first 8 hours are overtime and the rest double
 * time. Weekly overtime counts only the hours that weren't already daily overtime.
 * Returns [{ date, regular, overtime, doubleTime }] in date order.
 */
export function splitOvertime(days, { state, workweekStartDay = 0 } = {}) {
  const sorted = [...days].filter((d) => d.minutes > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
  const byWeek = new Map();
  for (const d of sorted) {
    const k = workweekStart(d.date, workweekStartDay);
    if (!byWeek.has(k)) byWeek.set(k, []);
    byWeek.get(k).push(d);
  }
  const out = [];
  for (const [start, week] of byWeek) {
    const allSeven = state === 'CA' && week.length === 7;
    let weekRegular = 0;
    for (const d of week) {
      const m = d.minutes;
      let regular = m; let overtime = 0; let doubleTime = 0;
      if (state === 'CA') {
        if (allSeven && d.date === addDays(start, 6)) { regular = 0; overtime = Math.min(m, 480); doubleTime = Math.max(0, m - 480); }
        else { regular = Math.min(m, 480); overtime = Math.max(0, Math.min(m, 720) - 480); doubleTime = Math.max(0, m - 720); }
      }
      const excess = Math.max(0, weekRegular + regular - 2400);
      regular -= excess; overtime += excess;
      weekRegular += regular;
      out.push({ date: d.date, regular, overtime, doubleTime });
    }
  }
  return out;
}

export { isIsoDate };
