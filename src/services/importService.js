// Importing books from QuickBooks or a spreadsheet.
//
// ℹ️ How "preview" works: the import is actually carried out inside a database transaction —
// accounts created, entries posted, totals checked — and then the transaction is ROLLED BACK.
// So the preview is not an estimate; it is exactly what "Import" will do, and nothing is saved
// until you confirm. After a real import, the ledger totals per account are compared with the
// file's totals to the penny; any difference aborts the whole import.
//
// An import can later be undone: every entry it posted gets a reversing entry (history is kept).
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import { LedgerError, validateEntry, isIsoDate } from '../core/ledger.js';
import { readAccountsTable, readTrialBalance, readJournal, readIif, rowsFromFile, BookImportError } from '../core/bookImport.js';
import { readXlsx, XlsxError } from '../core/xlsx.js';
import { insertEntry, reverseEntry, ACCOUNT_SUBTYPES } from './ledgerService.js';
import { getTrialBalance } from './reportService.js';
import { appendAudit } from './audit.js';

export const IMPORT_KINDS = Object.freeze(['accounts', 'opening', 'journal', 'iif']);

class PreviewDone extends Error { constructor(result) { super('preview'); this.result = result; } }

const lockCompany = async (c, companyId) => {
  const { rows: [co] } = await c.query('SELECT * FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  if (!co) throw new LedgerError('Company not found');
  return co;
};

/** Parse the uploaded file for the chosen kind → { accounts: [...], entries: [...] }. */
function parseFile(kind, file, asOf) {
  try {
    if (kind === 'iif') return readIif(file.content);
    const rows = rowsFromFile(file, readXlsx);
    if (kind === 'accounts') return { accounts: readAccountsTable(rows), entries: [] };
    if (kind === 'opening') {
      if (!isIsoDate(asOf)) throw new BookImportError('Choose the date of the opening balances');
      return { accounts: [], entries: [{ ref: 'opening', row: 1, date: asOf, memo: `Opening balances as of ${asOf}`, lines: readTrialBalance(rows) }] };
    }
    return { accounts: [], entries: readJournal(rows) };
  } catch (e) {
    if (e instanceof BookImportError) throw new LedgerError(e.message, e.details);
    if (e instanceof XlsxError) throw new LedgerError(e.message);
    throw e;
  }
}

const clean = (s) => String(s ?? '').trim().toLowerCase().replace(/\s*\((a\/r|a\/p)\)\s*$/, '').replace(/\s+/g, ' ');
const RANGES = { asset: [1000, 1999], liability: [2000, 2999], equity: [3000, 3999], revenue: [4000, 4999], expense: [5000, 7999] };
const SUB_RANGES = {
  'asset.bank': [1000, 1099], 'asset.cash': [1000, 1099], 'asset.receivable': [1100, 1199], 'asset.current': [1200, 1499],
  'asset.fixed': [1500, 1589], 'asset.contra': [1590, 1599], 'asset.investment': [1600, 1999],
  'liability.payable': [2000, 2099], 'liability.credit_card': [2100, 2199], 'liability.current': [2200, 2599], 'liability.long_term': [2600, 2999],
  'equity.capital': [3000, 3099], 'equity.draws': [3100, 3199],
  'revenue.operating': [4000, 4899], 'revenue.other': [4900, 4999],
  'expense.cogs': [5000, 5999], 'expense.operating': [6000, 6999], 'expense.other': [7000, 7999],
};

/**
 * Account resolver: finds each name/code from the file among the company's accounts, or creates it
 * when the file defines it (IIF account list, chart-of-accounts import). Common QuickBooks names
 * are understood ("Opening Balance Equity", "Undeposited Funds", "Accounts Receivable (A/R)").
 */
async function makeResolver(c, companyId, defined) {
  const { rows } = await c.query('SELECT id, code, name, type, subtype, system_key, is_active FROM accounts WHERE company_id = $1', [companyId]);
  const byCode = new Map(rows.map((a) => [a.code.toLowerCase(), a]));
  const byName = new Map(rows.map((a) => [clean(a.name), a]));
  const created = [];
  const defs = new Map(defined.map((d) => [clean(d.name), d]));
  for (const d of defined) if (d.code) defs.set(`#${d.code.toLowerCase()}`, d);
  const usedCodes = new Set(rows.map((a) => a.code));

  // New accounts are numbered in the usual block for their kind (bank 1000s, receivables 1100s …).
  const nextCode = (type, subtype) => {
    const [lo, hi] = SUB_RANGES[`${type}.${subtype}`] ?? RANGES[type];
    const nums = [...usedCodes].map(Number).filter((n) => Number.isInteger(n) && n >= lo && n <= hi);
    let n = nums.length ? Math.ceil((Math.max(...nums) + 1) / 10) * 10 : lo;
    if (n > hi) n = lo;
    while (usedCodes.has(String(n)) && n <= hi) n++;
    if (n > hi) {
      if (SUB_RANGES[`${type}.${subtype}`]) return nextCode(type, null); // block full: anywhere in the type's range
      throw new LedgerError(`No free account number left between ${lo} and ${hi}`);
    }
    return String(n);
  };

  async function create(def, sourceName) {
    if (!Object.hasOwn(ACCOUNT_SUBTYPES[def.type] ?? {}, def.subtype)) throw new LedgerError(`Account "${sourceName}": subtype ${def.subtype} is not valid for ${def.type}`);
    let code = def.code && /^[0-9A-Za-z.-]{1,20}$/.test(def.code) && !usedCodes.has(def.code) ? def.code : nextCode(def.type, def.subtype);
    const { rows: [a] } = await c.query(
      `INSERT INTO accounts (company_id, code, name, type, subtype, cash_flow) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, code, name, type, subtype, system_key, is_active`,
      [companyId, code, def.name.slice(0, 100), def.type, def.subtype, ACCOUNT_SUBTYPES[def.type][def.subtype]]);
    usedCodes.add(code);
    byCode.set(code.toLowerCase(), a);
    byName.set(clean(a.name), a);
    created.push({ id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype, from: sourceName });
    return a;
  }

  const WELL_KNOWN = {
    'opening balance equity': { type: 'equity', subtype: 'capital' },
    'undeposited funds': { type: 'asset', subtype: 'current' },
    'payroll liabilities': { type: 'liability', subtype: 'current' },
    'ask my accountant': { type: 'expense', subtype: 'other' },
    'uncategorized expense': { type: 'expense', subtype: 'operating' },
    'uncategorized income': { type: 'revenue', subtype: 'operating' },
    'uncategorized asset': { type: 'asset', subtype: 'current' },
  };

  /** Find (or create) the account for a file's account text. Returns the account or throws with a clear message. */
  async function resolve(text) {
    const raw = String(text ?? '').trim();
    if (!raw) throw new LedgerError('A line has no account');
    const lc = raw.toLowerCase();
    if (byCode.has(lc)) return byCode.get(lc);
    // "6300 Rent", "6300 · Rent", "6300 - Rent"
    const m = /^([0-9][0-9A-Za-z.-]{0,19})\s*(?:·|-|–|:)?\s+(.+)$/.exec(raw);
    if (m && byCode.has(m[1].toLowerCase())) return byCode.get(m[1].toLowerCase());
    const name = clean(m ? m[2] : raw);
    if (byName.has(clean(raw))) return byName.get(clean(raw));
    if (byName.has(name)) return byName.get(name);
    // QuickBooks sub-accounts "Utilities:Electric" — match the full name, then the last part.
    const leaf = clean(raw.split(':').at(-1));
    if (raw.includes(':') && byName.has(leaf)) return byName.get(leaf);
    const def = defs.get(clean(raw)) ?? (m ? defs.get(`#${m[1].toLowerCase()}`) : null) ?? defs.get(name);
    if (def) return create({ ...def, code: def.code ?? (m ? m[1] : null) }, raw);
    if (WELL_KNOWN[name]) return create({ name: m ? m[2] : raw, code: m ? m[1] : null, ...WELL_KNOWN[name] }, raw);
    throw new LedgerError(`Account "${raw}" is not in your chart of accounts. Import your chart of accounts first, or add the account on the Accounts page.`);
  }
  return { resolve, create, created, byName, byCode };
}

async function runImport(c, companyId, { kind, file, asOf, actor }) {
  const parsed = parseFile(kind, file, asOf);
  const co = await lockCompany(c, companyId);
  const batch = randomUUID();
  const r = await makeResolver(c, companyId, parsed.accounts);
  const problems = [];
  const matchedAccounts = [];

  // Accounts listed in the file: create the ones we don't have (by code or name).
  for (const def of parsed.accounts) {
    // Same name = same account. Same number but a different name is a different account: it gets the
    // next free number instead (e.g. QuickBooks "1010 Operating Checking" vs our "1010 Savings").
    const byNum = def.code ? r.byCode.get(def.code.toLowerCase()) : null;
    const existing = r.byName.get(clean(def.name)) ?? (byNum && clean(byNum.name) === clean(def.name) ? byNum : null);
    if (existing) {
      if (existing.type !== def.type) problems.push(`"${def.name}" is a${/^[aeiou]/.test(def.type) ? 'n' : ''} ${def.type} account in the file but ${existing.code} ${existing.name} here is a${/^[aeiou]/.test(existing.type) ? 'n' : ''} ${existing.type}`);
      else matchedAccounts.push({ from: def.name, code: existing.code, name: existing.name });
    } else await r.create(def, def.name);
  }

  // Entries
  const fileTotals = new Map(); // accountId → net (debit − credit) from the file
  const posted = [];
  for (const e of parsed.entries) {
    if (co.locked_through && e.date <= co.locked_through) { problems.push(`entry dated ${e.date} (row ${e.row}) is in a closed period (books closed through ${co.locked_through})`); continue; }
    const lines = [];
    for (const l of e.lines) {
      try {
        const a = await r.resolve(l.account);
        if (!a.is_active) throw new LedgerError(`Account ${a.code} ${a.name} is inactive`);
        lines.push({ accountId: a.id, debitCents: l.debitCents, creditCents: l.creditCents, memo: l.memo });
        fileTotals.set(a.id, (fileTotals.get(a.id) ?? 0) + l.debitCents - l.creditCents);
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err;
        if (!problems.includes(err.message)) problems.push(err.message);
      }
    }
    if (lines.length !== e.lines.length) continue;
    const entry = validateEntry({ date: e.date, memo: e.memo, lines });
    if (problems.length) continue; // keep checking the rest of the file, but don't post once something is wrong
    const je = await insertEntry(c, companyId, entry, { source: 'import', sourceRef: batch, actor });
    posted.push({ number: je.entry_number, date: e.date, memo: e.memo, totalCents: entry.totalCents });
  }
  if (problems.length) throw new LedgerError(`${problems.length} problem(s) — nothing was imported`, problems.slice(0, 50));

  // Verify: what landed in the ledger equals the file, account by account, to the penny.
  const { rows: sums } = await c.query(
    `SELECT l.account_id, sum(l.debit_cents - l.credit_cents)::bigint AS net
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.company_id = $1 AND e.source = 'import' AND e.source_ref = $2 GROUP BY l.account_id`, [companyId, batch]);
  const ledger = new Map(sums.map((s) => [s.account_id, s.net]));
  const ids = new Set([...ledger.keys(), ...fileTotals.keys()]);
  const mismatched = [...ids].filter((id) => (ledger.get(id) ?? 0) !== (fileTotals.get(id) ?? 0));
  if (mismatched.length) throw new Error(`Import verification failed for ${mismatched.length} account(s)`); // should be impossible; aborts everything

  const accountsById = new Map([...r.byCode.values()].map((a) => [a.id, a]));
  const totals = [...fileTotals.entries()].map(([id, net]) => ({ code: accountsById.get(id)?.code, name: accountsById.get(id)?.name, netCents: net }))
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const dates = parsed.entries.map((e) => e.date).sort();
  const summary = {
    batch, kind, fileName: String(file.fileName ?? '').slice(0, 200),
    accountsCreated: r.created, accountsMatched: matchedAccounts.length,
    entries: posted.length, lines: parsed.entries.reduce((s, e) => s + e.lines.length, 0),
    totalCents: posted.reduce((s, p) => s + p.totalCents, 0),
    firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null,
    accountTotals: totals, verified: true, ignored: parsed.ignored ?? [],
    sample: posted.slice(0, 15),
  };
  if (parsed.entries.length) {
    const tb = await getTrialBalance(c, companyId, { asOf: summary.lastDate });
    summary.trialBalance = { asOf: summary.lastDate, balanced: tb.balanced, totalDebits: tb.totalDebits, totalCredits: tb.totalCredits };
  }
  return summary;
}

/** Dry run: does the whole import inside a transaction, reports the result, and rolls it all back. */
export async function previewImport(pool, companyId, opts) {
  if (!IMPORT_KINDS.includes(opts.kind)) throw new LedgerError(`kind must be one of ${IMPORT_KINDS.join(', ')}`);
  try {
    await withTransaction(pool, async (c) => { throw new PreviewDone(await runImport(c, companyId, opts)); });
  } catch (e) {
    if (e instanceof PreviewDone) return { ...e.result, preview: true, batch: null };
    throw e;
  }
  return null;
}

export async function commitImport(pool, companyId, opts) {
  if (!IMPORT_KINDS.includes(opts.kind)) throw new LedgerError(`kind must be one of ${IMPORT_KINDS.join(', ')}`);
  return withTransaction(pool, async (c) => {
    const s = await runImport(c, companyId, opts);
    await c.query(
      `INSERT INTO import_batches (id, company_id, kind, file_name, entry_count, total_cents, summary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [s.batch, companyId, s.kind, s.fileName, s.entries, s.totalCents, JSON.stringify({ ...s, sample: undefined }), opts.actor ?? null]);
    await appendAudit(c, companyId, { action: 'import', entity: 'books', entityId: s.batch, actor: opts.actor ?? null,
      payload: { kind: s.kind, fileName: s.fileName, entries: s.entries, totalCents: s.totalCents, accountsCreated: s.accountsCreated.map((a) => a.code) } });
    return s;
  });
}

export async function listImports(db, companyId) {
  const { rows } = await db.query('SELECT * FROM import_batches WHERE company_id = $1 ORDER BY created_at DESC', [companyId]);
  return rows.map((b) => ({ id: b.id, kind: b.kind, fileName: b.file_name, entries: b.entry_count, totalCents: b.total_cents, status: b.status,
    createdAt: b.created_at, createdBy: b.created_by, undoneAt: b.undone_at, accountsCreated: b.summary.accountsCreated?.length ?? 0,
    firstDate: b.summary.firstDate, lastDate: b.summary.lastDate }));
}

/** Undo an import: reverse every entry it posted (dated like the originals, or the first open day). */
export async function undoImport(pool, companyId, batchId, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [b] } = await c.query('SELECT * FROM import_batches WHERE company_id = $1 AND id::text = $2 FOR UPDATE', [companyId, String(batchId)]);
    if (!b) throw new LedgerError('Import not found');
    if (b.status !== 'posted') throw new LedgerError('This import was already undone');
    const { rows: entries } = await c.query(
      `SELECT e.id FROM journal_entries e WHERE e.company_id = $1 AND e.source = 'import' AND e.source_ref = $2
          AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id) ORDER BY e.entry_number`, [companyId, b.id]);
    const { rows: [linked] } = await c.query(
      `SELECT 1 FROM bank_transactions bt JOIN journal_entries e ON e.id = bt.journal_entry_id
        WHERE bt.company_id = $1 AND e.source = 'import' AND e.source_ref = $2 LIMIT 1`, [companyId, b.id]);
    if (linked) throw new LedgerError('Some imported entries are matched to bank transactions; undo those matches first');
    for (const e of entries) await reverseEntry(c, companyId, e.id, { memo: `Undo import ${b.file_name || b.id}`.slice(0, 500), actor });
    await c.query(`UPDATE import_batches SET status = 'undone', undone_at = now(), undone_by = $3 WHERE company_id = $1 AND id = $2`, [companyId, b.id, actor]);
    await appendAudit(c, companyId, { action: 'undo_import', entity: 'books', entityId: b.id, actor, payload: { reversed: entries.length } });
    return { reversed: entries.length };
  });
}
