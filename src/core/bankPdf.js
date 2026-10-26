// Bank statements as PDF (Homer, 2026-10-26): the monthly statement the bank mails or posts, for months the bank no
// longer offers as CSV or QFX. Pure functions, no database; tested in test/bankPdf.unit.test.js.
//
// Every bank lays its statement out differently, so the reader looks for what nearly all of them share:
//   - a statement period near the top ("10/01/26 through 10/31/26", "October 1, 2026 - October 31, 2026"), which
//     gives the year for rows dated only "10/03";
//   - "Beginning balance" and "Ending balance", used to check the reading: beginning + every row = ending;
//   - transaction rows that start with a date and end with an amount, sometimes followed by the running balance;
//   - lines under a row that carry on its description (wrapped text).
// Whether a row is money in or out is decided, in this order:
//   1. a sign printed on the amount: -45.00, 45.00-, (45.00) (on a credit card statement, minus is a payment: in);
//   2. the column it sits under, when the table has "Deposits/Credits" and "Withdrawals/Debits" columns (Wells Fargo);
//   3. the running balance: the balance went up or down by the amount;
//   4. the section it is in: "Deposits and additions" is in; "Checks paid", "Withdrawals", "Fees" are out (Chase).
// A row whose direction cannot be told stops the import rather than being guessed. Amounts are integer cents,
// positive = money into the account, the same as the CSV and QFX readers.
import { ImportError, MAX_IMPORT_ROWS } from './bankImport.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAME = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';

// An amount as a cell: 1,234.56  $1,234.56  -45.00  45.00-  (45.00)  -$45.00
const MONEY = /^(\()?\s*(-)?\s*\$?\s*(-)?\s*(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\s*(-)?\s*(\))?$/;
// The same, at the end of a longer cell ("Deposit 500.00" printed close together).
const MONEY_TAIL = /\s(\(?\s*-?\s*\$?\s*-?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\s*-?\s*\)?)$/;
// A row's leading date: 10/03, 10/03/26, 10/03/2026, 10-03, Oct 3.
const LEAD_DATE = new RegExp(`^(?:(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{4}|\\d{2}))?|${MONTH_NAME}\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?)(?=\\s|$)`, 'i');
const FULL_DATE = new RegExp(`\\b(\\d{1,2})/(\\d{1,2})/(\\d{4}|\\d{2})\\b|\\b${MONTH_NAME}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'gi');

const IN_WORDS = /\b(deposits?|credits?|additions?|interest\s+(paid|earned))\b/i;
const OUT_WORDS = /\b(withdrawals?|debits?|subtractions?|checks?|fees?|charges?|payments?|purchases?)\b/i;
const CARD_CREDITS = /\bpayments?\b.*\bcredits?\b/i; // a card's "Payments and other credits" lower what is owed: in
const SKIP_WORDS = /\bdaily\s+(ending\s+|ledger\s+|collected\s+)?balances?\b|\bbalance\s+(history|summary)\b|\boutstanding\b/i;
const BEGIN = /\b(beginning|opening|starting|previous)\s+balance\b/i;
const END = /\b(ending|closing|new)\s+balance\b/i;
const NOISE = /^page\s+\d+|\bcontinued\b|^\(?continued/i;

/** "1,234.56-" → { cents: 123456, sign: -1 }; sign is 0 when none is printed. null when not an amount. */
export function moneyCell(text) {
  const m = MONEY.exec(String(text ?? '').trim());
  if (!m) return null;
  const [, open, minus1, minus2, whole, frac, minus3, close] = m;
  if (Boolean(open) !== Boolean(close)) return null;
  const cents = Number(whole.replace(/,/g, '')) * 100 + Number(frac);
  return { cents, sign: open || minus1 || minus2 || minus3 ? -1 : 0 };
}

const iso = (y, m, d) => {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${s}T12:00:00Z`);
  return t.getUTCMonth() + 1 === m ? s : null;
};
const fullYear = (y) => (String(y).length === 2 ? 2000 + Number(y) : Number(y));
const monthOf = (name) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
const rowText = (r) => r.cells.map((c) => c.text).join(' ');

/** Every full date written in a piece of text, as ISO strings, in order. */
function fullDates(text) {
  const out = [];
  for (const m of text.matchAll(FULL_DATE)) {
    const d = m[1] ? iso(fullYear(m[3]), Number(m[1]), Number(m[2])) : iso(Number(m[6]), monthOf(m[4]), Number(m[5]));
    if (d) out.push(d);
  }
  return out;
}

/**
 * The statement's closing date: the second date of the first row that holds two (the statement period), else the
 * latest full date in the first 40 rows. Rows dated only month/day take their year from it.
 */
export function statementEnd(rows) {
  for (const r of rows.slice(0, 60)) { const d = fullDates(rowText(r)); if (d.length >= 2 && d[1] >= d[0]) return d[1]; }
  const all = rows.slice(0, 40).flatMap((r) => fullDates(rowText(r))).sort();
  return all.at(-1) ?? null;
}

