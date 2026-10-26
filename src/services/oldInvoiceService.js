// Reads an old invoice PDF (Homer's Excel layout) so it can be entered as an open invoice. Nothing is saved here:
// the result fills the New invoice form, the person checks it, and Save posts it like any invoice.
// The PDF is read in memory and dropped; it is never logged, stored or audited (it names a client).
import { pdfBytes, pdfWords } from './pdfText.js';
import { rowsFromItems, parseOldInvoice, invoiceLine } from '../core/oldInvoice.js';

export const MAX_PDF_BYTES = 4 * 1024 * 1024;

/**
 * { pdf: base64 } → what the New invoice form needs: number, date, due date, customer (matched to a saved one when
 * the name matches), c/o client, project block, lines that total exactly what was printed, tax, and any problems.
 */
export async function readOldInvoice(db, companyId, { pdf }) {
  const words = await pdfWords(pdfBytes(pdf, MAX_PDF_BYTES, 'an invoice PDF'));
  const inv = parseOldInvoice(rowsFromItems(words));

  // The customer: a saved one whose name matches, ignoring case, spaces and punctuation ("Amanda James, ATTY").
  const key = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const { rows: customers } = await db.query(
    `SELECT id, name FROM contacts WHERE company_id = $1 AND kind = 'customer' AND is_active`, [companyId]);
  const match = inv.customerName ? customers.find((c) => key(c.name) === key(inv.customerName)) : null;
  const { rows: [taken] } = inv.number
    ? await db.query(`SELECT number FROM documents WHERE company_id = $1 AND kind = 'invoice' AND number = $2 AND status <> 'void'`, [companyId, inv.number])
    : { rows: [] };
  if (taken) inv.problems.unshift(`Invoice ${inv.number} is already in the books`);

  let dueDate = null;
  if (inv.date && inv.termsDays != null) {
    const d = new Date(`${inv.date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + inv.termsDays); dueDate = d.toISOString().slice(0, 10);
  }
  return {
    number: inv.number, date: inv.date, dueDate, termsDays: inv.termsDays,
    customerId: match?.id ?? null, customerName: inv.customerName, address: inv.address, careOf: inv.careOf,
    project: inv.project, taxRate: inv.taxCents ? inv.taxRate : null, taxCents: inv.taxCents, totalCents: inv.totalCents,
    lines: inv.lines.map((l) => ({ ...invoiceLine(l), taxable: inv.taxCents > 0 })),
    problems: inv.problems,
  };
}
