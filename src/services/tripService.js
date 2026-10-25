// Trips (Homer, 2026-10-25): what one trip cost, its travel time, and the projects it served, each with a share.
// ℹ️ How a trip cost reaches the books: it posts one journal entry, Dr the expense account (Travel…), Cr the account
// it was paid from (bank, credit card, or an owner account when paid personally). Each project's invoice later bills
// its share of the cost (projectService.listUnbilled); billing is income on the invoice and doesn't touch this entry.
// A saved cost is never changed: Edit voids it (entry reversed) and posts the corrected copy, photos and all.
import { withTransaction } from '../db/pool.js';
import { LedgerError, isIsoDate, validateEntry } from '../core/ledger.js';
import { toCents, divRoundHalfUp } from '../core/money.js';
import { insertEntry, reverseEntry, cleanIdempotencyKey } from './ledgerService.js';
import { appendAudit } from './audit.js';
import { readPicture } from './feedbackService.js';
import { createTimeEntry, deleteTimeEntry } from './timesheetService.js';
import { minutesToHours } from '../core/timesheets.js';

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => typeof v === 'string' && UUIDISH.test(v);
const text = (v, max) => (v == null || v === '' ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || null); // eslint-disable-line no-control-regex
export const MAX_PHOTO_BYTES = 3_145_728;
export const MAX_PHOTOS_PER_COST = 6;
const MAX_TRIP_JOBS = 50;
export const COST_KINDS = { airfare: 'Airfare', rental_car: 'Rental car', lodging: 'Lodging', meals: 'Meals', tolls: 'Tolls', mileage: 'Mileage', other: 'Other' };

/**
 * Mileage: miles (up to 2 decimals) × a rate in dollars per mile (up to 4 decimals, e.g. "0.70" or "0.725").
 * Returns { miles, rateCentsText, amountCents } or null if either isn't a number. Exact, rounded half-up once:
 * 212.4 mi × $0.725 = $153.99 (21240 × 7250 / 10000 = 15399).
 */
export function mileageAmount(miles, rate) {
  const m = /^\s*(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(String(miles ?? ''));
  const r = /^\s*\$?(\d{0,2})(?:\.(\d{1,4}))?\s*$/.exec(String(rate ?? ''));
  if (!m || !r || (!r[1] && !r[2])) return null;
  const m100 = BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  const r4 = BigInt(r[1] || 0) * 10000n + BigInt((r[2] ?? '').padEnd(4, '0'));
  const cents = Number(divRoundHalfUp(m100 * r4, 10000n));
  const rc = Number(r4) / 100; // cents per mile, e.g. 72.5
  return { miles: `${m[1]}${m[2] ? `.${m[2]}` : ''}`, rateCentsText: String(Number(rc.toFixed(2))), amountCents: cents };
}

/** "60", "33.33", "12.5%" → hundredths of a percent (6000, 3333, 1250); null if not a percent from 0 to 100. */
export function percentToBp(v) {
  const m = /^\s*(\d{1,3})(?:\.(\d{1,2}))?\s*%?\s*$/.exec(String(v ?? ''));
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp <= 10000 ? bp : null;
}
/** 6000 → "60", 3333 → "33.33", 1250 → "12.5". */
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
      out.jobs.push({ jobId: j.jobId, shareBp: bp });
    });
    const total = out.jobs.reduce((s, j) => s + j.shareBp, 0);
    if (total > 10000) errors.push(`the shares add up to ${bpToPercent(total)}%; they can't be more than 100%`);
  }
  return out;
}

async function saveTripJobs(c, companyId, tripId, jobs) {
  await c.query('DELETE FROM trip_jobs WHERE trip_id = $1', [tripId]);
  for (const j of jobs) await c.query('INSERT INTO trip_jobs (company_id, trip_id, job_id, share_bp) VALUES ($1,$2,$3,$4)', [companyId, tripId, j.jobId, j.shareBp]);
}

export async function createTrip(pool, companyId, input, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const errors = [];
    const v = await cleanTrip(c, companyId, input ?? {}, errors);
    if (v.endDate && v.startDate && v.endDate < v.startDate) errors.push('the end date is before the start date');
    if (errors.length) throw new LedgerError('Trip is not valid', errors);
    const { rows: [t] } = await c.query('INSERT INTO trips (company_id, name, start_date, end_date, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [companyId, v.name, v.startDate, v.endDate, v.notes, actor]);
    await saveTripJobs(c, companyId, t.id, v.jobs);
    await appendAudit(c, companyId, { action: 'create', entity: 'trip', entityId: t.id, actor, payload: v });
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
      for (const b of billed) if (!v.jobs.some((j) => j.jobId === b.job_id)) errors.push(`${b.name} has already billed part of this trip, so it stays on the list`);
    }
    if (errors.length) throw new LedgerError('Trip is not valid', errors);
    const cols = { name: 'name', startDate: 'start_date', endDate: 'end_date', notes: 'notes', isActive: 'is_active' };
    const sets = []; const vals = [companyId, tripId];
    for (const [k, col] of Object.entries(cols)) if (v[k] !== undefined) { vals.push(v[k]); sets.push(`${col} = $${vals.length}`); }
    if (sets.length) await c.query(`UPDATE trips SET ${sets.join(', ')} WHERE company_id = $1 AND id = $2`, vals);
    if (v.jobs) await saveTripJobs(c, companyId, tripId, v.jobs);
    await appendAudit(c, companyId, { action: 'update', entity: 'trip', entityId: tripId, actor, payload: v });
    return getTrip(c, companyId, tripId);
  });
}

