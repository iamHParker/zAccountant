// Reading a receipt picture (src/core/receipt.js, src/services/receiptReader.js, public/receipt.js).
// No network: a stand-in client answers the way Claude would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReceipt, RECEIPT_SCHEMA } from '../src/core/receipt.js';
import { readReceipt, ReceiptError } from '../src/services/receiptReader.js';
import { fillFromReceipt, filledText } from '../public/receipt.js';
import { LedgerError } from '../src/core/ledger.js';

const today = '2026-11-06';
// The first bytes of a JPEG (FF D8 FF) are all the picture check looks at.
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]).toString('base64')}`;

test('a clean answer passes through; the total becomes a two-decimal amount', () => {
  const r = normalizeReceipt({ isReceipt: true, vendor: '  Avis   Rent A Car ', total: '412.3', currency: 'usd', date: '2026-10-04', kind: 'rental_car', description: 'Rental car, 3 days' }, { today });
  assert.deepEqual(r, { isReceipt: true, vendor: 'Avis Rent A Car', amount: '412.30', currency: 'USD', date: '2026-10-04', kind: 'rental_car', description: 'Rental car, 3 days' });
});

test('totals: $ and commas are fine; three decimals, zero, negatives and words are not', () => {
  const amt = (total) => normalizeReceipt({ total }, { today }).amount;
  assert.equal(amt('$1,412.05'), '1412.05');
  assert.equal(amt('USD 18.5'), '18.50');
  assert.equal(amt('12.345'), null); // never rounded silently
  assert.equal(amt('0.00'), null);
  assert.equal(amt('-5.00'), null);
  assert.equal(amt('about forty'), null);
  assert.equal(amt(null), null);
});

test('dates: real calendar days only, 2000 to a year from today', () => {
  const date = (d) => normalizeReceipt({ date: d }, { today }).date;
  assert.equal(date('2026-02-28'), '2026-02-28');
  assert.equal(date('2026-02-30'), null);
  assert.equal(date('11/04/2026'), null); // the form asks for YYYY-MM-DD
  assert.equal(date('1999-12-31'), null);
  assert.equal(date('2027-11-06'), '2027-11-06'); // a booking a year out
  assert.equal(date('2027-11-07'), null);
});

test('an unknown kind becomes other; not a receipt is kept as such', () => {
  const r = normalizeReceipt({ isReceipt: false, kind: 'fuel' }, { today });
  assert.equal(r.kind, 'other');
  assert.equal(r.isReceipt, false);
});

test('the schema the model must answer in lists every box as required, nothing extra', () => {
  assert.deepEqual(RECEIPT_SCHEMA.required.sort(), Object.keys(RECEIPT_SCHEMA.properties).sort());
  assert.equal(RECEIPT_SCHEMA.additionalProperties, false);
});

function fakeClient(answer, capture = {}) {
  return { beta: { messages: { create: async (req) => { capture.req = req; if (answer instanceof Error) throw answer; return answer; } } } };
}
const said = (obj, stop = 'end_turn') => ({ stop_reason: stop, content: [{ type: 'text', text: JSON.stringify(obj) }] });

test('readReceipt sends the picture with the form, and returns the checked answer', async () => {
  const capture = {};
  const r = await readReceipt('co-1', { picture: JPEG }, { today, client: fakeClient(said({ isReceipt: true, vendor: 'Southwest Airlines', total: '289.96',
    currency: 'USD', date: '2026-10-20', kind: 'airfare', description: 'Airfare SAT-DAL' }), capture) });
  assert.equal(r.amount, '289.96');
  assert.equal(r.vendor, 'Southwest Airlines');
  const { req } = capture;
  assert.equal(req.output_config.format.type, 'json_schema');
  const [image, text] = req.messages[0].content;
  assert.equal(image.type, 'image');
  assert.equal(image.source.media_type, 'image/jpeg');
  assert.match(text.text, /Today is 2026-11-06/);
});

test('readReceipt: no picture, a non-picture, or not a receipt are the person\'s to fix (400)', async () => {
  const client = fakeClient(said({ isReceipt: false, vendor: null, total: null, currency: null, date: null, kind: 'other', description: null }));
  await assert.rejects(readReceipt('co-1', {}, { today, client }), LedgerError);
  await assert.rejects(readReceipt('co-1', { picture: 'data:image/gif;base64,R0lGOD' }, { today, client }), LedgerError);
  await assert.rejects(readReceipt('co-1', { picture: JPEG }, { today, client }), /does not look like a receipt/);
});

test('readReceipt: the reader failing, refusing or answering nonsense is a 502, never a crash', async () => {
  const fail = (answer) => readReceipt('co-2', { picture: JPEG }, { today, client: fakeClient(answer) });
  await assert.rejects(fail(new Error('network down')), (e) => e instanceof ReceiptError && e.status === 502);
  await assert.rejects(fail({ stop_reason: 'refusal', content: [] }), (e) => e instanceof ReceiptError && e.status === 502);
  await assert.rejects(fail({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }), (e) => e.status === 502);
});

test('readReceipt: off without an API key (503)', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(readReceipt('co-3', { picture: JPEG }, { today }), (e) => e instanceof ReceiptError && e.status === 503);
  } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
});

test('readReceipt: a company can read RECEIPT_READS_PER_DAY receipts a day, then 429', async () => {
  process.env.RECEIPT_READS_PER_DAY = '2';
  try {
    const client = fakeClient(said({ isReceipt: true, vendor: 'NTTA', total: '4.12', currency: 'USD', date: today, kind: 'tolls', description: null }));
    await readReceipt('co-cap', { picture: JPEG }, { today, client });
    await readReceipt('co-cap', { picture: JPEG }, { today, client });
    await assert.rejects(readReceipt('co-cap', { picture: JPEG }, { today, client }), (e) => e.status === 429);
    await readReceipt('co-other', { picture: JPEG }, { today, client }); // another company has its own count
  } finally { delete process.env.RECEIPT_READS_PER_DAY; }
});

test('filling the form: only empty boxes (and the date it started with) change', () => {
  const read = { vendor: 'Hampton Inn Selma', amount: '318.44', date: '2026-10-05', kind: 'lodging', description: 'Hotel, 2 nights', currency: 'USD' };
  const fresh = { kind: 'other', date: today, dateDefault: today, amount: '', vendor: '', description: '' };
  assert.deepEqual(fillFromReceipt(fresh, read), ['paid to', 'amount', 'date', 'kind', 'what it was']);
  assert.equal(fresh.amount, '318.44');
  assert.equal(fresh.date, '2026-10-05');
  assert.equal(fresh.kind, 'lodging');

  const typed = { kind: 'meals', date: '2026-10-06', dateDefault: today, amount: '300.00', vendor: 'Hampton', description: 'x' };
  assert.deepEqual(fillFromReceipt(typed, read), []);
  assert.deepEqual(typed, { kind: 'meals', date: '2026-10-06', dateDefault: today, amount: '300.00', vendor: 'Hampton', description: 'x' });
  assert.match(filledText([], read), /nothing was changed/);
  assert.match(filledText(['amount', 'date'], { currency: 'EUR' }), /amount and date.*in EUR/);
});
