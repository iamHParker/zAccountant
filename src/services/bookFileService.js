// The book file (.zacc) and the QuickBooks exports (Homer, 2026-10-25: "we need a file format for saving the books to
// a local or remote site … quick book format or our own?" Answer: our own, complete, plus an export for QuickBooks).
//
// ℹ️ A .zacc file is an ordinary .zip (rename it to .zip and Windows opens it) holding:
//   README.txt                what is inside, in plain words
//   manifest.json             format version, company, when, and a SHA-256 fingerprint of every file inside, so a
//                             damaged or edited copy can be told from a good one
//   import/…csv               the chart of accounts and every transaction in the import-template layout: Accounts →
//                             Import in a new company rebuilds the books and every report from these two
//   tables/<table>.csv        every row this company has in every table (invoices, customers, employees, timesheets,
//                             trips, bank items, the audit trail …), one CSV per table, so nothing is lost
//   pictures/<table>/<id>.jpg receipt, check and logo pictures
// Never inside: Social Security numbers (stored encrypted, the key isn't ours to hand out), sign-in secrets, road keys.
//
// QuickBooks: Desktop reads an .iif file (accounts + general journal entries); Online imports journal entries from
// a CSV in its own column layout. Both carry every journal entry, so the balances match ours.
import { createHash } from 'node:crypto';
import { writeZip } from '../core/zip.js';
import { toCsv, amt } from '../core/csv.js';
import { centsToDecimal } from '../core/money.js';
import { chartRows, journalRows } from './backupService.js';