export async function listTrips(db, companyId, { includeClosed = true } = {}) {
  const { rows } = await db.query(
    `SELECT t.id, t.name, to_char(t.start_date, 'YYYY-MM-DD') AS "startDate", to_char(t.end_date, 'YYYY-MM-DD') AS "endDate", t.is_active AS "isActive",
            COALESCE((SELECT sum(amount_cents) FROM trip_costs WHERE trip_id = t.id AND status = 'posted'), 0)::bigint AS "totalCents",
            (SELECT count(*) FROM trip_costs WHERE trip_id = t.id AND status = 'posted')::int AS "costCount",
            COALESCE((SELECT string_agg(coalesce(j.code, j.name) || ' ' || (tj.share_bp / 100.0)::numeric(6,2)::text || '%', ', ' ORDER BY tj.share_bp DESC, j.name)
                        FROM trip_jobs tj JOIN jobs j ON j.id = tj.job_id WHERE tj.trip_id = t.id), '') AS "projectsText"
       FROM trips t WHERE t.company_id = $1 AND (t.is_active OR $2) ORDER BY t.start_date DESC, t.created_at DESC LIMIT 500`, [companyId, includeClosed]);
  return rows.map((r) => ({ ...r, totalCents: Number(r.totalCents), projectsText: r.projectsText.replace(/\.00%/g, '%') }));
}

export async function getTrip(db, companyId, tripId) {
  const t = await getTripRow(db, companyId, tripId);
  const { rows: jobs } = await db.query(
    `SELECT tj.job_id AS "jobId", j.name AS "jobName", j.code AS "jobCode", c.name AS "customerName", tj.share_bp AS "shareBp"
       FROM trip_jobs tj JOIN jobs j ON j.id = tj.job_id LEFT JOIN contacts c ON c.id = j.customer_id
      WHERE tj.trip_id = $1 ORDER BY tj.share_bp DESC, lower(j.name)`, [t.id]);
  const { rows: costs } = await db.query(
    `SELECT tc.id, to_char(tc.cost_date, 'YYYY-MM-DD') AS date, tc.vendor, tc.description, tc.amount_cents AS "amountCents", tc.kind, tc.miles,
            tc.mile_rate_cents AS "mileRateCents",
            tc.expense_account_id AS "expenseAccountId", ea.name AS "expenseAccountName", tc.paid_from_account_id AS "paidFromAccountId", pa.name AS "paidFromName",
            tc.status, tc.replaced_by_id AS "replacedById", e.entry_number AS "entryNumber",
            (SELECT count(*) FROM trip_cost_photos p WHERE p.trip_cost_id = tc.id)::int AS "photoCount",
            COALESCE((SELECT json_agg(json_build_object('jobId', l.job_id, 'number', d.number)) FROM document_lines l JOIN documents d ON d.id = l.document_id
                       WHERE l.trip_cost_id = tc.id AND d.status = 'posted'), '[]') AS billed
       FROM trip_costs tc JOIN accounts ea ON ea.id = tc.expense_account_id JOIN accounts pa ON pa.id = tc.paid_from_account_id
       JOIN journal_entries e ON e.id = tc.journal_entry_id
      WHERE tc.trip_id = $1 ORDER BY tc.status, tc.cost_date, tc.created_at`, [t.id]);
  const { rows: time } = await db.query(
    `SELECT te.id, to_char(te.work_date, 'YYYY-MM-DD') AS date, te.minutes, te.notes, te.billable, te.status, u.name AS "userName",
            COALESCE((SELECT json_agg(json_build_object('jobId', l.job_id, 'number', d.number)) FROM document_lines l JOIN documents d ON d.id = l.document_id
                       WHERE l.time_entry_id = te.id AND d.status = 'posted'), '[]') AS billed
       FROM time_entries te JOIN users u ON u.id = te.user_id WHERE te.trip_id = $1 ORDER BY te.work_date, te.created_at`, [t.id]);
  const shareTotal = jobs.reduce((s, j) => s + j.shareBp, 0);
  const posted = costs.filter((x) => x.status === 'posted');
  return {
    id: t.id, name: t.name, startDate: t.start_date, endDate: t.end_date, notes: t.notes, isActive: t.is_active,
    jobs: jobs.map((j) => ({ ...j, share: bpToPercent(j.shareBp) })), sharePercent: bpToPercent(shareTotal),
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

export async function addTripCost(pool, companyId, tripId, input, { actor = null, idempotencyKey = null, costId = null, replacesId = null } = {}) {
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
      else amount = mileage.amountCents;
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
                               kind, miles, mile_rate_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, companyId, trip.id, date, vendor, description, amount, exp.id, from.id, je.id, idempotencyKey, actor, kind, mileage?.miles ?? null, mileage?.rateCentsText ?? null]);
    await appendAudit(c, companyId, { action: replacesId ? 'replace' : 'create', entity: 'trip_cost', entityId: id, actor,
      payload: { ...(replacesId ? { replacesId } : {}), tripId: trip.id, date, kind, vendor, description, amountCents: amount, ...(mileage ? { miles: mileage.miles, mileRateCents: mileage.rateCentsText } : {}), entryId: je.id } });
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
    const saved = await addTripCost(c, companyId, old.trip_id, input, { actor, idempotencyKey, costId: newId, replacesId: costId });
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
    await createTimeEntry(c, companyId, viewer, { ...input, jobId: null, tripId }, { actor });
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
