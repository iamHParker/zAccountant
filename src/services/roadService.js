// The Road page (Homer, 2026-10-25): trip costs, receipt photos, travel time and new project numbers jotted down on
// the phone while travelling, sent when there is signal, and reviewed at the desk.
//
// ℹ️ Why a separate "road key" instead of signing in on the phone: the key can do very little. It reads the names of
// open trips and projects (to pick from) and drops items into an inbox. It can't see the books, can't post anything,
// and can't change anything already saved. A lost phone costs nothing but a revoke. Accepting an item at the desk
// is what puts it in the books, through the same Trips code as a cost typed at the desk.
import { createHash } from 'node:crypto';
import qrcode from 'qrcode-generator';
import { withTransaction } from '../db/pool.js';
import { LedgerError, isIsoDate } from '../core/ledger.js';
import { toCents } from '../core/money.js';
import { parseDuration, parseClock, shiftMinutes, minutesToHours } from '../core/timesheets.js';
import { parseProjectFolder } from '../core/projects.js';
import { randomToken } from '../security/crypto.js';
import { appendAudit } from './audit.js';
import { readPicture } from './feedbackService.js';
import { createTimeEntry } from './timesheetService.js';
import { receiptReadingOn } from './receiptReader.js';
import { addPurchase, PURCHASE_CATEGORIES } from './purchaseService.js';
import { createTrip, addTripCost, addBooking, listBookings, cleanBooking, COST_KINDS, BOOKING_KINDS, mileageAmount, MAX_PHOTO_BYTES, MAX_PHOTOS_PER_COST } from './tripService.js';

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => typeof v === 'string' && UUIDISH.test(v);
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const text = (v, max) => (v == null || v === '' ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || null); // eslint-disable-line no-control-regex
const hashKey = (token) => createHash('sha256').update(token).digest('hex');
const KEY_DAYS = 90;
const MAX_KEYS = 5;
const MAX_TRIP_PROJECTS = 20;

async function lockCompany(c, companyId) {
  await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
}

// ---------------------------------------------------------------- Road keys (made and revoked at the desk)

/** A QR code (SVG) for the phone's camera. */
export function qrSvg(textToEncode) {
  const q = qrcode(0, 'M');
  q.addData(textToEncode);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

/**
 * A new road key for this person in this company. The key itself is returned once, inside the link
 * (after the #, so it never reaches a server log) and as a QR code; only its hash is kept.
 */
export async function createRoadKey(db, companyId, userId, { name }, { origin, actor = null }) {
  const label = text(name, 100);
  if (!label || label.length > 60) throw new LedgerError('Name the phone this key is for (for example "Homer\'s iPhone"), at most 60 characters');
  return withTransaction(db, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [{ n }] } = await c.query(
      'SELECT count(*)::int AS n FROM road_keys WHERE company_id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()', [companyId, userId]);
    if (n >= MAX_KEYS) throw new LedgerError(`You can have at most ${MAX_KEYS} road keys working at once. Turn one off first.`);
    const token = `zr_${randomToken(32)}`;
    const { rows: [k] } = await c.query(
      `INSERT INTO road_keys (company_id, user_id, token_hash, name, expires_at) VALUES ($1,$2,$3,$4, now() + interval '${KEY_DAYS} days')
       RETURNING id, name, to_char(expires_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS "expiresOn"`,
      [companyId, userId, hashKey(token), label]);
    await appendAudit(c, companyId, { action: 'create', entity: 'road_key', entityId: k.id, actor, payload: { name: label } });
    const url = `${origin}/road#key=${token}`;
    return { ...k, url, qrSvg: qrSvg(url) };
  });
}

export async function listRoadKeys(db, companyId, userId) {
  const { rows } = await db.query(
    `SELECT id, name, to_char(created_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS "createdOn",
            to_char(expires_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS "expiresOn",
            to_char(last_used_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS "lastUsedOn", expires_at <= now() AS expired
       FROM road_keys WHERE company_id = $1 AND user_id = $2 AND revoked_at IS NULL ORDER BY created_at`, [companyId, userId]);
  return rows;
}

export async function revokeRoadKey(db, companyId, userId, keyId, { actor = null } = {}) {
  if (!isId(keyId)) throw new LedgerError('Road key not found');
  return withTransaction(db, async (c) => {
    await lockCompany(c, companyId);
    const { rowCount } = await c.query(
      'UPDATE road_keys SET revoked_at = now() WHERE company_id = $1 AND user_id = $2 AND id = $3 AND revoked_at IS NULL', [companyId, userId, keyId]);
    if (!rowCount) throw new LedgerError('Road key not found');
    await appendAudit(c, companyId, { action: 'revoke', entity: 'road_key', entityId: keyId, actor, payload: {} });
    return { revoked: true };
  });
}

// ---------------------------------------------------------------- The phone's side

