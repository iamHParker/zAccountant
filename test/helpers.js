// In-memory ledger for unit tests: turns entries into the per-account sums the report functions take.
import { DEFAULT_CHART } from '../src/core/chartOfAccounts.js';
import { validateEntry } from '../src/core/ledger.js';

export function chart() {
  return DEFAULT_CHART.map((a) => ({ id: a.code, ...a }));
}

export function sumsFor(entries, { from = null, to = null } = {}) {
  const m = new Map();
  for (const raw of entries) {
    const e = validateEntry(raw);
    if ((from && e.date < from) || (to && e.date > to)) continue;
    for (const l of e.lines) {
      const s = m.get(l.accountId) ?? { debitCents: 0, creditCents: 0 };
      s.debitCents += l.debitCents;
      s.creditCents += l.creditCents;
      m.set(l.accountId, s);
    }
  }
  return m;
}

/** Shorthand: je('2026-01-05', 'memo', ['1000', 500000, 0], ['3000', 0, 500000]) */
export const je = (date, memo, ...rows) => ({
  date, memo, lines: rows.map(([accountId, debitCents, creditCents]) => ({ accountId, debitCents, creditCents })),
});
