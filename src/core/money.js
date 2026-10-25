// Money math for zAccountant.
//
// Rule #1 of the whole system: money is NEVER a floating-point number.
// (JavaScript numbers are IEEE doubles, so 0.1 + 0.2 !== 0.3 — the same trap as
// REAL*8 in Fortran.) Every amount is an integer number of CENTS.
// Rates (tax rates, percentages) are integers in PARTS PER MILLION (ppm):
//   6.2%  -> 62000 ppm,  10.23% -> 102300 ppm,  0.6% -> 6000 ppm.
// Multiplying cents by ppm is done with BigInt so nothing can overflow, and the
// result is rounded half-up to the nearest cent exactly once.

export const PPM = 1_000_000n;

/** Throw unless `c` is a safe integer number of cents. */
export function assertCents(c, label = 'amount') {
  if (!Number.isSafeInteger(c)) {
    throw new TypeError(`${label} must be an integer number of cents, got ${c}`);
  }
  return c;
}

/**
 * Parse a human/decimal money string into integer cents without using floats.
 * Accepts "1234.5", "1,234.56", "$1,234.56", "-12.30", "(12.30)" (accounting negative), numbers too.
 * Rejects more than 2 decimal places rather than silently rounding.
 */
export function toCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Invalid money amount: ${value}`);
    value = value.toString();
    if (/e/i.test(value)) throw new TypeError(`Invalid money amount: ${value}`);
  }
  if (typeof value !== 'string') throw new TypeError(`Invalid money amount: ${value}`);
  let s = value.trim().replace(/[$,\s]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] === undefined || m[2] === ''))) {
    throw new TypeError(`Invalid money amount: "${value}" (use up to 2 decimal places)`);
  }
  const dollars = m[1] === '' ? 0n : BigInt(m[1]);
  const cents = BigInt((m[2] ?? '').padEnd(2, '0'));
  const total = dollars * 100n + cents;
  const n = Number(negative ? -total : total);
  return assertCents(n === 0 ? 0 : n); // avoid -0
}

/** Format cents as a plain decimal string "-1234.56" (for APIs and CSV). */
export function centsToDecimal(c) {
  assertCents(c);
  const neg = c < 0;
  const abs = Math.abs(c);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/** Format cents for people: "$1,234.56", negatives as "($1,234.56)" accounting style. */
export function formatMoney(c, { accounting = true } = {}) {
  const dec = centsToDecimal(Math.abs(c));
  const [whole, frac] = dec.split('.');
  const s = `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
  if (c >= 0) return s;
  return accounting ? `(${s})` : `-${s}`;
}

/** Integer division of BigInts rounded half away from zero ("round half up" on magnitude). */
export function divRoundHalfUp(num, den) {
  if (den <= 0n) throw new RangeError('denominator must be positive');
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = (a * 2n + den) / (den * 2n);
  return neg ? -q : q;
}

/** cents × rate(ppm), rounded half-up to the cent. */
export function applyRate(cents, ppm) {
  assertCents(cents);
  if (!Number.isSafeInteger(ppm)) throw new TypeError(`rate must be integer ppm, got ${ppm}`);
  return Number(divRoundHalfUp(BigInt(cents) * BigInt(ppm), PPM));
}

/** Convert a percent string like "6.2" or "10.23" into ppm exactly (no floats). */
export function percentToPpm(pct) {
  const s = String(pct).trim();
  const m = /^(\d+)(?:\.(\d{0,4}))?$/.exec(s);
  if (!m) throw new TypeError(`Invalid percent: ${pct} (max 4 decimal places)`);
  return Number(BigInt(m[1]) * 10000n + BigInt((m[2] ?? '').padEnd(4, '0')));
}

/**
 * Split `cents` into parts proportional to integer `weights` so the parts ALWAYS sum
 * exactly to the total (largest-remainder method). Used for allocations/proration.
 */
export function allocate(cents, weights) {
  assertCents(cents);
  if (!weights.length) throw new RangeError('weights required');
  const W = weights.reduce((a, b) => a + BigInt(b), 0n);
  if (W <= 0n) throw new RangeError('weights must sum to a positive number');
  const total = BigInt(cents);
  const sign = total < 0n ? -1n : 1n;
  const abs = total * sign;
  const raw = weights.map((w) => abs * BigInt(w));
  const parts = raw.map((r) => r / W);
  let remainder = abs - parts.reduce((a, b) => a + b, 0n);
  const order = raw
    .map((r, i) => ({ i, rem: r % W }))
    .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i));
  for (let k = 0; remainder > 0n; k++, remainder--) parts[order[k % order.length].i] += 1n;
  return parts.map((p) => Number(p * sign));
}

export function sum(list) {
  return list.reduce((a, b) => a + assertCents(b), 0);
}

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
