// "Back up your books": a company's own copy of its ledger, for its owner to keep. Two CSV files in exactly the
// layout of our import templates (public/templates/), so they open in Excel and can be imported again
// (Accounts → Import) into a new company: first the chart of accounts, then the transactions.
//
// ℹ️ What it holds: every account and every journal entry (invoices, bills, payments, payroll and bank items
// are all journal entries, so the balances and every report rebuild from these two files). What it does not
// hold: the documents themselves (invoice line detail, customers, employees, timesheets) and line memos.
// Homer, 2026-10-24: an alpha product, so each user keeps their own backup.
import { amt } from '../core/csv.js';

const usDate = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${m}/${d}/${y}`; };
const TYPE_WORD = { asset: 'Asset', liability: 'Liability', equity: 'Equity', revenue: 'Revenue', expense: 'Expense' };

/** Chart of accounts → rows: Code, Name, Type, Subtype, Active (the import reads the first four). */
export async function chartRows(db, companyId) {
  const { rows } = await db.query(
    'SELECT code, name, type, subtype, is_active FROM accounts WHERE company_id = $1 ORDER BY code', [companyId]);
  return [['Code', 'Name', 'Type', 'Subtype', 'Active'],
    ...rows.map((a) => [a.code, a.name, TYPE_WORD[a.type], a.subtype ?? '', a.is_active ? 'yes' : 'no'])];
}

/** Every journal line, oldest entry first → rows: Entry, Date, Memo, Account, Debit, Credit, Source. */
export async function journalRows(db, companyId) {
  const { rows } = await db.query(
    `SELECT e.entry_number, e.entry_date::text AS date, e.memo, e.source, a.code, a.name, l.debit_cents, l.credit_cents
       FROM journal_entries e
       JOIN journal_lines l ON l.entry_id = e.id AND l.company_id = e.company_id
       JOIN accounts a ON a.id = l.account_id AND a.company_id = e.company_id
      WHERE e.company_id = $1
      ORDER BY e.entry_number, l.id`, [companyId]);
  return [['Entry', 'Date', 'Memo', 'Account', 'Debit', 'Credit', 'Source'],
    ...rows.map((r) => [String(r.entry_number), usDate(r.date), r.memo ?? '', `${r.code} ${r.name}`,
      r.debit_cents > 0 ? amt(Number(r.debit_cents)) : '', r.credit_cents > 0 ? amt(Number(r.credit_cents)) : '', r.source])];
}
