// Trips (Homer, 2026-10-25): what one trip cost, its travel time, and the projects it served, each with a share.
// ℹ️ How a trip cost reaches the books: it posts one journal entry, Dr the expense account (Travel…), Cr the account
// it was paid from (bank, credit card, or an owner account when paid personally). Each project's invoice later bills
// its share of the cost (projectService.listUnbilled); billing is income on the invoice and doesn't touch this entry.
// A saved cost is never changed: Edit voids it (entry reversed) and posts the corrected copy, photos and all.
import { withTransaction } from '../db/pool.js';
import { LedgerError, isIsoDate, validateEntry } from '../core/ledger.js';
import { toCents, divRoundHalfUp, mileageAmount } from '../core/money.js';
import { insertEntry, reverseEntry, cleanIdempotencyKey } from './ledgerService.js';
import { appendAudit } from './audit.js';
import { readPicture } from './feedbackService.js';
import { createTimeEntry, updateTimeEntry, deleteTimeEntry } from './timesheetService.js';
import { minutesToHours } from '../core/timesheets.js';

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => typeof v === 'string' && UUIDISH.test(v);
const text = (v, max) => (v == null || v === '' ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || null); // eslint-disable-line no-control-regex
export const MAX_PHOTO_BYTES = 3_145_728;
export const MAX_PHOTOS_PER_COST = 6;
const MAX_TRIP_JOBS = 50;
export { mileageAmount }; // lives in core/money.js (the MileIQ reader uses it too)
export const COST_KINDS = { airfare: 'Airfare', rental_car: 'Rental car', lodging: 'Lodging', meals: 'Meals', tolls: 'Tolls', mileage: 'Mileage', other: 'Other' };

/** "60", "33.33", "12.5%" → hundredths of a percent (6000, 3333, 1250); null if not a percent from 0 to 100. */
export function percentToBp(v) {
  const m = /^\s*(\d{0,3})(?:\.(\d{1,2}))?\s*%?\s*$/.exec(String(v ?? ''));
  if (!m || (!m[1] && !m[2])) return null;
  const bp = Number(m[1] || 0) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp <= 10000 ? bp : null;
}
/** 6000 → "60", 3333 → "33.33", 1250 → "12.5". */
// Shares by kind of cost (migration 038). A NULL column follows the trip share (share_bp); travel time always uses it.
export const SHARE_GROUPS = ['air', 'hotel', 'car', 'rest'];
/** SQL: the share (hundredths of a percent) of trip_jobs tj for a trip cost tc, by the cost's kind. */
export const COST_SHARE_SQL = `CASE tc.kind WHEN 'airfare' THEN coalesce(tj.air_bp, tj.share_bp) WHEN 'lodging' THEN coalesce(tj.hotel_bp, tj.share_bp)
  WHEN 'rental_car' THEN coalesce(tj.car_bp, tj.share_bp) ELSE coalesce(tj.rest_bp, tj.share_bp) END`;
export const bpToPercent = (bp) => (bp / 100).toFixed(2).replace(/\.?0+$/, '');
/** A share as an invoice quantity: 6000 → "0.6", 3333 → "0.3333", 10000 → "1". */
export function bpToQuantity(bp) {
  if (bp === 10000) return '1';
  return `0.${String(bp).padStart(4, '0')}`.replace(/0+$/, '').replace(/\.$/, '') || '0';
}

