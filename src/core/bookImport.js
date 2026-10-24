// Reading books from other software: QuickBooks (IIF, or CSV reports) and our own Excel/CSV
// templates. Pure functions: they turn a file into a plain list of accounts and entries, and report
// every problem with its row number. The service layer then matches accounts and posts.
import { parseCsv, parseBankDate } from './bankImport.js';
import { toCents } from './money.js';

export class BookImportError extends Error {
  constructor(message, details = []) { super(details.length ? `${message}: ${details.slice(0, 5).join('; ')}${details.length > 5 ? ` (and ${details.length - 5} more)` : ''}` : message); this.name = 'BookImportError'; this.details = details; }
}

export const MAX_IMPORT_LINES = 20_000;

// QuickBooks account types → our type/subtype. (IIF short codes and the names QuickBooks shows.)
const QB_TYPES = {
  bank: ['asset', 'bank'], accountsreceivable: ['asset', 'receivable'], ar: ['asset', 'receivable'],
  othercurrentasset: ['asset', 'current'], ocasset: ['asset', 'current'], fixedasset: ['asset', 'fixed'], fixasset: ['asset', 'fixed'],
  otherasset: ['asset', 'investment'], oasset: ['asset', 'investment'],
  accountspayable: ['liability', 'payable'], ap: ['liability', 'payable'], creditcard: ['liability', 'credit_card'], ccard: ['liability', 'credit_card'],
  othercurrentliability: ['liability', 'current'], ocliab: ['liability', 'current'], longtermliability: ['liability', 'long_term'], ltliab: ['liability', 'long_term'],
  equity: ['equity', 'capital'], income: ['revenue', 'operating'], inc: ['revenue', 'operating'], otherincome: ['revenue', 'other'], exinc: ['revenue', 'other'],
  costofgoodssold: ['expense', 'cogs'], cogs: ['expense', 'cogs'], expense: ['expense', 'operating'], exp: ['expense', 'operating'],
  otherexpense: ['expense', 'other'], exexp: ['expense', 'other'],
  // Our own template's words
  asset: ['asset', 'current'], liability: ['liability', 'current'], revenue: ['revenue', 'operating'],
};
const OUR_SUBTYPES = new Set(['bank', 'cash', 'receivable', 'current', 'fixed', 'contra', 'investment', 'payable', 'credit_card', 'long_term', 'capital', 'draws', 'operating', 'other', 'cogs']);