export const FORMAT_VERSION = 1;
// Not company records, or secrets: left out of the book file.
const SKIP_TABLES = new Set(['road_keys', 'road_items', 'road_photos', 'feedback_reports', 'company_plans', 'plan_changes', 'home_layouts']);
const SKIP_COLUMNS = new Set(['ssn_enc', 'token_hash', 'totp_secret_enc', 'recovery_codes', 'password_hash']);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const usDate = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${m}/${d}/${y}`; };

function cell(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/** Every table with a company_id column (so a table added later is included without anyone remembering to). */
async function companyTables(db) {
  const { rows } = await db.query(
    `SELECT c.table_name AS t, array_agg(c.column_name::text ORDER BY c.ordinal_position) AS cols,
            array_agg(c.data_type::text ORDER BY c.ordinal_position) AS types
       FROM information_schema.columns c JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
      WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE'
        AND c.table_name IN (SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'company_id')
      GROUP BY c.table_name ORDER BY c.table_name`);
  return rows.filter((r) => !SKIP_TABLES.has(r.t));
}

/**
 * The whole company as a .zacc file: { name, body (Buffer), manifest }.
 * `db` is the request's scoped connection (row-level security keeps it to this company as well).
 */
export async function bookFile(db, companyId, { actor = null, appVersion = '', now = new Date() } = {}) {
  const { rows: [co] } = await db.query('SELECT * FROM companies WHERE id = $1', [companyId]);
  const files = [];
  const add = (name, data, rows = null) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    files.push({ name, data: buf, rows, sha256: sha(buf), bytes: buf.length });
  };
  add('import/Chart of accounts.csv', toCsv(await chartRows(db, companyId)));
  add('import/All transactions.csv', toCsv(await journalRows(db, companyId)));
  const coCols = Object.keys(co).filter((k) => !SKIP_COLUMNS.has(k));
  add('tables/companies.csv', toCsv([coCols, coCols.map((k) => cell(co[k]))]), 1);
  for (const { t, cols, types } of await companyTables(db)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(t)) continue;
    const keep = cols.map((c, i) => ({ c, type: types[i] })).filter((x) => !SKIP_COLUMNS.has(x.c) && /^[a-z_][a-z0-9_]*$/.test(x.c));
    const pics = keep.filter((x) => x.type === 'bytea');
    const order = keep.some((x) => x.c === 'seq') ? 'seq' : keep.some((x) => x.c === 'created_at') ? 'created_at, 1' : '1';
    const { rows } = await db.query(`SELECT ${keep.map((x) => `"${x.c}"`).join(', ')} FROM "${t}" WHERE company_id = $1 ORDER BY ${order}`, [companyId]);
    const out = [keep.map((x) => x.c)];
    rows.forEach((r, n) => {
      out.push(keep.map((x) => {
        if (x.type !== 'bytea') return cell(r[x.c]);
        if (!r[x.c]) return '';
        const ext = /png/.test(r.picture_type ?? r.logo_type ?? '') ? 'png' : 'jpg';
        const name = `pictures/${t}/${r.id ?? n + 1}${pics.length > 1 ? `-${x.c}` : ''}.${ext}`;
        add(name, r[x.c]);
        return name;
      }));
    });
    add(`tables/${t}.csv`, toCsv(out), rows.length);
  }
  const manifest = {
    format: 'zacc', version: FORMAT_VERSION, app: appVersion || null,
    company: { id: co.id, name: co.name }, createdAt: now.toISOString(), createdBy: actor,
    note: "CSV text that began with = + - or @ has a ' in front (so Excel shows it as text).",
    files: files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256, ...(f.rows != null ? { rows: f.rows } : {}) })),
  };
  const readme = [
    `zAccountant book file for ${co.name}, made ${now.toISOString().slice(0, 10)}.`,
    '',
    'This is an ordinary .zip file. To look inside on Windows, rename it to .zip and open it.',
    '',
    'import/   The chart of accounts and every transaction. To rebuild the books in a new company:',
    '          Accounts -> Import, first "Chart of accounts.csv", then "All transactions.csv".',
    'tables/   Every record the company has, one spreadsheet per kind (invoices, customers, employees,',
    '          timesheets, trips, bank items, the audit trail ...).',
    'pictures/ Receipt, check and logo pictures.',
    '',
    'manifest.json lists every file with its SHA-256 fingerprint, so a damaged or changed copy shows.',
    'Not included: Social Security numbers and sign-in secrets.',
    'Keep this file somewhere safe: it holds your whole set of books.',
  ].join('\r\n');
  const body = writeZip([
    { name: 'README.txt', data: readme },
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    ...files.map((f) => ({ name: f.name, data: f.data })),
  ], { date: now });
  const safe = co.name.replace(/[^\w .,()&-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Company';
  return { name: `${safe} ${now.toISOString().slice(0, 10)}.zacc`, body, manifest };
}

// ---------------------------------------------------------------- QuickBooks

const IIF_TYPE = (a) => {
  if (a.type === 'asset') return a.subtype === 'bank' || a.subtype === 'cash' ? 'BANK' : a.subtype === 'receivable' ? 'AR' : a.subtype === 'fixed' ? 'FIXASSET' : 'OCASSET';
  if (a.type === 'liability') return a.subtype === 'payable' ? 'AP' : a.subtype === 'credit_card' ? 'CCARD' : a.subtype === 'long_term' ? 'LTLIAB' : 'OCLIAB';
  if (a.type === 'equity') return 'EQUITY';
  if (a.type === 'revenue') return a.subtype === 'asset_disposal' || a.subtype === 'other' ? 'EXINC' : 'INC';
  return a.subtype === 'cogs' ? 'COGS' : a.subtype === 'other' ? 'EXEXP' : 'EXP';
};
// QuickBooks reads ':' in an account name as "sub-account of"; tabs and line breaks would break the file.
const qbText = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').replace(/:/g, '-').trim();
const qbAccount = (a) => qbText(`${a.code} ${a.name}`).slice(0, 31);

async function ledgerLines(db, companyId) {
  const { rows } = await db.query(
    `SELECT e.entry_number, to_char(e.entry_date, 'YYYY-MM-DD') AS date, e.memo, a.code, a.name, a.type, a.subtype,
            l.debit_cents, l.credit_cents, l.memo AS line_memo,
            coalesce(dc.name, pc.name) AS contact
       FROM journal_entries e
       JOIN journal_lines l ON l.entry_id = e.id AND l.company_id = e.company_id
       JOIN accounts a ON a.id = l.account_id AND a.company_id = e.company_id
       LEFT JOIN documents d ON d.company_id = e.company_id AND (d.journal_entry_id = e.id OR d.void_entry_id = e.id)
       LEFT JOIN contacts dc ON dc.id = d.contact_id
       LEFT JOIN payments p ON p.company_id = e.company_id AND (p.journal_entry_id = e.id OR p.void_entry_id = e.id)
       LEFT JOIN contacts pc ON pc.id = p.contact_id
      WHERE e.company_id = $1 ORDER BY e.entry_number, l.id`, [companyId]);
  return rows;
}

/** QuickBooks Desktop: File → Utilities → Import → IIF Files. Accounts first, then each entry as a general journal. */
export async function quickbooksIif(db, companyId) {
  const { rows: accounts } = await db.query('SELECT code, name, type, subtype FROM accounts WHERE company_id = $1 ORDER BY code', [companyId]);
  const out = ['!ACCNT\tNAME\tACCNTTYPE\tACCNUM'];
  for (const a of accounts) out.push(['ACCNT', qbAccount(a), IIF_TYPE(a), a.code].join('\t'));
  out.push('!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO', '!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO', '!ENDTRNS');
  let current = null;
  for (const l of await ledgerLines(db, companyId)) {
    const first = l.entry_number !== current;
    if (first && current !== null) out.push('ENDTRNS');
    current = l.entry_number;
    const amount = centsToDecimal(Number(l.debit_cents) - Number(l.credit_cents)); // debit +, credit −
    out.push([first ? 'TRNS' : 'SPL', 'GENERAL JOURNAL', usDate(l.date), qbAccount(l), qbText(l.contact).slice(0, 41), amount,
      String(l.entry_number), qbText(l.line_memo ?? l.memo).slice(0, 200)].join('\t'));
  }
  if (current !== null) out.push('ENDTRNS');
  return `${out.join('\r\n')}\r\n`;
}

/** QuickBooks Online: Settings → Import data → Journal entries. One row per line; Name is filled on A/R and A/P lines. */
export async function quickbooksOnlineCsv(db, companyId) {
  const rows = [['Journal No.', 'Journal Date', 'Account Name', 'Debits', 'Credits', 'Description', 'Name']];
  for (const l of await ledgerLines(db, companyId)) {
    rows.push([String(l.entry_number), usDate(l.date), qbAccount(l), l.debit_cents > 0 ? amt(Number(l.debit_cents)) : '',
      l.credit_cents > 0 ? amt(Number(l.credit_cents)) : '', qbText(l.line_memo ?? l.memo), qbText(l.contact)]);
  }
  return toCsv(rows);
}