async function lockCompany(c, companyId) {
  const { rows: [co] } = await c.query('SELECT * FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  if (!co) throw new LedgerError('Company not found');
  return co;
}
async function getTripRow(db, companyId, tripId) {
  if (!isId(tripId)) throw new LedgerError('Trip not found');
  const { rows: [t] } = await db.query('SELECT * FROM trips WHERE company_id = $1 AND id = $2', [companyId, tripId]);
  if (!t) throw new LedgerError('Trip not found');
  return t;
}

// ---------------------------------------------------------------- Travelers (migration 040)
// Who went: company members (the same people who keep timesheets). Each cost names its traveler; travel time already
// names its person. Whoever has a cost or travel time on a trip is one of its travelers.

/** The members who can travel, for the Employee pull-down: [{ id, name }]. */
export async function listTripPeople(db, companyId) {
  const { rows } = await db.query(`SELECT u.id, coalesce(nullif(trim(u.name), ''), u.email) AS name FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.company_id = $1 ORDER BY lower(coalesce(nullif(trim(u.name), ''), u.email))`, [companyId]);
  return rows;
}
async function isMember(c, companyId, userId) {
  if (!isId(userId)) return false;
  return (await c.query('SELECT 1 FROM memberships WHERE company_id = $1 AND user_id = $2', [companyId, userId])).rows.length > 0;
}
async function addTraveler(c, companyId, tripId, userId) {
  if (userId) await c.query('INSERT INTO trip_travelers (company_id, trip_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [companyId, tripId, userId]);
}
/** travelers: [userId]; each a member of the company, once each. */
async function cleanTravelers(c, companyId, raw, errors) {
  if (!Array.isArray(raw) || raw.length > 50) { errors.push('list at most 50 travelers'); return []; }
  const ids = [...new Set(raw.filter(Boolean))];
  for (const id of ids) if (!(await isMember(c, companyId, id))) { errors.push('a traveler must be a member of this company'); return []; }
  return ids;
}

// ---------------------------------------------------------------- Trips and their projects

/** jobs: [{ jobId, share }] with share a percent ("60"); each project once; shares add up to 100% at most. */
async function cleanTrip(c, companyId, input, errors, partial = false) {
  const out = {};
  if (!partial || input.name !== undefined) {
    out.name = text(input.name, 200);
    if (!out.name || out.name.length > 120) errors.push('give the trip a name (up to 120 characters), e.g. Dallas, Oct 4-6');
  }
  if (!partial || input.startDate !== undefined) { out.startDate = input.startDate; if (!isIsoDate(out.startDate)) errors.push('the start date must be a real date'); }
  if (!partial || input.endDate !== undefined) {
    out.endDate = input.endDate || null;
    if (out.endDate && !isIsoDate(out.endDate)) errors.push('the end date must be a real date');
  }
  if (!partial || input.notes !== undefined) out.notes = text(input.notes, 500);
  if (partial && input.isActive !== undefined) out.isActive = input.isActive !== false;
  if (!partial || input.jobs !== undefined) {
    const raw = input.jobs ?? [];
    if (!Array.isArray(raw) || raw.length > MAX_TRIP_JOBS) { errors.push(`list at most ${MAX_TRIP_JOBS} projects`); return out; }
    const rows = raw.filter((j) => j && (j.jobId || (j.share != null && j.share !== '')));
    const ids = rows.map((j) => j.jobId).filter(isId);
    const { rows: found } = ids.length ? await c.query('SELECT id, name FROM jobs WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, ids]) : { rows: [] };
    const names = new Map(found.map((j) => [j.id, j.name]));
    const seen = new Set();
    out.jobs = [];
    rows.forEach((j, i) => {
      const n = `project ${i + 1}`;
      if (!names.has(j.jobId)) { errors.push(`${n}: choose a project`); return; }
      if (seen.has(j.jobId)) { errors.push(`${names.get(j.jobId)} is listed twice`); return; }
      seen.add(j.jobId);
      const bp = percentToBp(j.share);
      if (bp == null) { errors.push(`${names.get(j.jobId)}: the share must be a percent from 0 to 100, like 60 or 33.33`); return; }
      const row = { jobId: j.jobId, shareBp: bp };
      // Optional shares by kind of cost: empty = the same as the trip share.
      for (const g of SHARE_GROUPS) {
        const v = j[g];
        if (v == null || String(v).trim() === '') { row[`${g}Bp`] = null; continue; }
        const gb = percentToBp(v);
        if (gb == null) errors.push(`${names.get(j.jobId)}: the ${GROUP_LABEL[g]} share must be a percent from 0 to 100`);
        row[`${g}Bp`] = gb === bp ? null : gb;
      }
      out.jobs.push(row);
    });
    const total = out.jobs.reduce((s, j) => s + j.shareBp, 0);
    if (total > 10000) errors.push(`the shares add up to ${bpToPercent(total)}%; they can't be more than 100%`);
    for (const g of SHARE_GROUPS) {
      const t = out.jobs.reduce((s, j) => s + (j[`${g}Bp`] ?? j.shareBp), 0);
      if (t > 10000) errors.push(`the ${GROUP_LABEL[g]} shares add up to ${bpToPercent(t)}%; they can't be more than 100%`);
    }
  }
  return out;
}

/** 6000 → "60", 3333 → "33.33" */
const bpText = (bp) => (bp / 100).toFixed(2).replace(/\.?0+$/, '');

const GROUP_LABEL = { air: 'airfare', hotel: 'hotel', car: 'rental car', rest: 'other costs' };

async function saveTripJobs(c, companyId, tripId, jobs) {
  await c.query('DELETE FROM trip_jobs WHERE trip_id = $1', [tripId]);
  for (const j of jobs) {
    await c.query('INSERT INTO trip_jobs (company_id, trip_id, job_id, share_bp, air_bp, hotel_bp, car_bp, rest_bp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [companyId, tripId, j.jobId, j.shareBp, j.airBp ?? null, j.hotelBp ?? null, j.carBp ?? null, j.restBp ?? null]);
  }
}

export async function createTrip(pool, companyId, input, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const errors = [];
    const v = await cleanTrip(c, companyId, input ?? {}, errors);
    if (v.endDate && v.startDate && v.endDate < v.startDate) errors.push('the end date is before the start date');
    const travelers = await cleanTravelers(c, companyId, input?.travelers ?? [], errors);
    if (errors.length) throw new LedgerError('Trip is not valid', errors);
    const { rows: [t] } = await c.query('INSERT INTO trips (company_id, name, start_date, end_date, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [companyId, v.name, v.startDate, v.endDate, v.notes, actor]);
    await saveTripJobs(c, companyId, t.id, v.jobs);
    for (const u of travelers) await addTraveler(c, companyId, t.id, u);
    await appendAudit(c, companyId, { action: 'create', entity: 'trip', entityId: t.id, actor, payload: { ...v, travelers } });
    return getTrip(c, companyId, t.id);
  });
}

/** Change a trip's name, dates, notes, open/closed, or its projects and shares. A share already billed stays as billed. */
export async function updateTrip(pool, companyId, tripId, input, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const old = await getTripRow(c, companyId, tripId);
    const errors = [];
    const v = await cleanTrip(c, companyId, input ?? {}, errors, true);
    const start = v.startDate ?? old.start_date; const end = v.endDate === undefined ? old.end_date : v.endDate;
    if (end && start && end < start) errors.push('the end date is before the start date');
    if (v.jobs) {
      // A project that already billed part of this trip stays on it (its invoice depends on it).
      const { rows: billed } = await c.query(`SELECT DISTINCT j.name, l.job_id FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN jobs j ON j.id = l.job_id
        WHERE d.status = 'posted' AND l.job_id IS NOT NULL AND (l.trip_cost_id IN (SELECT id FROM trip_costs WHERE trip_id = $1)
          OR l.time_entry_id IN (SELECT id FROM time_entries WHERE trip_id = $1))`, [tripId]);
      // ...and keeps its share: later "pull in unbilled" lines use the share, so changing it would bill more or less than 100%.
      const { rows: oldShares } = await c.query('SELECT job_id, share_bp, air_bp, hotel_bp, car_bp, rest_bp FROM trip_jobs WHERE trip_id = $1', [tripId]);
      for (const b of billed) {
        const now = v.jobs.find((j) => j.jobId === b.job_id);
        const was = oldShares.find((s) => s.job_id === b.job_id);
        if (!now) errors.push(`${b.name} has already billed part of this trip, so it stays on the list`);
        else if (was && now.shareBp !== was.share_bp) errors.push(`${b.name} has already billed part of this trip at ${bpText(was.share_bp)}%, so its share stays ${bpText(was.share_bp)}%`);
        else if (was) {
          for (const g of SHARE_GROUPS) {
            const before = was[`${g}_bp`] ?? was.share_bp; const after = now[`${g}Bp`] ?? now.shareBp;
            if (before !== after) errors.push(`${b.name} has already billed part of this trip, so its ${GROUP_LABEL[g]} share stays ${bpText(before)}%`);
          }
        }
      }
    }
    let travelers = null;
    if (input?.travelers !== undefined) {
      travelers = await cleanTravelers(c, companyId, input.travelers, errors);
      // Someone with a cost or travel time on the trip stays on it (their entries say they went).
      const { rows: busy } = await c.query(`SELECT DISTINCT x.user_id, coalesce(nullif(trim(u.name), ''), u.email) AS name FROM (
          SELECT traveler_id AS user_id FROM trip_costs WHERE trip_id = $1 AND status = 'posted' AND traveler_id IS NOT NULL
          UNION SELECT user_id FROM time_entries WHERE trip_id = $1) x JOIN users u ON u.id = x.user_id`, [tripId]);
      for (const b of busy) if (!travelers.includes(b.user_id)) errors.push(`${b.name} has costs or travel time on this trip, so they stay on it`);
    }
    if (errors.length) throw new LedgerError('Trip is not valid', errors);
    if (travelers) {
      await c.query('DELETE FROM trip_travelers WHERE trip_id = $1 AND NOT (user_id = ANY($2::uuid[]))', [tripId, travelers]);
      for (const u of travelers) await addTraveler(c, companyId, tripId, u);
    }
    const cols = { name: 'name', startDate: 'start_date', endDate: 'end_date', notes: 'notes', isActive: 'is_active' };
    const sets = []; const vals = [companyId, tripId];
    for (const [k, col] of Object.entries(cols)) if (v[k] !== undefined) { vals.push(v[k]); sets.push(`${col} = $${vals.length}`); }
    if (sets.length) await c.query(`UPDATE trips SET ${sets.join(', ')} WHERE company_id = $1 AND id = $2`, vals);
    if (v.jobs) await saveTripJobs(c, companyId, tripId, v.jobs);
    await appendAudit(c, companyId, { action: 'update', entity: 'trip', entityId: tripId, actor, payload: travelers ? { ...v, travelers } : v });
    return getTrip(c, companyId, tripId);
  });
}

export async function listTrips(db, companyId, { includeClosed = true } = {}) {
  const { rows } = await db.query(
    `SELECT t.id, t.name, to_char(t.start_date, 'YYYY-MM-DD') AS "startDate", to_char(t.end_date, 'YYYY-MM-DD') AS "endDate", t.is_active AS "isActive",
            COALESCE((SELECT sum(amount_cents) FROM trip_costs WHERE trip_id = t.id AND status = 'posted'), 0)::bigint AS "totalCents",
            (SELECT count(*) FROM trip_costs WHERE trip_id = t.id AND status = 'posted')::int AS "costCount",
            COALESCE((SELECT string_agg(coalesce(j.code, j.name) || ' ' || (tj.share_bp / 100.0)::numeric(6,2)::text || '%', ', ' ORDER BY tj.share_bp DESC, j.name)
                        FROM trip_jobs tj JOIN jobs j ON j.id = tj.job_id WHERE tj.trip_id = t.id), '') AS "projectsText",
            COALESCE((SELECT json_agg(tt.user_id ORDER BY tt.added_at) FROM trip_travelers tt WHERE tt.trip_id = t.id), '[]') AS "travelerIds"
       FROM trips t WHERE t.company_id = $1 AND (t.is_active OR $2) ORDER BY t.start_date DESC, t.created_at DESC LIMIT 500`, [companyId, includeClosed]);
  return rows.map((r) => ({ ...r, totalCents: Number(r.totalCents), projectsText: r.projectsText.replace(/\.00%/g, '%') }));
}

export async function getTrip(db, companyId, tripId) {
  const t = await getTripRow(db, companyId, tripId);
  const { rows: jobs } = await db.query(
    `SELECT tj.job_id AS "jobId", j.name AS "jobName", j.code AS "jobCode", c.name AS "customerName", tj.share_bp AS "shareBp",
            coalesce(tj.air_bp, tj.share_bp) AS "airBp", coalesce(tj.hotel_bp, tj.share_bp) AS "hotelBp",
            coalesce(tj.car_bp, tj.share_bp) AS "carBp", coalesce(tj.rest_bp, tj.share_bp) AS "restBp"
       FROM trip_jobs tj JOIN jobs j ON j.id = tj.job_id LEFT JOIN contacts c ON c.id = j.customer_id
      WHERE tj.trip_id = $1 ORDER BY tj.share_bp DESC, lower(j.name)`, [t.id]);
  const { rows: travelers } = await db.query(
    `SELECT tt.user_id AS id, coalesce(nullif(trim(u.name), ''), u.email) AS name FROM trip_travelers tt JOIN users u ON u.id = tt.user_id
      WHERE tt.trip_id = $1 ORDER BY lower(coalesce(nullif(trim(u.name), ''), u.email))`, [t.id]);
  const { rows: costs } = await db.query(
    `SELECT tc.id, to_char(tc.cost_date, 'YYYY-MM-DD') AS date, tc.traveler_id AS "travelerId", coalesce(nullif(trim(tu.name), ''), tu.email) AS "travelerName", tc.vendor, tc.description, tc.amount_cents AS "amountCents", tc.kind, tc.miles,
            tc.mile_rate_cents AS "mileRateCents",
            tc.expense_account_id AS "expenseAccountId", ea.name AS "expenseAccountName", tc.paid_from_account_id AS "paidFromAccountId", pa.name AS "paidFromName",
            tc.status, tc.replaced_by_id AS "replacedById", e.entry_number AS "entryNumber",
            (SELECT count(*) FROM trip_cost_photos p WHERE p.trip_cost_id = tc.id)::int AS "photoCount",
            COALESCE((SELECT json_agg(json_build_object('jobId', l.job_id, 'number', d.number)) FROM document_lines l JOIN documents d ON d.id = l.document_id
                       WHERE l.trip_cost_id = tc.id AND d.status = 'posted'), '[]') AS billed
       FROM trip_costs tc JOIN accounts ea ON ea.id = tc.expense_account_id JOIN accounts pa ON pa.id = tc.paid_from_account_id
       JOIN journal_entries e ON e.id = tc.journal_entry_id LEFT JOIN users tu ON tu.id = tc.traveler_id
      WHERE tc.trip_id = $1 ORDER BY tc.status, tc.cost_date, tc.created_at`, [t.id]);
  const { rows: time } = await db.query(
    `SELECT te.id, to_char(te.work_date, 'YYYY-MM-DD') AS date, te.minutes, to_char(te.start_time, 'HH24:MI') AS start,
            to_char(te.end_time, 'HH24:MI') AS "end", te.notes, te.billable, te.status, te.user_id AS "userId", coalesce(nullif(trim(u.name), ''), u.email) AS "userName",
            COALESCE((SELECT json_agg(json_build_object('jobId', l.job_id, 'number', d.number)) FROM document_lines l JOIN documents d ON d.id = l.document_id
                       WHERE l.time_entry_id = te.id AND d.status = 'posted'), '[]') AS billed
       FROM time_entries te JOIN users u ON u.id = te.user_id WHERE te.trip_id = $1 ORDER BY te.work_date, te.created_at`, [t.id]);
  const shareTotal = jobs.reduce((s, j) => s + j.shareBp, 0);
  const posted = costs.filter((x) => x.status === 'posted');
  return {
    id: t.id, name: t.name, startDate: t.start_date, endDate: t.end_date, notes: t.notes, isActive: t.is_active, travelers,
    jobs: jobs.map((j) => ({ ...j, share: bpToPercent(j.shareBp), air: bpToPercent(j.airBp), hotel: bpToPercent(j.hotelBp), car: bpToPercent(j.carBp), rest: bpToPercent(j.restBp) })), sharePercent: bpToPercent(shareTotal),
    costs: costs.map((x) => ({ ...x, amountCents: Number(x.amountCents) })),
    totalCents: posted.reduce((s, x) => s + Number(x.amountCents), 0),
    time: time.map((x) => ({ ...x, hours: minutesToHours(x.minutes) })),
    travelMinutes: time.filter((x) => x.status !== 'rejected').reduce((s, x) => s + x.minutes, 0),
  };
}

// ---------------------------------------------------------------- Costs

/** Accounts a trip cost can be paid from: bank and cash, credit cards, and owner (equity) accounts for "paid personally". */
const payableFrom = (a) => a.is_active && (a.cash_flow === 'cash' || a.subtype === 'credit_card' || (a.type === 'equity' && a.system_key !== 'retained_earnings'));
const expenseOk = (a) => a.is_active && (a.type === 'expense' || (a.type === 'asset' && a.cash_flow !== 'cash' && !a.system_key));

// `mileageCents` (server only, never from a request): an imported mileage cost keeps its source's own figure, e.g.
// MileIQ rounds each drive to the cent and adds them up, so the books tie out to its report to the penny.
// `travelerId` (option): whose cost it is when the input names nobody, e.g. the person signed in, or the phone's owner.
export async function addTripCost(pool, companyId, tripId, input, { actor = null, idempotencyKey = null, costId = null, replacesId = null, mileageCents = null, travelerId = null } = {}) {
  idempotencyKey = cleanIdempotencyKey(idempotencyKey);
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    if (idempotencyKey) {
      const { rows: [prior] } = await c.query('SELECT trip_id FROM trip_costs WHERE company_id = $1 AND idempotency_key = $2', [companyId, idempotencyKey]);
      if (prior) return getTrip(c, companyId, prior.trip_id);
    }
    const trip = await getTripRow(c, companyId, tripId);
    const errors = [];
    const date = input?.date;
    if (!isIsoDate(date)) errors.push('the date must be a real date');
    const kind = input?.kind ? String(input.kind) : 'other';
    if (!COST_KINDS[kind]) errors.push('choose what it was (airfare, rental car, mileage…)');
    const description = text(input?.description, 300) ?? (kind !== 'other' ? COST_KINDS[kind] ?? null : null);
    if (!description) errors.push('say what it was (airfare, rental car, tolls…)');
    const vendor = text(input?.vendor, 120);
    let amount = null; let mileage = null;
    if (kind === 'mileage') {
      mileage = mileageAmount(input?.miles, input?.mileRate);
      if (!mileage) errors.push('enter the miles (like 212.4) and the rate per mile (like 0.70)');
      else amount = Number.isSafeInteger(mileageCents) ? mileageCents : mileage.amountCents;
    } else {
      try { amount = toCents(String(input?.amount ?? '')); } catch { errors.push('the amount is not a dollar amount'); }
    }
    if (amount != null && amount <= 0) errors.push('the amount must be more than $0.00');
    const ids = [input?.expenseAccountId, input?.paidFromAccountId].filter(isId);
    const { rows: accts } = ids.length ? await c.query('SELECT * FROM accounts WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, ids]) : { rows: [] };
    const exp = accts.find((a) => a.id === input?.expenseAccountId);
    const from = accts.find((a) => a.id === input?.paidFromAccountId);
    if (!exp || !expenseOk(exp)) errors.push('choose the expense account (Travel, Meals…)');
    if (!from || !payableFrom(from)) errors.push('choose what you paid with (bank, credit card, or paid personally)');
    const traveler = input?.travelerId || travelerId || null;
    if (traveler && !(await isMember(c, companyId, traveler))) errors.push('the traveler must be a member of this company');
    if (errors.length) throw new LedgerError('Trip cost is not valid', errors);
    const label = `Trip ${trip.name}: ${description}${vendor ? ` (${vendor})` : ''}`.slice(0, 500);
    const entry = validateEntry({ date, memo: label, lines: [
      { accountId: exp.id, debitCents: amount, creditCents: 0, memo: description },
      { accountId: from.id, debitCents: 0, creditCents: amount, memo: vendor ?? description },
    ] });
    const id = costId ?? (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id;
    const je = await insertEntry(c, companyId, entry, { source: 'trip', sourceRef: id, actor });
    await c.query(
      `INSERT INTO trip_costs (id, company_id, trip_id, cost_date, vendor, description, amount_cents, expense_account_id, paid_from_account_id, journal_entry_id, idempotency_key, created_by,
                               kind, miles, mile_rate_cents, traveler_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, companyId, trip.id, date, vendor, description, amount, exp.id, from.id, je.id, idempotencyKey, actor, kind, mileage?.miles ?? null, mileage?.rateCentsText ?? null, traveler]);
    await addTraveler(c, companyId, trip.id, traveler);
    await appendAudit(c, companyId, { action: replacesId ? 'replace' : 'create', entity: 'trip_cost', entityId: id, actor,
      payload: { ...(replacesId ? { replacesId } : {}), tripId: trip.id, travelerId: traveler, date, kind, vendor, description, amountCents: amount, ...(mileage ? { miles: mileage.miles, mileRateCents: mileage.rateCentsText } : {}), entryId: je.id } });
    return { ...(await getTrip(c, companyId, trip.id)), costId: id };
  });
}

async function getCostRow(c, companyId, costId, { lock = false } = {}) {
  if (!isId(costId)) throw new LedgerError('Trip cost not found');
  const { rows: [r] } = await c.query(`SELECT * FROM trip_costs WHERE company_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [companyId, costId]);
  if (!r) throw new LedgerError('Trip cost not found');
  return r;
}

export async function voidTripCost(pool, companyId, costId, { actor = null, replacedById = null } = {}) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const r = await getCostRow(c, companyId, costId, { lock: true });
    if (r.status === 'void') throw new LedgerError('That trip cost is already void');
    const { rows: [b] } = await c.query(`SELECT d.number FROM document_lines l JOIN documents d ON d.id = l.document_id
      WHERE l.trip_cost_id = $1 AND d.status = 'posted' LIMIT 1`, [r.id]);
    if (b) throw new LedgerError(`That cost is billed on invoice ${b.number}; edit or void that invoice first`);
    const rev = await reverseEntry(c, companyId, r.journal_entry_id, { memo: `Void trip cost: ${r.description}`, actor, fromDocument: true });
    await c.query(`UPDATE trip_costs SET status = 'void', void_date = $3, void_entry_id = $4, voided_by = $5, voided_at = now(), replaced_by_id = $6
      WHERE company_id = $1 AND id = $2`, [companyId, r.id, rev.entry_date, rev.id, actor, replacedById]);
    await appendAudit(c, companyId, { action: 'void', entity: 'trip_cost', entityId: r.id, actor, payload: { reversalId: rev.id } });
    return getTrip(c, companyId, r.trip_id);
  });
}

