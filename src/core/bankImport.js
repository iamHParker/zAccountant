// Reading bank statement files (CSV and OFX/QFX). Pure functions, no database.
//
// Every bank formats its CSV export a little differently, so the CSV reader looks for the columns
// it needs by name: a date, a description, and either one signed "Amount" column or separate
// "Debit"/"Credit" (or "Withdrawal"/"Deposit") columns. Amounts come back as integer cents,
// positive = money into the account, negative = money out.
import { createHash } from 'node:crypto';
import { toCents } from './money.js';
import { isIsoDate } from './ledger.js';

export class ImportError extends Error {
  constructor(message, details = []) { super(details.length ? `${message}: ${details.slice(0, 5).join('; ')}` : message); this.name = 'ImportError'; this.details = details; }
}

export const MAX_IMPORT_ROWS = 5000;

/** Split CSV text into rows of fields (handles quotes, doubled quotes, commas and newlines inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** Bank dates: 2026-03-05, 03/05/2026, 3/5/26, 20260305. US month/day order. */
export function parseBankDate(s) {
  s = String(s ?? '').trim();
  let y; let m; let d;
  let r;
  if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) [, y, m, d] = r;
  else if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s|$)/.exec(s))) { [, m, d, y] = r; if (y.length === 2) y = `20${y}`; }
  else if ((r = /^(\d{4})(\d{2})(\d{2})/.exec(s))) [, y, m, d] = r;
  else return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

const norm = (h) => h.toLowerCase().replace(/[^a-z]/g, '');
const COLUMN_NAMES = {
  date: ['date', 'postingdate', 'posteddate', 'transactiondate', 'postdate', 'effectivedate'],
  description: ['description', 'payee', 'name', 'details', 'memo', 'transactiondescription', 'merchant'],
  amount: ['amount', 'transactionamount', 'amountusd'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'moneyout', 'debitamount', 'paymentsdebits'],
  credit: ['credit', 'deposit', 'deposits', 'moneyin', 'creditamount', 'depositscredits'],
  id: ['transactionid', 'fitid', 'referencenumber', 'reference', 'id'],
};

/**
 * Read a bank CSV export. Returns [{ date, amountCents, description, fitId|null }].
 * Throws ImportError listing every bad row (nothing is imported if any row is bad).
 */
export function readCsvStatement(text) {
  const rows = parseCsv(String(text ?? '').replace(/^﻿/, ''));
  if (rows.length < 2) throw new ImportError('The file has no transactions');
  // The header is the first row that names a date column (some banks put account info above it).
  const headerIdx = rows.findIndex((r) => r.some((h) => COLUMN_NAMES.date.includes(norm(h))));
  if (headerIdx < 0) throw new ImportError('Could not find a "Date" column in the file');
  const header = rows[headerIdx].map(norm);
  // Names are listed in order of preference ("Description" beats "Details").
  const col = (k) => { for (const name of COLUMN_NAMES[k]) { const i = header.indexOf(name); if (i >= 0) return i; } return -1; };
  const c = { date: col('date'), description: col('description'), amount: col('amount'), debit: col('debit'), credit: col('credit'), id: col('id') };
  if (c.amount < 0 && (c.debit < 0 || c.credit < 0)) throw new ImportError('Could not find an "Amount" column (or "Debit" and "Credit" columns)');
  const body = rows.slice(headerIdx + 1);
  if (body.length > MAX_IMPORT_ROWS) throw new ImportError(`A file can have at most ${MAX_IMPORT_ROWS} transactions; split it by date range`);
  const out = [];
  const errors = [];
  body.forEach((r, i) => {
    const line = headerIdx + i + 2;
    const date = parseBankDate(r[c.date]);
    let amountCents;
    try {
      if (c.amount >= 0) amountCents = toCents(r[c.amount]);
      else {
        const dr = (r[c.debit] ?? '').trim();
        const cr = (r[c.credit] ?? '').trim();
        // Some banks show withdrawals as negative numbers in the Debit column; treat the sign as "out" either way.
        amountCents = (cr ? Math.abs(toCents(cr)) : 0) - (dr ? Math.abs(toCents(dr)) : 0);
      }
    } catch { amountCents = null; }
    if (!date) errors.push(`row ${line}: date "${r[c.date] ?? ''}" is not a date`);
    else if (amountCents === null) errors.push(`row ${line}: amount is not a number`);
    else if (amountCents === 0) return; // zero rows (balance lines, holds) carry no money
    else out.push({ date, amountCents, description: (r[c.description] ?? '').trim().slice(0, 300), fitId: c.id >= 0 ? (r[c.id] ?? '').trim().slice(0, 100) || null : null });
  });
  if (errors.length) throw new ImportError(`${errors.length} row(s) could not be read`, errors);
  return out;
}