/** Map a type (+ optional detail/subtype) to [type, subtype]; null if unknown. */
export function mapAccountType(typeText, subtypeText = '') {
  const t = String(typeText ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const m = QB_TYPES[t];
  if (!m) return null;
  const sub = String(subtypeText ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  if (OUR_SUBTYPES.has(sub)) return [m[0], sub];
  if (m[0] === 'asset' && /accumulated_?depreciation/.test(sub)) return ['asset', 'contra'];
  if (m[0] === 'equity' && /draw|distribution/.test(sub)) return ['equity', 'draws'];
  return [...m];
}

const norm = (h) => String(h ?? '').toLowerCase().replace(/[^a-z#]/g, '');
const findCol = (header, names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
function headerRow(rows, mustHave) {
  const i = rows.findIndex((r) => mustHave.every((names) => r.some((h) => names.includes(norm(h)))));
  return i;
}
const money = (s) => {
  const v = String(s ?? '').trim();
  if (!v) return 0;
  return toCents(v);
};

/** Chart of accounts: our template (Code, Name, Type, Subtype) or QuickBooks "Account List" (Account, Type, Detail Type, Account #). */
export function readAccountsTable(rows) {
  const NAMES = { code: ['code', 'account#', 'accountnumber', 'number', 'accnum', 'num'], name: ['name', 'account', 'accountname', 'fullname'], type: ['type', 'accounttype', 'accnttype'], sub: ['subtype', 'detailtype', 'detail'] };
  const h = headerRow(rows, [NAMES.name, NAMES.type]);
  if (h < 0) throw new BookImportError('Could not find "Name" and "Type" columns');
  const header = rows[h].map(norm);
  const c = { code: findCol(header, NAMES.code), name: findCol(header, NAMES.name), type: findCol(header, NAMES.type), sub: findCol(header, NAMES.sub) };
  const accounts = [];
  const errors = [];
  rows.slice(h + 1).forEach((r, i) => {
    const name = String(r[c.name] ?? '').trim();
    if (!name || /^total/i.test(name)) return;
    const mapped = mapAccountType(r[c.type], c.sub >= 0 ? r[c.sub] : '');
    if (!mapped) { errors.push(`row ${h + i + 2}: account type "${r[c.type] ?? ''}" is not recognized`); return; }
    accounts.push({ code: c.code >= 0 ? String(r[c.code] ?? '').trim() || null : null, name: name.slice(0, 100), type: mapped[0], subtype: mapped[1] });
  });
  if (errors.length) throw new BookImportError(`${errors.length} account row(s) could not be read`, errors);
  return accounts;
}

/** Opening balances from a trial balance: Account, Debit, Credit (or a signed Balance). */
export function readTrialBalance(rows) {
  const NAMES = { account: ['account', 'accountname', 'name', 'code', 'account#'], debit: ['debit', 'debits', 'dr'], credit: ['credit', 'credits', 'cr'], balance: ['balance', 'amount'] };
  const h = headerRow(rows, [NAMES.account]);
  if (h < 0) throw new BookImportError('Could not find an "Account" column');
  const header = rows[h].map(norm);
  const c = { account: findCol(header, NAMES.account), debit: findCol(header, NAMES.debit), credit: findCol(header, NAMES.credit), balance: findCol(header, NAMES.balance) };
  if ((c.debit < 0 || c.credit < 0) && c.balance < 0) throw new BookImportError('Could not find "Debit" and "Credit" columns');
  const lines = [];
  const errors = [];
  rows.slice(h + 1).forEach((r, i) => {
    const account = String(r[c.account] ?? '').trim();
    if (!account || /^total/i.test(account)) return;
    try {
      let d; let cr;
      if (c.debit >= 0 && c.credit >= 0) { d = money(r[c.debit]); cr = money(r[c.credit]); }
      else { const b = money(r[c.balance]); d = b > 0 ? b : 0; cr = b < 0 ? -b : 0; }
      if (d < 0) { cr += -d; d = 0; }
      if (cr < 0) { d += -cr; cr = 0; }
      if (d && cr) { const net = d - cr; d = net > 0 ? net : 0; cr = net < 0 ? -net : 0; }
      if (d || cr) lines.push({ account, debitCents: d, creditCents: cr, row: h + i + 2 });
    } catch { errors.push(`row ${h + i + 2}: amount is not a number`); }
  });
  if (errors.length) throw new BookImportError(`${errors.length} row(s) could not be read`, errors);
  if (!lines.length) throw new BookImportError('No balances found');
  return lines;
}

/**
 * Journal / transaction detail. Works with our template (Entry, Date, Memo, Account, Debit, Credit)
 * and QuickBooks "Journal" or "Transaction Detail by Account" CSV exports. Lines are grouped into
 * entries by the Entry / Trans # / Num column; without one, a new entry starts on each row that has
 * a date (QuickBooks prints the date only on the first line of each transaction).
 */
export function readJournal(rows) {
  const NAMES = {
    date: ['date', 'transactiondate', 'trnsdate'], account: ['account', 'accountname', 'accnt', 'splitaccount', 'distributionaccount'],
    debit: ['debit', 'debits', 'dr'], credit: ['credit', 'credits', 'cr'], amount: ['amount'],
    ref: ['entry', 'entry#', 'entryref', 'trans#', 'transaction#', 'transactionid', 'journal#', 'jenumber', 'trnsid'],
    num: ['num', 'no', 'docnum', 'number'], memo: ['memo', 'memodescription', 'description', 'memo/description'], name: ['name', 'payee'], type: ['transactiontype', 'type', 'trnstype'],
  };
  const h = headerRow(rows, [NAMES.date, NAMES.account]);
  if (h < 0) throw new BookImportError('Could not find "Date" and "Account" columns');
  const header = rows[h].map(norm);
  const c = Object.fromEntries(Object.entries(NAMES).map(([k, names]) => [k, findCol(header, names)]));
  if ((c.debit < 0 || c.credit < 0) && c.amount < 0) throw new BookImportError('Could not find "Debit" and "Credit" columns (or a signed "Amount")');
  const entries = [];
  const errors = [];
  let cur = null;
  let lastRef = null;
  let lineCount = 0;
  rows.slice(h + 1).forEach((r, i) => {
    const rowNo = h + i + 2;
    const account = String(r[c.account] ?? '').trim();
    const dateText = String(r[c.date] ?? '').trim();
    if (!account || /^total/i.test(account) || /^total/i.test(String(r[0] ?? '').trim())) return; // section headers, totals
    const ref = c.ref >= 0 ? String(r[c.ref] ?? '').trim() : null;
    const startNew = c.ref >= 0 ? (ref && ref !== lastRef) || !cur : Boolean(dateText) || !cur;
    if (startNew) {
      const date = parseBankDate(dateText);
      if (!date) { errors.push(`row ${rowNo}: date "${dateText}" is not a date`); cur = null; return; }
      const memo = [c.type >= 0 ? r[c.type] : '', c.num >= 0 && r[c.num] ? `#${r[c.num]}` : '', c.name >= 0 ? r[c.name] : '', c.memo >= 0 ? r[c.memo] : '']
        .map((x) => String(x ?? '').trim()).filter(Boolean).join(' · ');
      cur = { ref: ref || `row ${rowNo}`, row: rowNo, date, memo: memo.slice(0, 500) || null, lines: [] };
      entries.push(cur);
      lastRef = ref;
    } else if (!cur) return;
    try {
      let d; let cr;
      if (c.debit >= 0 && c.credit >= 0) { d = money(r[c.debit]); cr = money(r[c.credit]); }
      else { const a = money(r[c.amount]); d = a > 0 ? a : 0; cr = a < 0 ? -a : 0; }
      if (d < 0) { cr += -d; d = 0; }
      if (cr < 0) { d += -cr; cr = 0; }
      if (!d && !cr) return;
      if (d && cr) { const net = d - cr; if (!net) return; d = net > 0 ? net : 0; cr = net < 0 ? -net : 0; }
      const lineMemo = c.memo >= 0 && !startNew ? String(r[c.memo] ?? '').trim().slice(0, 500) || null : null;
      cur.lines.push({ account, debitCents: d, creditCents: cr, memo: lineMemo, row: rowNo });
      if (++lineCount > MAX_IMPORT_LINES) throw new BookImportError(`At most ${MAX_IMPORT_LINES} lines per import; split the file by date`);
    } catch (e) {
      if (e instanceof BookImportError) throw e;
      errors.push(`row ${rowNo}: amount is not a number`);
    }
  });
  for (const e of entries) {
    const d = e.lines.reduce((s, l) => s + l.debitCents, 0);
    const cr = e.lines.reduce((s, l) => s + l.creditCents, 0);
    if (e.lines.length < 2) errors.push(`entry starting row ${e.row}: needs at least two lines`);
    else if (d !== cr) errors.push(`entry starting row ${e.row} (${e.date}): debits ${(d / 100).toFixed(2)} ≠ credits ${(cr / 100).toFixed(2)}`);
  }
  if (errors.length) throw new BookImportError(`${errors.length} problem(s) in the file`, errors);
  if (!entries.length) throw new BookImportError('No entries found');
  return entries;
}

/**
 * QuickBooks IIF (tab-separated). Reads the account list (!ACCNT) and transactions (!TRNS / !SPL /
 * ENDTRNS; positive AMOUNT = debit). Customer, vendor and item lists are ignored.
 */
export function readIif(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const headers = {};
  const accounts = [];
  const entries = [];
  const errors = [];
  let cur = null;
  const ignored = new Set();
  let lineCount = 0;
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    const f = raw.split('\t');
    const kind = f[0].trim();
    if (kind.startsWith('!')) { headers[kind.slice(1).toUpperCase()] = f.map((x) => x.trim().toUpperCase()); return; }
    const K = kind.toUpperCase();
    const h = headers[K];
    const get = (name) => { const j = h ? h.indexOf(name) : -1; return j >= 0 ? String(f[j] ?? '').trim().replace(/^"|"$/g, '') : ''; };
    if (K === 'ACCNT') {
      const mapped = mapAccountType(get('ACCNTTYPE'));
      if (!mapped) errors.push(`line ${i + 1}: account type "${get('ACCNTTYPE')}" is not recognized`);
      else accounts.push({ code: get('ACCNUM') || null, name: get('NAME').slice(0, 100), type: mapped[0], subtype: mapped[1] });
    } else if (K === 'TRNS') {
      if (cur) errors.push(`line ${i + 1}: previous transaction has no ENDTRNS`);
      const date = parseBankDate(get('DATE'));
      if (!date) { errors.push(`line ${i + 1}: date "${get('DATE')}" is not a date`); cur = null; return; }
      const memo = [get('TRNSTYPE'), get('DOCNUM') ? `#${get('DOCNUM')}` : '', get('NAME'), get('MEMO')].filter(Boolean).join(' · ');
      cur = { ref: get('TRNSID') || `line ${i + 1}`, row: i + 1, date, memo: memo.slice(0, 500) || null, lines: [] };
      addLine(cur, get, i);
    } else if (K === 'SPL') {
      if (!cur) { errors.push(`line ${i + 1}: SPL without TRNS`); return; }
      addLine(cur, get, i);
    } else if (K === 'ENDTRNS') {
      if (cur) entries.push(cur);
      cur = null;
    } else ignored.add(K);
  });
  function addLine(e, get, i) {
    let a;
    try { a = toCents(get('AMOUNT') || '0'); } catch { errors.push(`line ${i + 1}: amount "${get('AMOUNT')}" is not a number`); return; }
    if (!a) return;
    e.lines.push({ account: get('ACCNT'), debitCents: a > 0 ? a : 0, creditCents: a < 0 ? -a : 0, memo: null, row: i + 1 });
    if (++lineCount > MAX_IMPORT_LINES) errors.push(`more than ${MAX_IMPORT_LINES} lines`);
  }
  if (cur) errors.push('the last transaction has no ENDTRNS');
  for (const e of entries) {
    const d = e.lines.reduce((s, l) => s + l.debitCents, 0);
    const cr = e.lines.reduce((s, l) => s + l.creditCents, 0);
    if (e.lines.length < 2 || d !== cr) errors.push(`transaction at line ${e.row} (${e.date}) does not balance`);
  }
  if (errors.length) throw new BookImportError(`${errors.length} problem(s) in the IIF file`, errors);
  if (!accounts.length && !entries.length) throw new BookImportError('No accounts or transactions found in the IIF file');
  return { accounts, entries, ignored: [...ignored] };
}

/** Turn file content into rows: CSV text, or an .xlsx (given as base64). */
export function rowsFromFile({ fileName = '', content, base64 = null }, readXlsx) {
  if (base64 != null || /\.xlsx$/i.test(fileName)) {
    if (typeof base64 !== 'string') throw new BookImportError('Excel file was not received');
    return readXlsx(Buffer.from(base64, 'base64'));
  }
  return parseCsv(String(content ?? '').replace(/^﻿/, ''));
}
