// Reading a receipt picture with Claude (Homer, 2026-11-06). The form and the checks are in src/core/receipt.js.
//
// ℹ️ Off until the server has an Anthropic API key: set ANTHROPIC_API_KEY in Railway's Variables (runbook, "Receipt
// reading"). Without it the buttons don't show and this answers 503. Each picture costs about a cent or two
// (docs/programmers-guide has the arithmetic); RECEIPT_READS_PER_DAY caps how many one company can read in a day.
//
// ⚠️ A receipt can show the last four digits of a card and a person's name. The picture is sent to Anthropic for the
// reading and never stored, logged or audited here; what was read goes back to the browser only.
import Anthropic from '@anthropic-ai/sdk';
import { readPicture } from './feedbackService.js';
import { LedgerError } from '../core/ledger.js';
import { RECEIPT_SCHEMA, RECEIPT_PROMPT, normalizeReceipt } from '../core/receipt.js';

/** An answer that is not the person's mistake: reading is off (503) or the reader is down or busy (502, 429). */
export class ReceiptError extends Error {
  constructor(message, status) { super(message); this.name = 'ReceiptError'; this.status = status; }
}

const MODEL = () => process.env.RECEIPT_MODEL || 'claude-opus-5-5';
// The models that can hand a declined request to another model by themselves (server-side fallback).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const MAX_PER_DAY = () => Number(process.env.RECEIPT_READS_PER_DAY ?? 200);

/** True when this server can read receipts (the browser hides the buttons otherwise). */
export function receiptReadingOn() {
  return Boolean(process.env.ANTHROPIC_API_KEY) && process.env.RECEIPT_READING !== 'off';
}

const centralToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()); // YYYY-MM-DD

// How many receipts each company has read today (kept in memory: a restart starts the count again, which is fine for a cap).
const counts = new Map();
function countRead(companyId, today) {
  if (counts.size > 10_000) counts.clear();
  const k = `${companyId}|${today}`;
  const n = (counts.get(k) ?? 0) + 1;
  if (n > MAX_PER_DAY()) throw new ReceiptError(`This company has read ${MAX_PER_DAY()} receipts today, the most for one day. Type this one in.`, 429);
  counts.set(k, n);
}

let sharedClient = null;
const defaultClient = () => (sharedClient ??= new Anthropic({ timeout: 60_000, maxRetries: 1 }));

/**
 * One receipt picture (a PNG or JPEG data: URL, as the photo boxes make it) → { vendor, amount, date, kind, ... }.
 * `client` is for the tests (a stand-in that answers without the network).
 */
export async function readReceipt(companyId, body, { client = null, today = centralToday() } = {}) {
  if (!client && !receiptReadingOn()) throw new ReceiptError('Reading receipts is not turned on for this site yet. Type the amounts in.', 503);
  const picture = readPicture(body?.picture);
  if (!picture) throw new LedgerError('Choose a receipt photo first');
  countRead(companyId, today);

  const model = MODEL();
  const request = {
    model,
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: RECEIPT_SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: picture.type, data: picture.bytes.toString('base64') } },
        { type: 'text', text: `${RECEIPT_PROMPT}\nToday is ${today}.` },
      ],
    }],
  };
  if (FALLBACK_MODELS.has(model)) Object.assign(request, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });

  let response;
  try {
    response = await (client ?? defaultClient()).beta.messages.create(request);
  } catch (err) {
    // Never log the picture or the key: only what kind of failure it was.
    console.error(JSON.stringify({ level: 'warn', msg: 'receipt reading failed', status: err?.status ?? null, type: err?.name ?? null }));
    if (err instanceof Anthropic.RateLimitError) throw new ReceiptError('The receipt reader is busy. Try again in a minute, or type it in.', 429);
    throw new ReceiptError('The receipt could not be read just now. Type it in, or try again later.', 502);
  }
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
    throw new ReceiptError('The receipt could not be read. Type it in.', 502);
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let raw;
  try { raw = JSON.parse(text); } catch { throw new ReceiptError('The receipt could not be read. Type it in.', 502); }
  const read = normalizeReceipt(raw, { today });
  if (!read.isReceipt) throw new LedgerError('That picture does not look like a receipt');
  return read;
}