/** Read an OFX / QFX ("Quicken / Money") download — both the old SGML style and XML. */
export function readOfxStatement(text) {
  text = String(text ?? '');
  if (!/<OFX>/i.test(text)) throw new ImportError('This is not an OFX/QFX file');
  const tag = (block, name) => {
    const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block);
    return m ? m[1].trim() : null;
  };
  const blocks = text.split(/<STMTTRN>/i).slice(1).map((b) => b.split(/<\/STMTTRN>/i)[0]);
  if (blocks.length > MAX_IMPORT_ROWS) throw new ImportError(`A file can have at most ${MAX_IMPORT_ROWS} transactions`);
  const out = [];
  const errors = [];
  blocks.forEach((b, i) => {
    const date = parseBankDate(tag(b, 'DTPOSTED'));
    let amountCents = null;
    try { amountCents = toCents(tag(b, 'TRNAMT') ?? ''); } catch { /* reported below */ }
    if (!date || amountCents === null) { errors.push(`transaction ${i + 1}: missing date or amount`); return; }
    if (amountCents === 0) return;
    const name = tag(b, 'NAME') ?? '';
    const memo = tag(b, 'MEMO') ?? '';
    const description = (memo && !name.includes(memo) ? `${name} ${memo}` : name || memo).replace(/&amp;/g, '&').trim().slice(0, 300);
    out.push({ date, amountCents, description, fitId: (tag(b, 'FITID') ?? '').slice(0, 100) || null });
  });
  if (errors.length) throw new ImportError(`${errors.length} transaction(s) could not be read`, errors);
  return out;
}

export function readStatement(text, fileName = '') {
  return /<OFX>/i.test(String(text ?? '').slice(0, 5000)) || /\.(ofx|qfx)$/i.test(fileName) ? readOfxStatement(text) : readCsvStatement(text);
}

/**
 * A stable fingerprint per transaction, so importing the same file (or an overlapping one) twice
 * never creates duplicates. Uses the bank's own id when it gives one; otherwise date + amount +
 * description + which repeat this is (two identical $5.00 coffees on the same day are both kept).
 */
export function dedupeKeys(txns) {
  const seen = new Map();
  return txns.map((t) => {
    if (t.fitId) return `fit:${t.fitId}`;
    const base = `${t.date}|${t.amountCents}|${t.description.toLowerCase().replace(/\s+/g, ' ')}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `h:${createHash('sha256').update(`${base}|${n}`).digest('hex').slice(0, 40)}`;
  });
}

/**
 * Pick the first matching categorization rule. Rules: { id, matchText, direction: 'in'|'out'|'any',
 * minCents, maxCents, accountId, priority }. Text match is case-insensitive "contains".
 */
export function applyRules(rules, t) {
  const desc = t.description.toLowerCase();
  const abs = Math.abs(t.amountCents);
  const dir = t.amountCents > 0 ? 'in' : 'out';
  return [...rules].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
    .find((r) => desc.includes(r.matchText.toLowerCase())
      && (r.direction === 'any' || r.direction === dir)
      && (r.minCents == null || abs >= r.minCents)
      && (r.maxCents == null || abs <= r.maxCents)) ?? null;
}