/** Edit a trip cost (a late toll, a corrected rental total): void it and post the corrected copy, photos moved along. */
export async function replaceTripCost(pool, companyId, costId, input, { actor = null, idempotencyKey = null } = {}) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const old = await getCostRow(c, companyId, costId);
    const { rows: [{ id: newId }] } = await c.query('SELECT gen_random_uuid() AS id');
    await voidTripCost(c, companyId, costId, { actor, replacedById: newId });
    const saved = await addTripCost(c, companyId, old.trip_id, input, { actor, idempotencyKey, costId: newId, replacesId: costId, travelerId: old.traveler_id });
    await c.query(`INSERT INTO trip_cost_photos (company_id, trip_cost_id, picture, picture_type, created_at, created_by)
      SELECT company_id, $2, picture, picture_type, created_at, created_by FROM trip_cost_photos WHERE trip_cost_id = $1`, [costId, newId]);
    return { ...(await getTrip(c, companyId, saved.id)), costId: newId };
  });
}

// ---------------------------------------------------------------- Receipt photos

export async function listCostPhotos(db, companyId, costId) {
  await getCostRow(db, companyId, costId);
  const { rows } = await db.query('SELECT id, picture_type, octet_length(picture) AS bytes, created_at FROM trip_cost_photos WHERE trip_cost_id = $1 ORDER BY created_at, id', [costId]);
  return rows.map((r) => ({ id: r.id, type: r.picture_type, bytes: Number(r.bytes), createdAt: r.created_at }));
}

