// Reading a MileIQ drive report (the "Download as CSV" button in MileIQ's monthly email). Pure functions, no database.
//
// ℹ️ The file is laid out like a spreadsheet, not a plain table:
//   rates >>>,business $,0.76,medical $,…      the rates per mile, on line 1
//   SUMMARY … one row per vehicle               totals, all Excel formulas (=SUMIFS…): ignored
//   DETAILED LOG
//   START_DATE*,END_DATE*,CATEGORY*,START*,STOP*,RATE,MILES*,MILES_VALUE,PARKING,TOLLS,TOTAL,VEHICLE,PURPOSE,NOTES
//   one row per drive                           MILES_VALUE and TOTAL are formulas too (=ROUND(PRODUCT(F12,G12),2))
//   Totals,,,…  /  Report created at MileIQ.com  /  "* For an IRS compliant log …"
// So the reader finds the DETAILED LOG header by name, reads only the typed cells (dates, places, rate, miles,
// parking, tolls, vehicle, purpose, notes), and works the dollars out itself: miles × rate, exact, rounded once.
import { createHash } from 'node:crypto';
import { parseCsv, parseBankDate, ImportError, MAX_IMPORT_ROWS } from './bankImport.js';
import { parseClock } from './timesheets.js';
import { toCents, mileageAmount } from './money.js';

const norm = (h) => String(h ?? '').toLowerCase().replace(/[^a-z]/g, '');
const COLUMNS = {
  startAt: 'startdate', endAt: 'enddate', category: 'category', from: 'start', to: 'stop', rate: 'rate', miles: 'miles',
  parking: 'parking', tolls: 'tolls', vehicle: 'vehicle', purpose: 'purpose', notes: 'notes',
};
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); // eslint-disable-line no-control-regex

/** "10/01/2026 09:00" → { date: '2026-10-01', time: '09:00' }, or null. */
function dateTime(v) {
  const s = String(v ?? '').trim();
  const date = parseBankDate(s);
  if (!date) return null;
  const rest = s.replace(/^\S+\s*/, '');
  const time = rest ? parseClock(rest) : null;
  return rest && !time ? null : { date, time };
}

/** A typed rate like "0.76" or "$0.725" → the same text without the $, or null (a formula or blank). */
function rateText(v) {
  const s = String(v ?? '').trim().replace(/^\$/, '');
  return /^\d{0,2}(\.\d{1,4})?$/.test(s) && /\d/.test(s) ? s : null;
}

/** Parking or tolls: "0", "3.50", "$12.00" → cents; blank → 0; anything else (a formula) → null. */
function dollars(v) {
  const s = String(v ?? '').trim();
  if (!s) return 0;
  try { return toCents(s.replace(/^\$/, '')); } catch { return null; }
}

/** MileIQ shows miles with one decimal; keep up to two (what a trip cost holds). "21.2" → "21.2", "3" → "3". */
function milesText(v) {
  const s = String(v ?? '').trim().replace(/,/g, '');
  const m = /^(\d{1,6})(?:\.(\d{1,2})\d*)?$/.exec(s);
  return m ? `${m[1]}${m[2] && Number(m[2]) ? `.${m[2].replace(/0+$/, '')}` : ''}` : null;
}

/**
 * Read a MileIQ CSV. Returns { rates: { business, medical, charity, moving }, drives: [...], vehicles }.
 * Each drive: { line, key, date, startTime, endDate, endTime, category, from, to, rate, miles, valueCents, parkingCents,
 * tollsCents, vehicle, purpose, notes, business }. `key` is a fingerprint of the drive (when, where, how far, which car)
 * so importing next month's file, or this one again, never brings in a drive twice; reclassifying a drive in MileIQ
 * keeps its key. Throws ImportError listing every row that can't be read: nothing is imported if any row is bad.
 */