/** The key the phone sent (Authorization: Bearer zr_…), if it still works: { id, companyId, userId, name }. */
export async function findRoadKey(pool, token) {
  if (typeof token !== 'string' || !/^zr_[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const { rows: [k] } = await pool.query(
    `UPDATE road_keys SET last_used_at = now() WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
     RETURNING id, company_id AS "companyId", user_id AS "userId", name, to_char(expires_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS "expiresOn"`,
    [hashKey(token)]);
  return k ?? null;
}

/**
 * What the phone may see: the company and person's names, open trips and active projects (names only), and the
 * bookings on those open trips (Homer, 2026-11-06: the trip's plan, its flight, hotel and rental car with their
 * confirmation numbers, is what the traveller needs on the road). No amounts paid, no accounts, nothing else.
 */
export async function roadSummary(db, key) {
  const { rows: [who] } = await db.query(
    `SELECT c.name AS company, u.name AS "user", to_char(now() AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS today
       FROM companies c, users u WHERE c.id = $1 AND u.id = $2`, [key.companyId, key.userId]);
  // fromClientId: a trip this phone sent, so the phone knows its own trip once it is accepted at the desk.
  const { rows: trips } = await db.query(
    `SELECT t.id, t.name, to_char(t.start_date, 'YYYY-MM-DD') AS "startDate", to_char(t.end_date, 'YYYY-MM-DD') AS "endDate",
            (SELECT i.client_id FROM road_items i WHERE i.key_id = $2 AND i.kind = 'trip' AND i.trip_id = t.id LIMIT 1) AS "fromClientId"
       FROM trips t WHERE t.company_id = $1 AND t.is_active ORDER BY t.start_date DESC LIMIT 50`, [key.companyId, key.id]);
  const { rows: projects } = await db.query(
    'SELECT id, code, name FROM jobs WHERE company_id = $1 AND is_active ORDER BY code NULLS LAST, name LIMIT 3000', [key.companyId]);
  const all = await listBookings(db, key.companyId, trips.map((t) => t.id));
  const { rows: sent } = all.length ? await db.query(
    "SELECT client_id, trip_booking_id FROM road_items WHERE key_id = $1 AND kind = 'booking' AND trip_booking_id = ANY($2::uuid[])", [key.id, all.map((b) => b.id)]) : { rows: [] };
  const fromItem = new Map(sent.map((r) => [r.trip_booking_id, r.client_id]));
  const bookings = all.map(({ paidCents, tripCostId, ...b }) => ({ ...b, paid: Boolean(tripCostId), fromClientId: fromItem.get(b.id) ?? null }));
  return { ...who, keyName: key.name, expiresOn: key.expiresOn, trips, projects, bookings, costKinds: COST_KINDS, bookingKinds: BOOKING_KINDS, receiptReading: receiptReadingOn() };
}

/** A booking named by a cost ("Paid: record the cost"): { id } of a saved booking, or { clientId } of one sent from this phone. */
async function bookingRef(db, key, ref) {
  if (ref && isId(ref.id)) {
    const { rows: [b] } = await db.query('SELECT id FROM trip_bookings WHERE company_id = $1 AND id = $2', [key.companyId, ref.id]);
    return b ? { id: b.id } : null;
  }
  if (ref && typeof ref.clientId === 'string' && CLIENT_ID.test(ref.clientId)) {
    const { rows: [b] } = await db.query("SELECT 1 FROM road_items WHERE key_id = $1 AND client_id = $2 AND kind = 'booking'", [key.id, ref.clientId]);
    return b ? { clientId: ref.clientId } : null;
  }
  return null;
}

/** A trip named by an item: { id } of a saved trip, or { clientId } of a trip sent from this phone. */
async function tripRef(db, key, ref, errors) {
  if (ref && isId(ref.id)) {
    const { rows: [t] } = await db.query('SELECT id FROM trips WHERE company_id = $1 AND id = $2', [key.companyId, ref.id]);
    if (t) return { id: t.id };
  } else if (ref && typeof ref.clientId === 'string' && CLIENT_ID.test(ref.clientId)) {
    const { rows: [t] } = await db.query("SELECT 1 FROM road_items WHERE key_id = $1 AND client_id = $2 AND kind = 'trip'", [key.id, ref.clientId]);
    if (t) return { clientId: ref.clientId };
    errors.push('send the trip before its costs');
    return null;
  }
  errors.push('choose the trip');
  return null;
}

// ---------------------------------------------------------------- Time in blocks (Homer, 2026-11-06; migration 042)
export const BLOCK_TYPES = { travel: 'Travel', site: 'Site', office: 'Office / drafting' };
const clockMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const clockOf = (min) => `${String(Math.floor((min % 1440) / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * A travel block shared by two projects: the first project's percent of the minutes, rounded half up, the rest to the
 * second (50% of 61 → 31 + 30; 70% of 10 → 7 + 3; Homer, 2026-11-07). With a start time the first part ends where the
 * second starts, so the day still reads 7:00-7:31 then 7:31-8:01 exactly.
 */
export function splitBlock(minutes, start = null, percent = 50) {
  const first = Math.floor((minutes * percent + 50) / 100), second = minutes - first;
  if (!start) return [{ minutes: first, start: null, end: null }, { minutes: second, start: null, end: null }];
  const s0 = clockMinutes(start);
  return [{ minutes: first, start, end: clockOf(s0 + first) }, { minutes: second, start: clockOf(s0 + first), end: clockOf(s0 + minutes) }];
}

async function activeJob(db, companyId, id) {
  if (!isId(id)) return null;
  const { rows: [j] } = await db.query('SELECT id FROM jobs WHERE company_id = $1 AND id = $2 AND is_active', [companyId, id]);
  return j?.id ?? null;
}

async function cleanItem(db, key, kind, d) {
  const errors = [];
  let out;
  if (kind === 'trip') {
    out = { name: text(d.name, 200), startDate: d.startDate, endDate: d.endDate || null, notes: text(d.notes, 500) };
    if (!out.name || out.name.length > 120) errors.push('give the trip a name (up to 120 characters)');
    if (!isIsoDate(out.startDate)) errors.push('the start date must be a real date');
    if (out.endDate && (!isIsoDate(out.endDate) || out.endDate < out.startDate)) errors.push('the end date must be a real date, on or after the start');
    const ids = Array.isArray(d.jobIds) ? d.jobIds.filter(isId) : [];
    const typed = Array.isArray(d.newProjects) ? d.newProjects : [];
    if (ids.length + typed.length > MAX_TRIP_PROJECTS) errors.push(`list at most ${MAX_TRIP_PROJECTS} projects`);
    const { rows: found } = ids.length ? await db.query('SELECT id FROM jobs WHERE company_id = $1 AND id = ANY($2::uuid[])', [key.companyId, ids]) : { rows: [] };
    out.jobIds = [...new Set(found.map((j) => j.id))];
    out.newProjects = typed.slice(0, MAX_TRIP_PROJECTS).map((p) => parseProjectFolder(String(p ?? '').slice(0, 200))).filter(Boolean);
  } else if (kind === 'cost' || kind === 'time') {
    out = { trip: await tripRef(db, key, d.trip, errors), date: d.date };
    if (!isIsoDate(out.date)) errors.push('the date must be a real date');
    if (kind === 'cost') {
      out.kind = COST_KINDS[d.kind] ? d.kind : 'other';
      out.vendor = text(d.vendor, 120);
      out.description = text(d.description, 300) ?? (out.kind !== 'other' ? COST_KINDS[out.kind] : null);
      // Paying for a booking sent or seen on the phone: the cost is linked to it when accepted.
      const booking = await bookingRef(db, key, d.booking);
      if (booking) out.booking = booking;
      if (!out.description) errors.push('say what it was');
      if (out.kind === 'mileage') {
        const m = mileageAmount(d.miles, d.mileRate);
        if (!m) errors.push('enter the miles (like 212.4) and the rate per mile (like 0.70)');
        else Object.assign(out, { miles: String(d.miles).trim(), mileRate: String(d.mileRate).trim(), amountCents: m.amountCents });
      } else {
        let c = null;
        try { c = toCents(String(d.amount ?? '')); } catch { /* reported below */ }
        if (c == null || c <= 0) errors.push('the amount must be a dollar amount over $0.00');
        else out.amountCents = c;
      }
    } else {
      // The hours, or the start and end times less breaks (worked out again here, not trusted from the phone).
      let minutes = null;
      if (d.start || d.end) {
        const start = parseClock(d.start), end = parseClock(d.end);
        const off = String(d.breaks ?? '').trim() ? parseDuration(d.breaks) : 0;
        if (!start || !end) errors.push('the start and end must be times like 7:30 AM');
        else if (off == null) errors.push('breaks must be like 0:45 or 1:30');
        else Object.assign(out, { start, end, breakMinutes: off }), minutes = shiftMinutes(start, end) - off;
      } else minutes = parseDuration(d.hours);
      if (minutes == null || minutes <= 0 || minutes > 24 * 60) { if (!errors.length) errors.push('hours must be like 3.5 or 3:30'); }
      out.minutes = minutes;
      out.notes = text(d.notes, 300);
    }
  } else if (kind === 'booking') {
    // A flight, hotel or rental car booked for the trip (Homer, 2026-11-06). Not money: a plan, put on the trip at the desk.
    out = { trip: await tripRef(db, key, d.trip, errors), ...cleanBooking(d, errors) };
  } else if (kind === 'block') {
    // One block of a day: travel, site time, or office/drafting, from a start to an end time (or hours), on a project.
    out = { date: d.date, type: BLOCK_TYPES[d.type] ? d.type : null, notes: text(d.notes, 300), jobId: null };
    if (!out.type) errors.push('choose travel, site or office');
    if (!isIsoDate(out.date)) errors.push('the date must be a real date');
    let minutes = null;
    if (d.start || d.end) {
      const start = parseClock(d.start), end = parseClock(d.end);
      if (!start || !end) errors.push('the start and end must be times like 7:30 AM');
      else Object.assign(out, { start, end }), minutes = shiftMinutes(start, end);
    } else minutes = parseDuration(d.hours);
    if (minutes == null || minutes <= 0 || minutes > 24 * 60) { if (!errors.length) errors.push('type the start and end, or hours like 1.5'); }
    out.minutes = minutes;
    // Travel may go on a trip (its projects share it) instead of projects.
    if (out.type === 'travel' && d.trip) out.trip = await tripRef(db, key, d.trip, errors);
    if (!out.trip) {
      out.jobId = await activeJob(db, key.companyId, d.jobId);
      if (d.jobId && !out.jobId) errors.push('that project is closed or gone');
      if (out.type === 'travel' && d.splitJobId) {
        out.splitJobId = await activeJob(db, key.companyId, d.splitJobId);
        if (!out.splitJobId) errors.push('the project to split with is closed or gone');
        else if (out.splitJobId === out.jobId) errors.push('split it with a different project');
        else if (!out.jobId) errors.push('choose the first project too');
        const pct = d.splitPercent == null || d.splitPercent === '' ? 50 : Number(d.splitPercent);
        if (!Number.isInteger(pct) || pct < 1 || pct > 99) errors.push('the first project\'s share must be a whole percent from 1 to 99');
        else out.splitPercent = pct;
      }
      if (out.type !== 'office' && !out.jobId) errors.push(out.type === 'travel' ? 'choose the project (or the trip) the travel is for' : 'choose the project');
    }
  } else if (kind === 'purchase') {
    // Equipment or supplies bought, not on a trip (Homer, 2026-11-06): batteries and markers for a job, a laser level.
    out = { date: d.date, category: PURCHASE_CATEGORIES[d.category] ? d.category : null, vendor: text(d.vendor, 120),
      description: text(d.description, 300), jobId: null };
    if (!out.category) errors.push('say whether it is equipment or supplies');
    out.description ??= out.category ? PURCHASE_CATEGORIES[out.category] : null;
    if (out.category === 'equipment') out.serialNumber = text(d.serialNumber, 60);
    if (!isIsoDate(out.date)) errors.push('the date must be a real date');
    let c = null;
    try { c = toCents(String(d.amount ?? '')); } catch { /* reported below */ }
    if (c == null || c <= 0) errors.push('the amount must be a dollar amount over $0.00');
    else out.amountCents = c;
    if (isId(d.jobId)) {
      const { rows: [j] } = await db.query('SELECT id FROM jobs WHERE company_id = $1 AND id = $2', [key.companyId, d.jobId]);
      out.jobId = j?.id ?? null;
    }
  } else if (kind === 'check') {
    // A check received (Homer, 2026-10-26): who paid, how much, its number and the invoice numbers it pays.
    out = { date: d.date, from: text(d.from, 120), checkNumber: text(d.checkNumber, 30), invoices: text(d.invoices, 200), notes: text(d.notes, 300) };
    if (!isIsoDate(out.date)) errors.push('the date must be a real date');
    let c = null;
    try { c = toCents(String(d.amount ?? '')); } catch { /* reported below */ }
    if (c == null || c <= 0) errors.push('the amount must be a dollar amount over $0.00');
    else out.amountCents = c;
    if (!out.from && !out.invoices) errors.push('say who paid or which invoice it pays');
  } else errors.push('unknown kind of item');
  if (errors.length) throw new LedgerError('That item is not valid', errors);
  return out;
}

/** An item from the phone. Sending the same item again (same clientId) changes nothing and says so. */
export async function receiveItem(db, key, { clientId, kind, data }) {
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) throw new LedgerError('The item has no id');
  const { rows: [had] } = await db.query('SELECT status FROM road_items WHERE key_id = $1 AND client_id = $2', [key.id, clientId]);
  if (had) return { clientId, status: had.status, duplicate: true };
  const clean = await cleanItem(db, key, kind, data && typeof data === 'object' ? data : {});
  await db.query(
    `INSERT INTO road_items (company_id, key_id, user_id, client_id, kind, data) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (key_id, client_id) DO NOTHING`, [key.companyId, key.id, key.userId, clientId, kind, JSON.stringify(clean)]);
  return { clientId, status: 'pending', duplicate: false };
}

/**
 * A sent item changed on the phone (Homer, 2026-10-28: a travel day sent with the wrong date). Only while it waits in
 * the inbox: once accepted it is in the books, and the key can't change the books, so it is fixed at the desk.
 * The new data is checked again exactly like a new item; the kind can't change.
 */
export async function editItem(db, key, clientId, { data }) {
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) throw new LedgerError('The item has no id');
  const { rows: [item] } = await db.query('SELECT id, kind, status FROM road_items WHERE key_id = $1 AND client_id = $2 FOR UPDATE', [key.id, clientId]);
  if (!item) throw new LedgerError('Send the item before changing it');
  if (item.status !== 'pending') {
    throw new LedgerError(item.status === 'accepted' ? 'That is already in the books; change it at your desk' : 'That was dismissed at the desk');
  }
  const clean = await cleanItem(db, key, item.kind, data && typeof data === 'object' ? data : {});
  await db.query('UPDATE road_items SET data = $2 WHERE id = $1', [item.id, JSON.stringify(clean)]);
  return { clientId, status: 'pending' };
}

/** A receipt photo for a cost sent from this phone (before it is reviewed). */
export async function receivePhoto(db, key, itemClientId, { clientId, picture }) {
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) throw new LedgerError('The photo has no id');
  const p = readPicture(picture);
  if (!p) throw new LedgerError('Choose a photo');
  if (p.bytes.length > MAX_PHOTO_BYTES) throw new LedgerError('The photo is too large (3 MB at most)');
  const { rows: [item] } = typeof itemClientId === 'string' ? await db.query(
    'SELECT id, kind, status FROM road_items WHERE key_id = $1 AND client_id = $2 FOR UPDATE', [key.id, itemClientId]) : { rows: [] };
  if (!item || !['cost', 'check', 'purchase'].includes(item.kind)) throw new LedgerError('Send the cost before its photos');
  const { rows: [had] } = await db.query('SELECT 1 FROM road_photos WHERE item_id = $1 AND client_id = $2', [item.id, clientId]);
  if (had) return { clientId, duplicate: true };
  if (item.status !== 'pending') throw new LedgerError(`That ${item.kind} was already reviewed at the desk; add the photo there`);
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM road_photos WHERE item_id = $1', [item.id]);
  if (n >= MAX_PHOTOS_PER_COST) throw new LedgerError(`A ${item.kind} can have at most ${MAX_PHOTOS_PER_COST} photos`);
  await db.query('INSERT INTO road_photos (company_id, item_id, client_id, picture, picture_type) VALUES ($1,$2,$3,$4,$5)',
    [key.companyId, item.id, clientId, p.bytes, p.type]);
  return { clientId, duplicate: false };
}

/** Which of this phone's items have been reviewed at the desk (so the phone can say "in the books"). */
export async function itemStatuses(db, key, clientIds) {
  const ids = (Array.isArray(clientIds) ? clientIds : []).filter((c) => typeof c === 'string' && CLIENT_ID.test(c)).slice(0, 500);
  if (!ids.length) return [];
  const { rows } = await db.query('SELECT client_id AS "clientId", status FROM road_items WHERE key_id = $1 AND client_id = ANY($2::text[])', [key.id, ids]);
  return rows;
}

// ---------------------------------------------------------------- Review at the desk

/** Items waiting for review (or all recent ones), with the trip each belongs to and its photos. */
export async function listRoadItems(db, companyId, { status = 'pending' } = {}) {
  const { rows } = await db.query(
    `SELECT i.id, i.kind, i.client_id AS "clientId", i.key_id AS "keyId", i.data, i.status, i.trip_id AS "tripId", i.trip_cost_id AS "tripCostId",
            i.payment_id AS "paymentId", i.received_at AS "receivedAt", u.name AS "userName", k.name AS "keyName",
            coalesce((SELECT json_agg(p.id ORDER BY p.created_at) FROM road_photos p WHERE p.item_id = i.id), '[]') AS photos
       FROM road_items i JOIN users u ON u.id = i.user_id JOIN road_keys k ON k.id = i.key_id
      WHERE i.company_id = $1 AND ($2::text = 'all' OR i.status = $2)
      ORDER BY i.received_at, i.id LIMIT 500`, [companyId, status === 'all' ? 'all' : 'pending']);
  // Name each item's trip: a saved trip by id, or the trip item it came with (and the trip that item became).
  const tripIds = [...new Set(rows.flatMap((r) => [r.data.trip?.id, r.tripId]).filter(isId))];
  const { rows: trips } = tripIds.length ? await db.query('SELECT id, name FROM trips WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, tripIds]) : { rows: [] };
  const tripName = new Map(trips.map((t) => [t.id, t.name]));
  const refs = rows.filter((r) => r.data.trip?.clientId).map((r) => [r.keyId, r.data.trip.clientId]);
  const { rows: tripItems } = refs.length ? await db.query(
    `SELECT key_id AS "keyId", client_id AS "clientId", data->>'name' AS name, status, trip_id AS "tripId" FROM road_items
      WHERE company_id = $1 AND kind = 'trip' AND (key_id, client_id) IN (SELECT * FROM unnest($2::uuid[], $3::text[]))`,
    [companyId, refs.map((r) => r[0]), refs.map((r) => r[1])]) : { rows: [] };
  const byRef = new Map(tripItems.map((t) => [`${t.keyId}:${t.clientId}`, t]));
  const { rows: tripNames } = tripItems.some((t) => t.tripId) ? await db.query(
    'SELECT id, name FROM trips WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, tripItems.map((t) => t.tripId).filter(Boolean)]) : { rows: [] };
  for (const t of tripNames) tripName.set(t.id, t.name);
  // A check names invoice numbers as typed ("26-124, 26-130"): the unpaid invoices with those numbers.
  const typed = (r) => (r.data.invoices ?? '').split(/[\s,;&]+|\band\b/i).map((s) => s.replace(/^#/, '').trim().toLowerCase()).filter(Boolean);
  const wanted = [...new Set(rows.filter((r) => r.kind === 'check').flatMap(typed))];
  const { rows: invs } = wanted.length ? await db.query(
    `SELECT d.id, d.number, d.contact_id AS "contactId", ct.name AS "contactName", d.total_cents - COALESCE((SELECT sum(a.amount_cents)
            FROM payment_applications a JOIN payments p ON p.id = a.payment_id WHERE a.document_id = d.id AND p.status = 'posted'), 0)::bigint AS "balanceCents"
       FROM documents d JOIN contacts ct ON ct.id = d.contact_id
      WHERE d.company_id = $1 AND d.kind = 'invoice' AND d.status <> 'void' AND d.replaced_by_id IS NULL AND lower(d.number) = ANY($2::text[])`,
    [companyId, wanted]) : { rows: [] };
  return rows.map(({ keyId, ...r }) => {
    if (r.kind === 'check') {
      const nums = typed(r);
      return { ...r, trip: null, hours: null, invoices: invs.filter((i) => nums.includes(i.number.toLowerCase())).map((i) => ({ ...i, balanceCents: Number(i.balanceCents) })) };
    }
    let trip = null;
    if (r.kind === 'trip') trip = { name: r.data.name, tripId: r.tripId, fromRoad: true };
    else if (r.data.trip?.id) trip = { name: tripName.get(r.data.trip.id) ?? 'a trip', tripId: r.data.trip.id, fromRoad: false };
    else if (r.data.trip?.clientId) {
      const t = byRef.get(`${keyId}:${r.data.trip.clientId}`);
      trip = { name: t?.tripId ? tripName.get(t.tripId) ?? t.name : t?.name ?? 'a trip', tripId: t?.tripId ?? null, fromRoad: true, tripStatus: t?.status ?? null };
    }
    return { ...r, trip, hours: r.data.minutes != null ? minutesToHours(r.data.minutes) : null };
  });
}

export async function getRoadPhoto(db, companyId, itemId, photoId) {
  if (!isId(itemId) || !isId(photoId)) throw new LedgerError('Photo not found');
  const { rows: [p] } = await db.query('SELECT picture, picture_type FROM road_photos WHERE company_id = $1 AND item_id = $2 AND id = $3', [companyId, itemId, photoId]);
  if (!p) throw new LedgerError('Photo not found');
  return { name: `receipt.${p.picture_type === 'image/png' ? 'png' : 'jpg'}`, type: p.picture_type, body: p.picture, inline: true };
}

async function lockItem(c, companyId, itemId) {
  if (!isId(itemId)) throw new LedgerError('Item not found');
  const { rows: [i] } = await c.query('SELECT * FROM road_items WHERE company_id = $1 AND id = $2 FOR UPDATE', [companyId, itemId]);
  if (!i) throw new LedgerError('Item not found');
  if (i.status !== 'pending') throw new LedgerError(`That item was already ${i.status}`);
  return i;
}

/**
 * The item's data with changes typed at the desk (Trips → the trip's grid → Edit, Homer 2026-10-30), checked again
 * exactly like an item from the phone. The trip it names and its kind stay; amounts are typed in dollars.
 */
async function deskData(c, companyId, item, changes) {
  const d = item.data;
  const base = item.kind === 'block'
    ? { ...d, hours: d.start ? '' : `${Math.floor(d.minutes / 60)}:${String(d.minutes % 60).padStart(2, '0')}` }
    : item.kind === 'cost' || item.kind === 'booking' || item.kind === 'purchase'
    ? { ...d, amount: d.amountCents != null ? (d.amountCents / 100).toFixed(2) : '' }
    : item.kind === 'time'
      ? { ...d, hours: `${Math.floor(d.minutes / 60)}:${String(d.minutes % 60).padStart(2, '0')}`,
        breaks: d.breakMinutes ? `${Math.floor(d.breakMinutes / 60)}:${String(d.breakMinutes % 60).padStart(2, '0')}` : '' }
      : { ...d };
  const merged = { ...base, ...changes, trip: d.trip };
  if (item.kind === 'block' && changes.hours !== undefined && !changes.start && !changes.end) { delete merged.start; delete merged.end; }
  if (item.kind === 'time' && changes.hours !== undefined && !changes.start && !changes.end) { delete merged.start; delete merged.end; }
  return cleanItem(c, { id: item.key_id, companyId }, item.kind, merged);
}

/** Change an item still waiting in the inbox, at the desk. It is not in the books until accepted. */
export async function editRoadItem(db, companyId, itemId, { data } = {}, { actor = null } = {}) {
  return withTransaction(db, async (c) => {
    await lockCompany(c, companyId);
    const item = await lockItem(c, companyId, itemId);
    if (item.kind === 'check') throw new LedgerError('Change a check when you record it as a payment');
    const clean = await deskData(c, companyId, item, data && typeof data === 'object' ? data : {});
    await c.query('UPDATE road_items SET data = $2 WHERE id = $1', [item.id, JSON.stringify(clean)]);
    await appendAudit(c, companyId, { action: 'edit', entity: 'road_item', entityId: item.id, actor, payload: { kind: item.kind, from: item.data, to: clean } });
    return { id: item.id, kind: item.kind, data: clean, status: 'pending' };
  });
}

/** The trip a cost or travel time goes on: the one chosen at the desk, else the one named on the phone. */
async function tripFor(c, companyId, item, chosen) {
  if (chosen) {
    if (!isId(chosen)) throw new LedgerError('Trip not found');
    return chosen;
  }
  if (item.data.trip?.id) return item.data.trip.id;
  const { rows: [t] } = await c.query(
    "SELECT status, trip_id FROM road_items WHERE key_id = $1 AND client_id = $2 AND kind = 'trip'", [item.key_id, item.data.trip?.clientId]);
  if (t?.trip_id) return t.trip_id;
  throw new LedgerError(t?.status === 'dismissed' ? 'Its trip was dismissed; choose a trip for it' : 'Accept its trip first (above), or choose a trip for it');
}

/**
 * The booking a cost from the road paid for, if it is on the same trip and not paid yet; otherwise none (the cost
 * still goes in, just not linked: a booking still waiting in the inbox, or one already paid at the desk).
 */
async function paidBooking(c, companyId, item, tripId) {
  const ref = item.data.booking;
  let id = ref?.id ?? null;
  if (!id && ref?.clientId) {
    const { rows: [b] } = await c.query("SELECT trip_booking_id FROM road_items WHERE key_id = $1 AND client_id = $2 AND kind = 'booking'", [item.key_id, ref.clientId]);
    id = b?.trip_booking_id ?? null;
  }
  if (!id) return null;
  const { rows: [b] } = await c.query(
    `SELECT b.id FROM trip_bookings b LEFT JOIN trip_costs tc ON tc.id = b.trip_cost_id
      WHERE b.company_id = $1 AND b.id = $2 AND b.trip_id = $3 AND (b.trip_cost_id IS NULL OR tc.status = 'void')`, [companyId, id, tripId]);
  return b?.id ?? null;
}

/** Split 100% evenly in hundredths of a percent; any leftover hundredths go to the first projects (3 → 33.34, 33.33, 33.33). */
export function evenShares(n) {
  if (n <= 0) return [];
  const base = Math.floor(10000 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 10000 - base * n ? 1 : 0));
}

/**
 * Accept an item into the books, in one transaction:
 *   trip → new project numbers become projects (an existing project with the same name or number is used instead),
 *          and the trip is made with the projects sharing it evenly (change the shares on the trip afterwards);
 *   cost → a trip cost (input: expenseAccountId, paidFromAccountId; optional tripId), with its receipt photos;
 *   time → travel time for the person who sent it;
 *   booking → a booking on the trip (not in the books; nothing to choose);
 *   purchase → equipment or supplies (input: accountId, else the usual one; paidFromAccountId), with its photos;
 *   block → time on its project (two halves for split travel), or travel time on its trip.
 */
export async function acceptRoadItem(db, companyId, viewer, itemId, input = {}, { actor = null } = {}) {
  return withTransaction(db, async (c) => {
    await lockCompany(c, companyId);
    const item = await lockItem(c, companyId, itemId);
    if (item.kind === 'check') throw new LedgerError('Record a check as a payment: Sales → Checks from the road');
    // Changes typed at the desk go in with it ("Save to books").
    if (input.data && typeof input.data === 'object') {
      const clean = await deskData(c, companyId, item, input.data);
      await c.query('UPDATE road_items SET data = $2 WHERE id = $1', [item.id, JSON.stringify(clean)]);
      await appendAudit(c, companyId, { action: 'edit', entity: 'road_item', entityId: item.id, actor, payload: { kind: item.kind, from: item.data, to: clean } });
      item.data = clean;
    }
    const d = item.data;
    const done = async (cols) => {
      const sets = Object.keys(cols).map((k, i) => `${k} = $${i + 3}`).join(', ');
      await c.query(`UPDATE road_items SET status = 'accepted', reviewed_by = $2, reviewed_at = now()${sets ? `, ${sets}` : ''} WHERE id = $1`,
        [item.id, actor, ...Object.values(cols)]);
      await appendAudit(c, companyId, { action: 'accept', entity: 'road_item', entityId: item.id, actor, payload: { kind: item.kind, ...cols } });
    };
    if (item.kind === 'trip') {
      const jobIds = [...d.jobIds];
      for (const p of d.newProjects ?? []) {
        const { rows: [have] } = await c.query(
          'SELECT id FROM jobs WHERE company_id = $1 AND (lower(trim(name)) = lower($2) OR (code IS NOT NULL AND code = $3)) ORDER BY is_active DESC LIMIT 1',
          [companyId, p.name, p.code]);
        const id = have?.id ?? (await c.query('INSERT INTO jobs (company_id, name, code) VALUES ($1,$2,$3) RETURNING id', [companyId, p.name, p.code])).rows[0].id;
        if (!jobIds.includes(id)) jobIds.push(id);
      }
      const shares = evenShares(jobIds.length);
      const trip = await createTrip(c, companyId, { name: d.name, startDate: d.startDate, endDate: d.endDate, notes: d.notes,
        jobs: jobIds.map((jobId, i) => ({ jobId, share: (shares[i] / 100).toFixed(2) })) }, { actor });
      await done({ trip_id: trip.id });
      return { accepted: true, tripId: trip.id };
    }
    if (item.kind === 'purchase') {
      // Equipment or supplies: posted to the account chosen at the desk (else the usual one for its kind), photos kept.
      const r = await addPurchase(c, companyId, { date: d.date, category: d.category, vendor: d.vendor, description: d.description,
        serialNumber: d.serialNumber, amountCents: d.amountCents, jobId: d.jobId, accountId: input.accountId, paidFromAccountId: input.paidFromAccountId },
      { actor, idempotencyKey: `road-${item.id}` });
      await c.query(
        `INSERT INTO purchase_photos (company_id, purchase_id, picture, picture_type, created_by)
         SELECT company_id, $2, picture, picture_type, $3 FROM road_photos WHERE item_id = $1 ORDER BY created_at, id`, [item.id, r.id, actor]);
      await done({ purchase_id: r.id });
      return { accepted: true, purchaseId: r.id };
    }
    if (item.kind === 'block' && !d.trip) {
      // Time on projects: one time entry, or two parts for travel split between two projects (by its percent).
      const label = `${BLOCK_TYPES[d.type]}${d.notes ? ': ' + d.notes : ''}`;
      const pct = d.splitPercent ?? 50;
      const tag = pct === 50 ? '(split)' : `(split ${pct}/${100 - pct})`;
      const parts = d.splitJobId
        ? splitBlock(d.minutes, d.start ?? null, pct).map((x, n) => ({ ...x, jobId: n ? d.splitJobId : d.jobId, notes: `${label} ${tag}` })).filter((x) => x.minutes > 0)
        : [{ minutes: d.minutes, start: d.start ?? null, end: d.end ?? null, jobId: d.jobId, notes: label }];
      const ids = [];
      for (const x of parts) {
        const hm = `${Math.floor(x.minutes / 60)}:${String(x.minutes % 60).padStart(2, '0')}`;
        const t = await createTimeEntry(c, companyId, viewer,
          { userId: item.user_id, date: d.date, hours: hm, start: x.start, end: x.end, notes: x.notes, jobId: x.jobId, tripId: null }, { actor });
        ids.push(t.id);
      }
      await done({ time_entry_id: ids[0] });
      if (ids.length > 1) await appendAudit(c, companyId, { action: 'split', entity: 'road_item', entityId: item.id, actor, payload: { timeEntryIds: ids } });
      return { accepted: true, timeEntryIds: ids };
    }
    const tripId = await tripFor(c, companyId, item, input.tripId || null);
    if (item.kind === 'booking') {
      const { trip, amountCents, ...b } = d;
      const r = await addBooking(c, companyId, tripId, { ...b, amount: amountCents != null ? (amountCents / 100).toFixed(2) : null }, { actor });
      await done({ trip_booking_id: r.bookingId, trip_id: tripId });
      return { accepted: true, tripId, bookingId: r.bookingId };
    }
    if (item.kind === 'cost') {
      const bookingId = await paidBooking(c, companyId, item, tripId);
      const r = await addTripCost(c, companyId, tripId, {
        date: d.date, kind: d.kind, vendor: d.vendor, description: d.description, miles: d.miles, mileRate: d.mileRate,
        amount: d.amountCents != null ? (d.amountCents / 100).toFixed(2) : undefined,
        expenseAccountId: input.expenseAccountId, paidFromAccountId: input.paidFromAccountId, bookingId,
      }, { actor, idempotencyKey: `road-${item.id}` });
      await c.query(
        `INSERT INTO trip_cost_photos (company_id, trip_cost_id, picture, picture_type, created_by)
         SELECT company_id, $2, picture, picture_type, $3 FROM road_photos WHERE item_id = $1 ORDER BY created_at, id`, [item.id, r.costId, actor]);
      await done({ trip_cost_id: r.costId, trip_id: tripId });
      return { accepted: true, tripId, costId: r.costId };
    }
    const t = await createTimeEntry(c, companyId, viewer,
      { userId: item.user_id, date: d.date, hours: `${Math.floor(d.minutes / 60)}:${String(d.minutes % 60).padStart(2, '0')}`, start: d.start, end: d.end,
        notes: item.kind === 'block' ? `Travel${d.notes ? ': ' + d.notes : ''}` : d.notes, tripId, jobId: null }, { actor });
    await done({ time_entry_id: t.id, trip_id: tripId });
    return { accepted: true, tripId, timeEntryId: t.id };
  });
}

/**
 * Accept all (Homer, 2026-10-30): several items in one step, all or nothing. Trips go first, so the costs and travel
 * time sent with a new trip land on it. Costs use the one expense account and paid-with account given.
 */
export async function acceptRoadItems(db, companyId, viewer, { itemIds, expenseAccountId, paidFromAccountId, paidFrom, tripId } = {}, { actor = null } = {}) {
  // paidFrom: { itemId: accountId } for costs on another card than the rest (airfare and hotel on the travel card).
  const cardFor = paidFrom && typeof paidFrom === 'object' ? paidFrom : {};
  if (!Array.isArray(itemIds) || !itemIds.length || itemIds.length > 200 || !itemIds.every(isId)) throw new LedgerError('Choose the items to accept');
  return withTransaction(db, async (c) => {
    await lockCompany(c, companyId);
    const { rows } = await c.query(
      `SELECT id, kind FROM road_items WHERE company_id = $1 AND id = ANY($2::uuid[]) AND status = 'pending' AND kind NOT IN ('check', 'purchase')
        ORDER BY (kind = 'trip') DESC, (kind = 'booking') DESC, received_at, id`, [companyId, [...new Set(itemIds)]]);
    if (rows.length !== new Set(itemIds).size) throw new LedgerError('Some of those items were already reviewed (or are checks or purchases); refresh and try again');
    const out = [];
    for (const r of rows) {
      const card = isId(cardFor[r.id]) ? cardFor[r.id] : paidFromAccountId;
      const one = await acceptRoadItem(c, companyId, viewer, r.id, { expenseAccountId, paidFromAccountId: card, tripId: r.kind === 'trip' ? null : tripId }, { actor });
      out.push({ id: r.id, kind: r.kind, ...one });
    }
    return { accepted: out.length, items: out };
  });
}

/** A check from the road became a payment at the desk (Sales → Receive payment): link them and copy its photos. */
export async function acceptRoadCheck(db, companyId, itemId, { paymentId } = {}, { actor = null } = {}) {
  return withTransaction(db, async (c) => {
    await lockCompany(c, companyId);
    const item = await lockItem(c, companyId, itemId);
    if (item.kind !== 'check') throw new LedgerError('That item is not a check');
    if (!isId(paymentId)) throw new LedgerError('Payment not found');
    const { rows: [p] } = await c.query("SELECT id FROM payments WHERE company_id = $1 AND id = $2 AND kind = 'received' AND status = 'posted'", [companyId, paymentId]);
    if (!p) throw new LedgerError('Payment not found');
    const { rowCount: photos } = await c.query(
      `INSERT INTO payment_photos (company_id, payment_id, picture, picture_type, created_by)
       SELECT company_id, $2, picture, picture_type, $3 FROM road_photos WHERE item_id = $1 ORDER BY created_at, id`, [item.id, p.id, actor]);
    await c.query("UPDATE road_items SET status = 'accepted', reviewed_by = $2, reviewed_at = now(), payment_id = $3 WHERE id = $1", [item.id, actor, p.id]);
    await appendAudit(c, companyId, { action: 'accept', entity: 'road_item', entityId: item.id, actor, payload: { kind: 'check', payment_id: p.id, photos } });
    return { accepted: true, paymentId: p.id, photos };
  });
}

export async function dismissRoadItem(db, companyId, itemId, { actor = null } = {}) {
  return withTransaction(db, async (c) => {
    await lockCompany(c, companyId);
    const item = await lockItem(c, companyId, itemId);
    await c.query("UPDATE road_items SET status = 'dismissed', reviewed_by = $2, reviewed_at = now() WHERE id = $1", [item.id, actor]);
    await appendAudit(c, companyId, { action: 'dismiss', entity: 'road_item', entityId: item.id, actor, payload: { kind: item.kind } });
    return { dismissed: true };
  });
}