export async function addCostPhoto(pool, companyId, costId, { picture, actor = null }) {
  const p = readPicture(picture);
  if (!p) throw new LedgerError('Choose a photo');
  if (p.bytes.length > MAX_PHOTO_BYTES) throw new LedgerError('The photo is too large (3 MB at most)');
  return withTransaction(pool, async (c) => {
    const r = await getCostRow(c, companyId, costId);
    if (r.status === 'void') throw new LedgerError('That cost is void; add the photo to the one that replaced it');
    const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM trip_cost_photos WHERE trip_cost_id = $1', [costId]);
    if (n >= MAX_PHOTOS_PER_COST) throw new LedgerError(`A cost can have at most ${MAX_PHOTOS_PER_COST} photos`);
    const { rows: [row] } = await c.query('INSERT INTO trip_cost_photos (company_id, trip_cost_id, picture, picture_type, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [companyId, costId, p.bytes, p.type, actor]);
    await appendAudit(c, companyId, { action: 'add_photo', entity: 'trip_cost', entityId: costId, actor, payload: { photoId: row.id, bytes: p.bytes.length } });
    return { id: row.id, type: p.type, bytes: p.bytes.length };
  });
}

export async function getCostPhoto(db, companyId, costId, photoId) {
  if (!isId(photoId) || !isId(costId)) throw new LedgerError('Photo not found');
  const { rows: [r] } = await db.query('SELECT picture, picture_type FROM trip_cost_photos WHERE company_id = $1 AND trip_cost_id = $2 AND id = $3', [companyId, costId, photoId]);
  if (!r) throw new LedgerError('Photo not found');
  return { name: `receipt.${r.picture_type === 'image/png' ? 'png' : 'jpg'}`, type: r.picture_type, body: r.picture, inline: true };
}

export async function deleteCostPhoto(pool, companyId, costId, photoId, { actor = null } = {}) {
  if (!isId(photoId)) throw new LedgerError('Photo not found');
  return withTransaction(pool, async (c) => {
    const r = await getCostRow(c, companyId, costId);
    if (r.status === 'void') throw new LedgerError('That cost is void; its photos are kept with its history');
    const { rowCount } = await c.query('DELETE FROM trip_cost_photos WHERE trip_cost_id = $1 AND id = $2', [costId, photoId]);
    if (!rowCount) throw new LedgerError('Photo not found');
    await appendAudit(c, companyId, { action: 'remove_photo', entity: 'trip_cost', entityId: costId, actor, payload: { photoId } });
    return { removed: true };
  });
}

// ---------------------------------------------------------------- Travel time

/** Travel time on a trip: a time entry for the viewer (or someone they manage) with the trip instead of a job. */
export async function addTravelTime(pool, companyId, viewer, tripId, input, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await getTripRow(c, companyId, tripId);
    await createTimeEntry(c, companyId, viewer, { ...input, jobId: null, tripId }, { actor }); // also lists its person as a traveler
    return getTrip(c, companyId, tripId);
  });
}