export function readMileIqCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw new ImportError('The file is empty');
  const all = parseCsv(text.replace(/^﻿/, ''));
  const rates = {};
  const rateRow = all.find((r) => /^rates/i.test(String(r[0] ?? '').trim()));
  if (rateRow) {
    for (let i = 1; i + 1 < rateRow.length; i += 2) {
      const name = norm(rateRow[i]);
      const r = rateText(rateRow[i + 1]);
      if (name && r) rates[name] = r;
    }
  }
  const headerAt = all.findIndex((r) => norm(r[0]) === 'startdate' && r.some((h) => norm(h) === 'miles'));
  if (headerAt < 0) {
    throw new ImportError("This doesn't look like a MileIQ drive report: there's no START_DATE / MILES header. Use the CSV (not the PDF) from MileIQ's monthly email, or MileIQ.com → Reports → CSV.");
  }
  const header = all[headerAt].map(norm);
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, name]) => [k, header.indexOf(name)]));
  for (const k of ['startAt', 'category', 'miles']) {
    if (col[k] < 0) throw new ImportError(`The MileIQ file is missing its ${k === 'startAt' ? 'START_DATE' : k.toUpperCase()} column`);
  }
  const body = all.slice(headerAt + 1);
  if (body.length > MAX_IMPORT_ROWS) throw new ImportError(`The file has more than ${MAX_IMPORT_ROWS} rows; export a shorter date range`);
  const drives = [];
  const errors = [];
  const seen = new Set();
  body.forEach((r, i) => {
    const line = headerAt + i + 2;
    const cell = (k) => (col[k] >= 0 ? String(r[col[k]] ?? '').trim() : '');
    const first = String(r.find((x) => String(x).trim()) ?? '').trim();
    if (!dateTime(cell('startAt'))) {
      // The Totals row and the footer lines ("Report created at MileIQ.com", the IRS note) are not drives.
      if (/^(totals?\b|report created|\*|for an irs)/i.test(first) || !cell('miles')) return;
      errors.push(`line ${line}: can't read the start date "${cell('startAt')}"`);
      return;
    }
    const s = dateTime(cell('startAt'));
    const e = cell('endAt') ? dateTime(cell('endAt')) : null;
    if (cell('endAt') && !e) { errors.push(`line ${line}: can't read the end date "${cell('endAt')}"`); return; }
    const miles = milesText(cell('miles'));
    if (miles == null) { errors.push(`line ${line}: can't read the miles "${cell('miles')}"`); return; }
    const category = clean(cell('category'), 40) || 'Unclassified';
    const business = /^business$/i.test(category);
    const rate = rateText(cell('rate')) ?? (business ? rates.business ?? null : null);
    const parkingCents = dollars(cell('parking'));
    const tollsCents = dollars(cell('tolls'));
    if (parkingCents == null || parkingCents < 0) { errors.push(`line ${line}: can't read the parking "${cell('parking')}"`); return; }
    if (tollsCents == null || tollsCents < 0) { errors.push(`line ${line}: can't read the tolls "${cell('tolls')}"`); return; }
    const value = rate ? mileageAmount(miles, rate) : null;
    const d = {
      line, date: s.date, startTime: s.time, endDate: e?.date ?? null, endTime: e?.time ?? null, category, business,
      from: clean(cell('from'), 200), to: clean(cell('to'), 200), rate, miles, valueCents: value?.amountCents ?? 0,
      parkingCents, tollsCents, vehicle: clean(cell('vehicle'), 80), purpose: clean(cell('purpose'), 80), notes: clean(cell('notes'), 300),
    };
    d.key = createHash('sha256').update([cell('startAt'), cell('endAt'), d.from.toLowerCase(), d.to.toLowerCase(), miles, d.vehicle.toLowerCase()].join('|')).digest('hex').slice(0, 32);
    if (seen.has(d.key)) return; // the same drive twice in one file
    seen.add(d.key);
    drives.push(d);
  });
  if (errors.length) throw new ImportError(`${errors.length} drive(s) could not be read`, errors);
  if (!drives.length) throw new ImportError('The file has no drives');
  return { rates, drives, vehicles: [...new Set(drives.map((d) => d.vehicle).filter(Boolean))] };
}

/** Miles as text summed exactly (hundredths): ["21.2", "0.7"] → "21.9". */
export function sumMiles(list) {
  const h = list.reduce((t, m) => {
    const [w, f = ''] = String(m).split('.');
    return t + Number(w) * 100 + Number(f.padEnd(2, '0'));
  }, 0);
  return `${Math.floor(h / 100)}${h % 100 ? `.${String(h % 100).padStart(2, '0').replace(/0$/, '')}` : ''}`;
}