/** The leading date of a row's text → { date, rest } (rest = the text after it), or null. */
function leadDate(text, end) {
  const m = LEAD_DATE.exec(text);
  if (!m) return null;
  let month; let day; let year;
  if (m[1]) { month = Number(m[1]); day = Number(m[2]); year = m[3] ? fullYear(m[3]) : null; }
  else { month = monthOf(m[4]); day = Number(m[5]); year = m[6] ? Number(m[6]) : null; }
  if (year == null) {
    if (!end) return { date: null, rest: text.slice(m[0].length).trim() };
    const [ey, em] = end.split('-').map(Number);
    year = month > em ? ey - 1 : ey; // a December row on a January statement is last year's
  }
  const date = iso(year, month, day);
  return date ? { date, rest: text.slice(m[0].length).trim() } : null;
}

/** A row's amounts, read from its right end: [{cents, sign, center}], plus the cells left over (date, description). */
function splitAmounts(cells) {
  const amounts = [];
  let i = cells.length;
  while (i > 0) {
    const c = cells[i - 1];
    const m = moneyCell(c.text);
    if (m) { amounts.unshift({ ...m, center: (c.x + c.end) / 2 }); i--; continue; }
    if (!amounts.length) {
      const t = MONEY_TAIL.exec(c.text);
      const tm = t && moneyCell(t[1]);
      if (tm) {
        amounts.unshift({ ...tm, center: c.end - 15 });
        return { amounts, rest: [...cells.slice(0, i - 1), { ...c, text: c.text.slice(0, t.index).trim() }] };
      }
    }
    break;
  }
  return { amounts, rest: cells.slice(0, i) };
}

/** A column heading row: names an "in" column and an "out" column (and maybe a balance column) as separate cells. */
const IN_COL = /\b(deposits?|credits?|additions?|money\s+in)\b/i;
const OUT_COL = /\b(withdrawals?|debits?|subtractions?|payments?|charges?|money\s+out)\b/i;
function columnHeads(row) {
  const cols = {};
  for (const c of row.cells) {
    const center = (c.x + c.end) / 2;
    if (/balance/i.test(c.text)) cols.balance ??= center;
    else if (OUT_COL.test(c.text) && !IN_COL.test(c.text)) cols.out ??= center;
    else if (IN_COL.test(c.text) && !OUT_COL.test(c.text)) cols.in ??= center;
  }
  return cols.in != null && cols.out != null ? cols : null;
}

/** The first amount at or after the cell that matches re ("Beginning balance $1,000.00   Ending balance $900.00"). */
function amountAfter(row, re) {
  const i = Math.max(row.cells.findIndex((c) => re.test(c.text)), 0); // the words may be split across cells
  for (const c of row.cells.slice(i)) {
    const m = moneyCell(c.text) ?? moneyCell(MONEY_TAIL.exec(c.text)?.[1]);
    if (m) return (m.sign || 1) * m.cents;
  }
  return null;
}

/**
 * Rows (src/core/pdfRows.js) → { txns: [{date, amountCents, description, fitId: null}], beginCents, endCents, endDate, problems }.
 * creditCard: the balances are what is owed, so a purchase (out) raises the balance and a payment (in) lowers it.
 */
