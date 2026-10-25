// MileIQ import (Homer, 2026-10-25): MileIQ's monthly drive report (CSV) → mileage on trips.
// ℹ️ How it goes: the person picks the file; the preview lists every drive, marks the ones already imported, and
// suggests the trip whose dates cover each drive. They choose a trip for each business drive they want (or let the
// rest go on one new "local driving" trip), and the import posts, per trip and day, one mileage cost (each drive's
// miles × rate rounded to the cent, then added up, as MileIQ's report does, so the two tie out), plus tolls and parking from the file as their own costs. Every cost goes through
// tripService.addTripCost, so it is an ordinary trip cost: its own journal entry, projects bill their share, Edit =
// void + corrected copy. The drive details are kept in mileage_drives (migration 028).
// Personal, commute, medical, charity and moving drives are shown but never imported: they are not business costs.
import { withTransaction } from '../db/pool.js';
import { LedgerError } from '../core/ledger.js';
import { ImportError } from '../core/bankImport.js';
import { centsToDecimal, mileageAmount } from '../core/money.js';
import { readMileIqCsv, sumMiles } from '../core/mileiq.js';
import { createTrip, addTripCost } from './tripService.js';
import { appendAudit } from './audit.js';

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => typeof v === 'string' && UUIDISH.test(v);

function read(content) {
  try { return readMileIqCsv(typeof content === 'string' ? content : ''); } catch (e) {
    if (e instanceof ImportError) throw new LedgerError(e.message, e.details);
    throw e;
  }
}

/** Drive keys already in the books (their mileage cost is posted, or was edited into a corrected copy). */
async function importedKeys(db, companyId, keys) {
  const { rows } = await db.query(
    `SELECT DISTINCT md.drive_key FROM mileage_drives md JOIN trip_costs tc ON tc.id = md.trip_cost_id
      WHERE md.company_id = $1 AND md.drive_key = ANY($2::text[]) AND (tc.status = 'posted' OR tc.replaced_by_id IS NOT NULL)`, [companyId, keys]);
  return new Set(rows.map((r) => r.drive_key));
}

/** "6701 S Padre Island Dr, Corpus Christi, TX, …" → "6701 S Padre Island Dr"; a named place ("Office") stays. */
const shortPlace = (p) => String(p ?? '').split(',')[0].trim().slice(0, 40) || '?';

/** Office → Marco → Office (drives that chain), or "A → B; C → D" when they don't. */
export function routeText(drives) {
  const parts = [];
  let last = null;
  for (const d of drives) {
    const from = shortPlace(d.from); const to = shortPlace(d.to);
    if (last !== null && last === from) parts[parts.length - 1] += ` → ${to}`;
    else parts.push(`${from} → ${to}`);
    last = to;
  }
  return parts.join('; ');
}

/** What's in the file, nothing saved. Each drive: its details, `imported`, and a suggested `tripId` (or null). */
export async function previewMileIq(db, companyId, { content }) {
  const parsed = read(content);
  const done = await importedKeys(db, companyId, parsed.drives.map((d) => d.key));
  const { rows: trips } = await db.query(
    `SELECT id, to_char(start_date, 'YYYY-MM-DD') AS s, to_char(coalesce(end_date, start_date), 'YYYY-MM-DD') AS e
       FROM trips WHERE company_id = $1 AND is_active ORDER BY start_date DESC, created_at DESC`, [companyId]);
  const drives = parsed.drives.map((d) => ({
    ...d, imported: done.has(d.key),
    tripId: d.business ? trips.find((t) => t.s <= d.date && d.date <= t.e)?.id ?? null : null,
  }));
  const todo = drives.filter((d) => d.business && !d.imported);
  return {
    rates: parsed.rates, vehicles: parsed.vehicles, drives,
    from: drives.reduce((m, d) => (d.date < m ? d.date : m), drives[0].date),
    to: drives.reduce((m, d) => (d.date > m ? d.date : m), drives[0].date),
    counts: {
      drives: drives.length, business: drives.filter((d) => d.business).length, imported: drives.filter((d) => d.imported).length,
      toImport: todo.length, miles: sumMiles(drives.map((d) => d.miles)), businessMiles: sumMiles(todo.map((d) => d.miles)),
      // What the import will post for mileage: each drive rounded to the cent, then added up (MileIQ's report figure).
      mileIqValueCents: todo.reduce((t, d) => t + d.valueCents, 0),
      tollsCents: todo.reduce((t, d) => t + d.tollsCents, 0), parkingCents: todo.reduce((t, d) => t + d.parkingCents, 0),
    },
  };
}

/**
 * Post the chosen drives. input: { content, drives: [{ key, tripId }] (tripId a trip's id, or 'new' for the new
 * local-driving trip), newTripName, rate (optional, dollars per mile; replaces the file's), expenseAccountId,
 * paidFromAccountId }. The file is read again here; only the keys and trips come from the screen.
 */
