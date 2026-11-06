// Reading a receipt picture (Homer, 2026-11-06): "take a picture of the receipt … and it collects the information off
// of it: the entity, the total, the date."
//
// ℹ️ How it works. The picture goes to Claude (Anthropic's AI model, which can read pictures), with the question and
// the exact shape of the answer: a JSON form with these few boxes (RECEIPT_SCHEMA). This file holds that form and the
// check of what comes back (normalizeReceipt). It is pure: no network, no database, so the tests can feed it answers.
// The network call is in src/services/receiptReader.js.
//
// Nothing read from a receipt goes into the books by itself: it only fills the boxes of the cost form, and the person
// checks them and presses Save, the same as if they had typed them.
import { toCents, centsToDecimal } from './money.js';

/** The kinds of trip cost (the same list as src/services/tripService.js COST_KINDS, less mileage: no receipt). */
export const RECEIPT_KINDS = ['airfare', 'rental_car', 'lodging', 'meals', 'tolls', 'other'];

const textOrNull = { anyOf: [{ type: 'string' }, { type: 'null' }] };

/** The answer's shape, sent with the question (the model must answer in exactly this form). */
export const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    isReceipt: { type: 'boolean', description: 'false when the picture is not a receipt, invoice or booking confirmation' },
    vendor: { ...textOrNull, description: 'the business that was paid, as printed (e.g. "Southwest Airlines", "Avis", "Hampton Inn Selma")' },
    total: { ...textOrNull, description: 'the grand total actually charged, digits only with a decimal point, e.g. "412.30"' },
    currency: { ...textOrNull, description: 'three-letter currency code, e.g. "USD"' },
    date: { ...textOrNull, description: 'the date of the purchase or charge as YYYY-MM-DD' },
    kind: { type: 'string', enum: RECEIPT_KINDS },
    description: { ...textOrNull, description: 'a few words on what was bought, e.g. "Airfare SAT-DAL" or "Hotel, 2 nights"' },
  },
  required: ['isReceipt', 'vendor', 'total', 'currency', 'date', 'kind', 'description'],
  additionalProperties: false,
};

/** The question that goes with the picture. */
export const RECEIPT_PROMPT = [
  'Read this receipt for a small business\'s books (a US engineering firm, mostly travel costs). Fill in the form:',
  '- vendor: the business that was paid, the way people would name it (the brand or hotel name, not the street address or the card processor).',
  '- total: the grand total actually charged, after tax and tip. If a tip or total was written in by hand, use the hand-written total.',
  '  For an airline or hotel confirmation, the total charged to the card. Digits and a decimal point only, no $ or commas.',
  '- date: the date of the purchase or charge (for a hotel folio, the check-out date). US receipts write dates month first: 11/04/26 is 2026-11-04.',
  '- kind: airfare, rental_car, lodging (hotel), meals (restaurant, coffee, groceries on the road), tolls (toll road, parking), or other (fuel and everything else).',
  '- description: a few words, like "Airfare SAT-DAL" or "Hotel, 2 nights".',
  'Use null for anything you cannot read clearly. Do not guess numbers.',
].join('\n');

const MAX_VENDOR = 120;
const MAX_DESCRIPTION = 300;

function cleanText(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** "412.30", "$1,412.3", 412.3 → "412.30"; anything not a positive amount → null. */
function cleanAmount(v) {
  if (v == null || v === '') return null;
  try {
    const c = toCents(typeof v === 'number' ? v : String(v).replace(/^[A-Z]{3}\s*/i, ''));
    return c > 0 && c < 100_000_000 ? centsToDecimal(c) : null; // under a million dollars
  } catch { return null; }
}

/** A real calendar date, YYYY-MM-DD, from 2000 to a year past `today` (a booking can be for later). */
function cleanDate(v, today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof v === 'string' ? v.trim() : '');
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null; // 2026-02-30
  const t = new Date(`${today}T00:00:00Z`);
  const latest = new Date(Date.UTC(t.getUTCFullYear() + 1, t.getUTCMonth(), t.getUTCDate()));
  return +m[1] >= 2000 && d <= latest ? m[0] : null;
}

/**
 * What the model answered → what the cost form may use: { isReceipt, vendor, amount, currency, date, kind, description }.
 * Every box is checked again here (the form's rules are the model's instructions, not a promise): an amount with
 * three decimals, an impossible date or an unknown kind becomes null / "other", never an error.
 */
export function normalizeReceipt(raw, { today }) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const currency = typeof r.currency === 'string' && /^[A-Za-z]{3}$/.test(r.currency.trim()) ? r.currency.trim().toUpperCase() : null;
  return {
    isReceipt: r.isReceipt !== false,
    vendor: cleanText(r.vendor, MAX_VENDOR),
    amount: cleanAmount(r.total),
    currency,
    date: cleanDate(r.date, today),
    kind: RECEIPT_KINDS.includes(r.kind) ? r.kind : 'other',
    description: cleanText(r.description, MAX_DESCRIPTION),
  };
}