/** Change a day of travel time (its date, hours or times, notes): the same rules as a timesheet entry. */
export async function updateTravelTime(pool, companyId, viewer, tripId, timeEntryId, input, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await getTripRow(c, companyId, tripId);
    const { rows: [t] } = isId(timeEntryId) ? await c.query('SELECT 1 FROM time_entries WHERE company_id = $1 AND id = $2 AND trip_id = $3', [companyId, timeEntryId, tripId]) : { rows: [] };
    if (!t) throw new LedgerError('Travel time not found');
    await updateTimeEntry(c, companyId, viewer, timeEntryId, { ...input, jobId: null, tripId }, { actor });
    return getTrip(c, companyId, tripId);
  });
}

export async function removeTravelTime(pool, companyId, viewer, tripId, timeEntryId, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await getTripRow(c, companyId, tripId);
    const { rows: [t] } = isId(timeEntryId) ? await c.query('SELECT 1 FROM time_entries WHERE company_id = $1 AND id = $2 AND trip_id = $3', [companyId, timeEntryId, tripId]) : { rows: [] };
    if (!t) throw new LedgerError('Travel time not found');
    await deleteTimeEntry(c, companyId, viewer, timeEntryId, { actor });
    return getTrip(c, companyId, tripId);
  });
}

// ---------------------------------------------------------------- Report: trips by employee (migration 040)

