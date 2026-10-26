// Old invoices brought in from a PDF (Homer, 2026-10-26): invoices written before zAccountant, still unpaid, so a
// payment can be applied to them and the checking account reconciles against what was billed.
//
// The PDF gives positioned words (x across, y up the page, in points). rowsFromItems() puts them back into rows, like
// reading a printed page line by line; parseOldInvoice() then reads Homer's Excel layout:
//   INVOICE                            DATE | INVOICE #   (the values on the row below)
//   BILL TO:  first line "Client C/o Attorney" (or just the customer), then the address
//   TERMS (row below: "20 days")        Description block: project name and site address, then TAX ID / TX Firm
//   Hours | Date | Identification of Task | $ Rate | $ Subtotal   (one row per line; "-" is zero)
//   Tax Rate 8.25% $0.00                TOTAL DUE $4,915.83
// Pure functions, no database: tested in test/oldInvoice.unit.test.js.

const ROW_GAP = 3;   // words within 3 points of the same height are on one row
const CELL_GAP = 6;  // a gap wider than 6 points starts a new cell

/** Positioned words [{str, x, y}] → rows top to bottom, each {y, cells: [{text, x}]} left to right. */
export function rowsFromItems(items) {
  const words = items.filter((w) => w.str && w.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const w of words) {
    const row = rows.find((r) => Math.abs(r.y - w.y) <= ROW_GAP);
    if (row) row.words.push(w); else rows.push({ y: w.y, words: [w] });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    const cells = [];
    for (const w of r.words.sort((a, b) => a.x - b.x)) {
      const last = cells.at(-1);
      if (last && w.x - last.end <= CELL_GAP) { last.text += (w.x - last.end > 1 ? ' ' : '') + w.str; last.end = w.x + (w.width ?? w.str.length * 5); }
      else cells.push({ text: w.str, x: w.x, end: w.x + (w.width ?? w.str.length * 5) });
    }
    return { y: r.y, cells: cells.map(({ text, x }) => ({ text: text.trim(), x })) };
  });
}

const DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const MONEY = /^\$?\s*([\d,]+\.\d{2})$/;
const isoDate = (s) => { const m = DATE.exec(String(s ?? '').trim()); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };
const cents = (s) => { const m = MONEY.exec(String(s ?? '').trim()); return m ? Number(m[1].replace(/,/g, '').replace('.', '')) : null; };
const rowText = (r) => r.cells.map((c) => c.text).join(' ');
const findRow = (rows, re) => rows.findIndex((r) => re.test(rowText(r)));
// The value under a heading: on the next row down, the cell nearest the heading's x.
function under(rows, i, heading) {
  const h = rows[i]?.cells.find((c) => heading.test(c.text));
  const next = rows[i + 1];
  if (!h || !next) return null;
  return next.cells.reduce((best, c) => (!best || Math.abs(c.x - h.x) < Math.abs(best.x - h.x) ? c : best), null)?.text ?? null;
}