export async function importMileIq(pool, companyId, input, { actor = null } = {}) {
  const parsed = read(input?.content);
  const byKey = new Map(parsed.drives.map((d) => [d.key, d]));
  const picks = Array.isArray(input?.drives) ? input.drives : [];
  const errors = [];
  if (!picks.length) errors.push('tick the drives to import');
  const rate = input?.rate == null || input.rate === '' ? null : String(input.rate).trim().replace(/^\$/, '');
  if (rate != null && !(mileageAmount('10000', rate)?.amountCents > 0)) errors.push('the rate per mile must be a dollar amount like 0.70');
  const chosen = [];
  const seen = new Set();
  for (const p of picks) {
    const d = byKey.get(p?.key);
    if (!d) { errors.push('a drive on the screen is not in the file; choose the file again'); break; }
    if (seen.has(d.key)) continue;
    seen.add(d.key);
    if (!d.business) { errors.push(`${d.date} ${d.startTime ?? ''}: only Business drives can be imported (this one is ${d.category})`); continue; }
    if (p.tripId !== 'new' && !isId(p.tripId)) { errors.push(`${d.date} ${d.startTime ?? ''}: choose a trip for this drive`); continue; }
    const r = rate ?? d.rate;
    if (!r) { errors.push(`${d.date} ${d.startTime ?? ''}: the file has no rate for this drive; type the rate per mile`); continue; }
    chosen.push({ ...d, tripId: p.tripId, rate: r });
  }
  if (chosen.some((d) => d.tripId === 'new') && !String(input?.newTripName ?? '').trim()) errors.push('name the new trip for local driving');
  if (errors.length) throw new LedgerError('MileIQ import is not valid', errors);

  return withTransaction(pool, async (c) => {
    await c.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId]); // one import at a time
    const done = await importedKeys(c, companyId, chosen.map((d) => d.key));
    const fresh = chosen.filter((d) => !done.has(d.key));
    if (!fresh.length) throw new LedgerError('Those drives are already imported');
    const local = fresh.filter((d) => d.tripId === 'new');
    if (local.length) {
      const dates = local.map((d) => d.date).sort();
      const t = await createTrip(c, companyId, { name: input.newTripName, startDate: dates[0], endDate: dates.at(-1),
        notes: 'Made by the MileIQ import. Add the projects this driving was for (and their shares) so their invoices can bill it.' }, { actor });
      for (const d of local) d.tripId = t.id;
    }
    const groups = new Map();
    for (const d of fresh.sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`))) {
      const g = `${d.tripId}|${d.date}|${d.rate}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(d);
    }
    const accounts = { expenseAccountId: input?.expenseAccountId, paidFromAccountId: input?.paidFromAccountId };
    let amountCents = 0; let costs = 0;
    for (const list of groups.values()) {
      const { tripId, date, rate: r } = list[0];
      const n = list.length;
      const description = `MileIQ, ${n} drive${n === 1 ? '' : 's'}: ${routeText(list)}`.slice(0, 300);
      const miles = sumMiles(list.map((d) => d.miles));
      // MileIQ's own figure: each drive's miles × rate rounded to the cent, then added up (its report does the same).
      const cents = list.reduce((t, d) => t + mileageAmount(d.miles, r).amountCents, 0);
      const made = await addTripCost(c, companyId, tripId, { date, kind: 'mileage', miles, mileRate: r, description, vendor: list[0].vehicle || null, ...accounts },
        { actor, mileageCents: cents });
      amountCents += cents; costs++;
      for (const d of list) {
        await c.query(
          `INSERT INTO mileage_drives (company_id, drive_key, drive_date, start_time, end_time, from_place, to_place, miles, mile_rate,
                                       parking_cents, tolls_cents, vehicle, purpose, notes, trip_id, trip_cost_id, imported_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [companyId, d.key, d.date, d.startTime, d.endTime, d.from || null, d.to || null, d.miles, r, d.parkingCents, d.tollsCents,
            d.vehicle || null, d.purpose || null, d.notes || null, tripId, made.costId, actor]);
      }
      for (const [kind, field, label] of [['tolls', 'tollsCents', 'Tolls'], ['other', 'parkingCents', 'Parking']]) {
        const cents = list.reduce((t, d) => t + d[field], 0);
        if (!cents) continue;
        await addTripCost(c, companyId, tripId, { date, kind, amount: centsToDecimal(cents), description: `${label} (MileIQ)`, ...accounts }, { actor });
        amountCents += cents; costs++;
      }
    }
    const result = { drives: fresh.length, skipped: chosen.length - fresh.length, costs, amountCents,
      miles: sumMiles(fresh.map((d) => d.miles)), trips: [...new Set(fresh.map((d) => d.tripId))] };
    await appendAudit(c, companyId, { action: 'import', entity: 'mileiq', entityId: null, actor, payload: result });
    return result;
  });
}