/**
 * Trips by employee, for the owner and the accountant: each person, their trips, each trip's costs (with receipt
 * photos) and travel time, a subtotal per trip, and a total per person. Costs by their date and travel time by its
 * day, both from `from` to `to`; void costs and rejected time are left out. `userId` narrows it to one person.
 * A cost saved before travelers were kept, with nobody named, is under "Not named".
 */
export async function getTripsByEmployee(db, companyId, { from, to, userId = null } = {}) {
  if (!isIsoDate(from) || !isIsoDate(to)) throw new LedgerError('Choose the dates for the report');
  if (from > to) throw new LedgerError('The first date is after the last date');
  if (userId != null && !isId(userId)) throw new LedgerError('That person is not a member of this company');
  const who = `coalesce(nullif(trim(u.name), ''), u.email)`;
  const { rows: costs } = await db.query(
    `SELECT tc.id, tc.trip_id AS "tripId", tc.traveler_id AS "userId", ${who} AS "userName", to_char(tc.cost_date, 'YYYY-MM-DD') AS date,
            tc.kind, tc.description, tc.vendor, tc.miles, tc.mile_rate_cents AS "mileRateCents", tc.amount_cents AS "amountCents", pa.name AS "paidFromName",
            COALESCE((SELECT json_agg(p.id ORDER BY p.created_at, p.id) FROM trip_cost_photos p WHERE p.trip_cost_id = tc.id), '[]') AS "photoIds"
       FROM trip_costs tc JOIN accounts pa ON pa.id = tc.paid_from_account_id LEFT JOIN users u ON u.id = tc.traveler_id
      WHERE tc.company_id = $1 AND tc.status = 'posted' AND tc.cost_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR tc.traveler_id = $4)
      ORDER BY tc.cost_date, tc.created_at`, [companyId, from, to, userId]);
  const { rows: time } = await db.query(
    `SELECT te.id, te.trip_id AS "tripId", te.user_id AS "userId", ${who} AS "userName", to_char(te.work_date, 'YYYY-MM-DD') AS date,
            te.minutes, te.notes, te.status, te.billable
       FROM time_entries te JOIN users u ON u.id = te.user_id
      WHERE te.company_id = $1 AND te.trip_id IS NOT NULL AND te.status <> 'rejected' AND te.work_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR te.user_id = $4)
      ORDER BY te.work_date, te.created_at`, [companyId, from, to, userId]);
  const tripIds = [...new Set([...costs, ...time].map((x) => x.tripId))];
  const { rows: tripRows } = tripIds.length ? await db.query(
    `SELECT t.id, t.name, to_char(t.start_date, 'YYYY-MM-DD') AS "startDate", to_char(t.end_date, 'YYYY-MM-DD') AS "endDate",
            COALESCE((SELECT string_agg(coalesce(j.code, j.name), ', ' ORDER BY tj.share_bp DESC, j.name) FROM trip_jobs tj JOIN jobs j ON j.id = tj.job_id
                       WHERE tj.trip_id = t.id), '') AS "projectsText"
       FROM trips t WHERE t.company_id = $1 AND t.id = ANY($2::uuid[])`, [companyId, tripIds]) : { rows: [] };
  const tripInfo = new Map(tripRows.map((t) => [t.id, t]));

  // Person → trip → entries. People A to Z (Not named last); trips by their first day.
  const people = new Map();
  const personFor = (x) => {
    const key = x.userId ?? '';
    if (!people.has(key)) people.set(key, { userId: x.userId, name: x.userId ? x.userName : 'Not named', trips: new Map() });
    return people.get(key);
  };
  const tripFor = (p, tripId) => {
    if (!p.trips.has(tripId)) p.trips.set(tripId, { ...tripInfo.get(tripId), tripId, costs: [], time: [] });
    return p.trips.get(tripId);
  };
  for (const x of costs) {
    tripFor(personFor(x), x.tripId).costs.push({ id: x.id, date: x.date, kind: x.kind, kindLabel: COST_KINDS[x.kind] ?? x.kind, description: x.description,
      vendor: x.vendor, miles: x.miles, mileRateCents: x.mileRateCents, amountCents: Number(x.amountCents), paidFromName: x.paidFromName, photoIds: x.photoIds });
  }
  for (const x of time) {
    tripFor(personFor(x), x.tripId).time.push({ id: x.id, date: x.date, minutes: x.minutes, hours: minutesToHours(x.minutes), notes: x.notes, status: x.status, billable: x.billable });
  }
  const sum = (list, f) => list.reduce((t, x) => t + f(x), 0);
  const out = [...people.values()].map((p) => {
    const trips = [...p.trips.values()].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name)).map((t) => {
      const costCents = sum(t.costs, (x) => x.amountCents); const minutes = sum(t.time, (x) => x.minutes);
      return { ...t, costCents, minutes, hours: minutesToHours(minutes), photoCount: sum(t.costs, (x) => x.photoIds.length) };
    });
    const costCents = sum(trips, (t) => t.costCents); const minutes = sum(trips, (t) => t.minutes);
    return { userId: p.userId, name: p.name, trips, tripCount: trips.length, costCount: sum(trips, (t) => t.costs.length), costCents, minutes, hours: minutesToHours(minutes) };
  }).sort((a, b) => (a.userId ? 0 : 1) - (b.userId ? 0 : 1) || a.name.localeCompare(b.name));
  const totalCents = sum(out, (p) => p.costCents); const totalMinutes = sum(out, (p) => p.minutes);
  return { from, to, people: out, totals: { costCents: totalCents, minutes: totalMinutes, hours: minutesToHours(totalMinutes), tripCount: tripIds.length } };
}