/** Rows → the invoice as printed, plus problems found. Amounts in cents; dates ISO. */
export function parseOldInvoice(rows) {
  const problems = [];
  const out = { number: null, date: null, termsDays: null, customerName: null, careOf: null, address: null, project: null,
    lines: [], taxRate: null, taxCents: 0, totalCents: null, problems };

  const head = findRow(rows, /INVOICE\s*#/i);
  if (head >= 0) {
    out.number = under(rows, head, /INVOICE\s*#/i);
    out.date = isoDate(under(rows, head, /^DATE$/i));
  }
  const terms = findRow(rows, /^TERMS\b/i);
  if (terms >= 0) { const t = /(\d{1,3})\s*days?/i.exec(under(rows, terms, /^TERMS$/i) ?? ''); if (t) out.termsDays = Number(t[1]); }

  // Bill To: the rows under the heading, left column, until a gap of more than two lines or the next heading.
  const bill = findRow(rows, /^BILL\s*TO/i);
  if (bill >= 0) {
    const x0 = rows[bill].cells[0].x - 20;
    const lines = [];
    for (let i = bill + 1, lastY = rows[bill].y; i < rows.length && lastY - rows[i].y < 30 && !/^(TERMS|Description)\b/i.test(rowText(rows[i])); i++) {
      const left = rows[i].cells.filter((c) => c.x < x0 + 260).map((c) => c.text).join(' ').trim();
      if (left) { lines.push(left); lastY = rows[i].y; }
    }
    if (lines.length) {
      const co = /^(.+?)\s+c\/o\s+(.+)$/i.exec(lines[0]);
      if (co) { out.careOf = co[1].trim(); out.customerName = co[2].trim(); } else out.customerName = lines[0];
      out.address = lines.slice(1).join('\n') || null;
    }
  }

  // The line table starts at the row with Hours and Subtotal; the project block sits between "Description" and it.
  const table = findRow(rows, /\bHours\b.*\bSubtotal\b|\bSubtotal\b.*\bHours\b/i);
  const desc = findRow(rows, /^Description$/i);
  if (desc >= 0) {
    const end = table >= 0 ? table : rows.length;
    const block = [];
    for (let i = desc + 1; i < end; i++) {
      const c = rows[i].cells[0];
      if (!c || MONEY.test(c.text) || /^(TAX\s*ID|TX\s*Firm|Hours\b|C$|o$)/i.test(c.text)) continue;
      block.push(c.text);
    }
    out.project = block.join('\n') || null;
  }

  const LINE = /^(\d+(?:\.\d+)?)\s+(\d{1,2}\/\d{1,2}\/\d{4})?\s*(.*?)\s*\$\s*([\d,]+\.\d{2})\s+\$\s*([\d,]+\.\d{2}|-)$/;
  for (let i = Math.max(table, 0) + 1; table >= 0 && i < rows.length; i++) {
    const t = rowText(rows[i]);
    if (/^Tax Rate\b|TOTAL DUE/i.test(t)) break;
    const m = LINE.exec(t);
    if (!m) continue;
    out.lines.push({ hours: m[1], serviceDate: m[2] ? isoDate(m[2]) : null, task: m[3], rateCents: cents(m[4]), amountCents: m[5] === '-' ? 0 : cents(m[5]) });
  }

  const tax = findRow(rows, /^Tax Rate\b/i);
  if (tax >= 0) {
    const t = rowText(rows[tax]);
    const pct = /([\d.]+)\s*%/.exec(t); if (pct) out.taxRate = pct[1];
    const amt = rows[tax].cells.map((c) => cents(c.text)).filter((v) => v != null).at(-1); if (amt != null) out.taxCents = amt;
  }
  const total = findRow(rows, /TOTAL DUE/i);
  if (total >= 0) out.totalCents = rows[total].cells.map((c) => cents(c.text)).filter((v) => v != null).at(-1) ?? null;

  if (!out.number) problems.push('No invoice number found');
  if (!out.date) problems.push('No invoice date found');
  if (!out.customerName) problems.push('No Bill To found');
  if (!out.lines.length) problems.push('No lines found (Hours, Date, Task, Rate, Subtotal)');
  if (out.totalCents == null) problems.push('No TOTAL DUE found');
  // A line dated after the invoice, or more than half a year before it, is usually a typed year (10/3/2025 for 2026).
  for (const l of out.lines) {
    if (!out.date || !l.serviceDate) continue;
    const days = (Date.parse(out.date) - Date.parse(l.serviceDate)) / 86400000;
    if (days < 0 || days > 183) problems.push(`The line "${l.task}" is dated ${l.serviceDate}: check the year`);
  }
  const sum = out.lines.reduce((s, l) => s + l.amountCents, 0) + out.taxCents;
  if (out.totalCents != null && out.lines.length && sum !== out.totalCents) {
    problems.push(`The lines and tax add up to ${(sum / 100).toFixed(2)}, but TOTAL DUE is ${(out.totalCents / 100).toFixed(2)}`);
  }
  return out;
}

/**
 * A printed line → an invoice line that bills exactly the printed subtotal. The hours print rounded (2.73 h of a
 * 2 h 44 min visit is really 2.7333 h), so hours × rate can miss the subtotal by a few cents. When it does, the line
 * becomes 1 × the subtotal and the hours go in the description, so the invoice still totals what the client was sent.
 */
export function invoiceLine(l) {
  const desc = (l.task || 'Services').slice(0, 300);
  const [whole, frac = ''] = l.hours.split('.');
  const q4 = BigInt(whole) * 10000n + BigInt(frac.slice(0, 4).padEnd(4, '0'));
  const exact = l.rateCents != null && frac.length <= 4 && Number((q4 * BigInt(l.rateCents) * 2n + 10000n) / 20000n) === l.amountCents;
  if (exact) return { quantity: l.hours, unitPrice: (l.rateCents / 100).toFixed(2), description: desc, serviceDate: l.serviceDate };
  return { quantity: '1', unitPrice: (l.amountCents / 100).toFixed(2), serviceDate: l.serviceDate,
    description: `${desc} (${l.hours} h at $${((l.rateCents ?? 0) / 100).toFixed(2)})`.slice(0, 300) };
}