export function readPdfStatement(rows, { creditCard = false } = {}) {
  const owed = creditCard ? -1 : 1; // which way the printed balance (and a printed sign) moves when money comes in
  const problems = [];
  const unsure = [];
  const end = statementEnd(rows);
  let beginCents = null; let endCents = null;
  let section = null;     // 'in' | 'out' | 'skip' | null
  let checks = false;     // inside a "Checks paid" section: bare numbers are check numbers
  let cols = null;        // column centers when the table has in/out columns
  let balance = null;     // the last running balance seen
  let last = null;        // the last transaction, for wrapped description lines
  const txns = [];

  const push = (date, cents, sign, description, row, descX) => {
    if (!cents) return;
    if (!sign) { unsure.push(`${date} ${description} ${(cents / 100).toFixed(2)}`); return; }
    if (txns.length >= MAX_IMPORT_ROWS) throw new ImportError(`A statement can have at most ${MAX_IMPORT_ROWS} transactions`);
    const desc = (checks && /^\d{1,7}$/.test(description) ? `Check ${description}` : description || (checks ? 'Check' : '')).slice(0, 300);
    last = { t: { date, amountCents: sign * cents, description: desc, fitId: null }, y: row.y, descX, lines: 0 };
    txns.push(last.t);
  };

  for (const row of rows) {
    const text = rowText(row);
    if (!text || NOISE.test(text)) continue;
    const { amounts, rest } = splitAmounts(row.cells);
    const restText = rest.map((c) => c.text).join(' ').trim();

    // Beginning / ending balance (the first of each; summaries repeat them).
    const b = BEGIN.test(text) ? amountAfter(row, BEGIN) : null;
    const e = END.test(text) && !SKIP_WORDS.test(text) ? amountAfter(row, END) : null;
    if (b != null || e != null) {
      if (b != null && beginCents == null) { beginCents = b; balance ??= b; }
      if (e != null && endCents == null) endCents = e;
      last = null;
      continue;
    }

    const lead = leadDate(restText, end);
    if (!lead) {
      // Wrapped description: just under the last row, starting at (or right of) its description, with no amount.
      if (last && !amounts.length && last.lines < 3 && last.y - row.y <= 14 && row.cells[0].x >= last.descX - 4) {
        last.t.description = `${last.t.description} ${text}`.trim().slice(0, 300);
        last.lines++; last.y = row.y;
        continue;
      }
      last = null;
      const heads = columnHeads(row);
      if (heads) { cols = heads; section = null; checks = false; continue; }
      // "1234 10/05 500.00 1236 * 10/08 75.00": check number, date paid, amount, sometimes two or three across.
      if (section === 'out' && checks && /^\d/.test(text)) {
        const found = [...text.matchAll(/(\d{1,7})\s*[*^#]*\s*[*^#]?\s*(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\s+(\(?-?\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}-?\)?)/g)];
        if (found.length) {
          for (const f of found) {
            const d = leadDate(f[2], end); const m = moneyCell(f[3]);
            if (d?.date && m) push(d.date, m.cents, -1, f[1], row, row.cells[0].x);
          }
          last = null; // several checks on one row: no wrapped lines
          continue;
        }
      }
      // A section heading: short, no date. "Total deposits $5,000.00" also names its section, which is harmless.
      if (restText.split(/\s+/).length <= 8) {
        if (SKIP_WORDS.test(restText)) { section = 'skip'; cols = null; checks = false; }
        else if (CARD_CREDITS.test(restText) || (IN_WORDS.test(restText) && !OUT_WORDS.test(restText))) { section = 'in'; cols = null; checks = false; }
        else if (OUT_WORDS.test(restText) && !IN_WORDS.test(restText)) { section = 'out'; cols = null; checks = /\bchecks?\b/i.test(restText); }
      }
      continue;
    }

    if (section === 'skip') { last = null; continue; }
    if (!lead.date) { problems.push(`No statement period found, so "${text}" has no year`); continue; }
    if (!amounts.length) { if (section || cols) problems.push(`"${text}" has a date but no amount`); last = null; continue; }
    // Where the description starts, for wrapped lines: the next cell when the date stands alone, else a little in.
    const dateAlone = LEAD_DATE.exec(rest[0].text)?.[0].length === rest[0].text.length;
    const descX = dateAlone ? (rest[1]?.x ?? rest[0].end) : rest[0].x + 25;
    const description = lead.rest.replace(/\s+/g, ' ');

    if (cols) {
      // Each amount belongs to the nearest column heading.
      const near = (a) => Object.entries(cols).reduce((best, [k, x]) => (Math.abs(a.center - x) < Math.abs(best[1] - a.center) ? [k, x] : best), ['', Infinity])[0];
      let pushed = false;
      for (const a of amounts) {
        const k = near(a);
        if (k === 'balance') { balance = (a.sign || 1) * a.cents; continue; }
        push(lead.date, a.cents, a.sign * owed || (k === 'in' ? 1 : -1), description, row, descX);
        pushed = true;
      }
      if (!pushed) last = null;
      continue;
    }

    // No columns: one amount, or an amount then the running balance.
    const amt = amounts.length >= 2 ? amounts.at(-2) : amounts[0];
    let sign = amt.sign * owed; // a card prints a payment as -500.00: less owed, money in
    if (amounts.length >= 2) {
      const bal = (amounts.at(-1).sign || 1) * amounts.at(-1).cents;
      if (!sign && balance != null) {
        if (bal - balance === amt.cents) sign = owed;
        else if (balance - bal === amt.cents) sign = -owed;
      }
      balance = bal;
    }
    if (!sign && section === 'in') sign = 1;
    if (!sign && section === 'out') sign = -1;
    push(lead.date, amt.cents, sign, description, row, descX);
  }

  if (unsure.length) {
    throw new ImportError(`${unsure.length} row(s) on this statement could not be told apart as deposits or withdrawals (send the statement to the developer, or download a CSV instead)`, unsure);
  }
  if (!txns.length) throw new ImportError('No transactions were found in this PDF statement');
  const sum = txns.reduce((s, t) => s + t.amountCents, 0);
  if (beginCents == null || endCents == null) problems.push('The beginning and ending balances were not found, so this reading could not be checked against the statement');
  else if (beginCents + owed * sum !== endCents) {
    problems.push(`Beginning balance ${(beginCents / 100).toFixed(2)} ${creditCard ? 'less' : 'plus'} these rows is ${((beginCents + owed * sum) / 100).toFixed(2)}, but the statement's ending balance is ${(endCents / 100).toFixed(2)}: a row may be missing or misread`);
  }
  return { txns, beginCents, endCents, endDate: end, problems };
}
