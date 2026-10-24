// What a company sets up once for its invoices: saved rates and items, the usual sales tax rate, the logo
// and the letterhead (address, tax ID / firm number note, closing line).
//
// ℹ️ A saved rate is like a standard detail on a drawing: pick it and the line fills itself in (name,
// hourly rate, taxable or not, income account), and anything can still be changed on that one invoice.
// Changing a saved rate never changes invoices already sent; each invoice line keeps the numbers it was saved with.
import { withTransaction } from '../db/pool.js';
import { LedgerError } from '../core/ledger.js';
import { toCents, percentToPpm } from '../core/money.js';
import { appendAudit } from './audit.js';
import { readPicture } from './feedbackService.js';

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['service', 'expense'];
export const MAX_LOGO_BYTES = 1_048_576;

/**
 * A starting list for an engineering firm (Homer's rates). No prices: each firm types its own.
 * Services are billed by the hour; expenses are costs passed on to the client, untaxed, usually quantity 1.
 */
export const STARTER_ITEMS = [
  { name: 'Eng Std Rate', kind: 'service' },
  { name: 'Eng Overtime Rate', kind: 'service' },
  { name: 'Eng Depo/Arb/Trial Rate', kind: 'service' },
  { name: 'Eng Volume Rate', kind: 'service' },
  { name: 'Drafting', kind: 'service' },
  { name: 'Office worker', kind: 'service' },
  { name: 'Equipment rental', kind: 'expense' },
  { name: 'Lodging (motel)', kind: 'expense' },
  { name: 'Rental car', kind: 'expense' },
  { name: 'Airfare', kind: 'expense' },
];

const lockCompany = async (c, companyId) => {
  const { rows: [co] } = await c.query('SELECT * FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  if (!co) throw new LedgerError('Company not found');
  return co;
};
const oneLineText = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim(); // eslint-disable-line no-control-regex
// Several lines allowed (an address); other control characters removed; at most `max` characters.
const blockText = (v, max, label) => {
  const t = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ') // eslint-disable-line no-control-regex
    .split('\n').map((l) => l.trim()).join('\n').trim();
  if (t.length > max) throw new LedgerError(`Keep the ${label} under ${max} characters`);
  return t || null;
};
export { blockText };

const itemOut = (r) => ({
  id: r.id, name: r.name, kind: r.kind, rateCents: r.rate_cents == null ? null : Number(r.rate_cents), taxable: r.taxable,
  accountId: r.account_id, accountCode: r.code ?? null, accountName: r.account_name ?? null, isActive: r.is_active,
});

// ---------------------------------------------------------------- Saved rates and items

export async function listItems(db, companyId, { includeInactive = false } = {}) {
  const { rows } = await db.query(
    `SELECT i.*, a.code, a.name AS account_name FROM invoice_items i JOIN accounts a ON a.id = i.account_id
      WHERE i.company_id = $1 AND (i.is_active OR $2) ORDER BY i.kind DESC, lower(i.name)`, [companyId, includeInactive]);
  return rows.map(itemOut);
}

async function checkItem(c, companyId, input, partial, errors) {
  const out = {};
  if (!partial || input.name !== undefined) {
    out.name = oneLineText(input.name);
    if (!out.name || out.name.length > 80) errors.push('name is required (up to 80 characters)');
  }
  if (!partial || input.kind !== undefined) {
    out.kind = input.kind ?? 'service';
    if (!KINDS.includes(out.kind)) errors.push('kind must be service (by the hour) or expense (a cost passed on)');
  }
  if (!partial || input.rate !== undefined) {
    if (input.rate == null || input.rate === '') out.rateCents = null;
    else {
      try { out.rateCents = toCents(input.rate); } catch { errors.push('rate is not a dollar amount'); }
      if (out.rateCents < 0) errors.push("rate can't be negative");
      if (out.rateCents > 100_000_000) errors.push('rate is too large');
    }
  }
  if (!partial || input.taxable !== undefined) out.taxable = input.taxable === true;
  if (!partial || input.accountId !== undefined) {
    const id = input.accountId;
    const { rows: [a] } = typeof id === 'string' && UUIDISH.test(id)
      ? await c.query('SELECT * FROM accounts WHERE company_id = $1 AND id = $2', [companyId, id]) : { rows: [] };
    if (!a || !a.is_active || a.type !== 'revenue') errors.push('choose the income account this rate is credited to');
    else out.accountId = a.id;
  }
  if (partial && input.isActive !== undefined) out.isActive = input.isActive !== false;
  return out;
}

async function nameTaken(c, companyId, name, exceptId = null) {
  const { rows } = await c.query('SELECT 1 FROM invoice_items WHERE company_id = $1 AND lower(trim(name)) = lower($2) AND id IS DISTINCT FROM $3',
    [companyId, name, exceptId]);
  return rows.length > 0;
}

export async function createItem(pool, companyId, { actor = null, ...input }) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const errors = [];
    const v = await checkItem(c, companyId, input, false, errors);
    if (errors.length) throw new LedgerError('Rate is not valid', errors);
    if (await nameTaken(c, companyId, v.name)) throw new LedgerError(`There is already a rate named "${v.name}"`);
    const { rows: [r] } = await c.query(
      `INSERT INTO invoice_items (company_id, name, kind, rate_cents, taxable, account_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [companyId, v.name, v.kind, v.rateCents, v.taxable, v.accountId, actor]);
    await appendAudit(c, companyId, { action: 'create', entity: 'invoice_item', entityId: r.id, actor, payload: v });
    return itemOut(r);
  });
}

export async function updateItem(pool, companyId, itemId, { actor = null, ...input }) {
  if (typeof itemId !== 'string' || !UUIDISH.test(itemId)) throw new LedgerError('Rate not found');
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [old] } = await c.query('SELECT * FROM invoice_items WHERE company_id = $1 AND id = $2 FOR UPDATE', [companyId, itemId]);
    if (!old) throw new LedgerError('Rate not found');
    const errors = [];
    const v = await checkItem(c, companyId, input, true, errors);
    if (errors.length) throw new LedgerError('Rate is not valid', errors);
    if (v.name && await nameTaken(c, companyId, v.name, old.id)) throw new LedgerError(`There is already a rate named "${v.name}"`);
    const cols = { name: 'name', kind: 'kind', rateCents: 'rate_cents', taxable: 'taxable', accountId: 'account_id', isActive: 'is_active' };
    const sets = []; const vals = [companyId, itemId];
    for (const [k, col] of Object.entries(cols)) if (v[k] !== undefined) { vals.push(v[k]); sets.push(`${col} = $${vals.length}`); }
    if (!sets.length) return itemOut(old);
    const { rows: [r] } = await c.query(`UPDATE invoice_items SET ${sets.join(', ')} WHERE company_id = $1 AND id = $2 RETURNING *`, vals);
    await appendAudit(c, companyId, { action: 'update', entity: 'invoice_item', entityId: r.id, actor, payload: v });
    return itemOut(r);
  });
}

/** Add the starter list (names only, no prices), skipping names the company already has. */
export async function addStarterItems(pool, companyId, { accountId, actor = null }) {
  return withTransaction(pool, async (c) => {
    let added = 0;
    for (const s of STARTER_ITEMS) {
      if (await nameTaken(c, companyId, s.name)) continue;
      await createItem(c, companyId, { ...s, rate: null, taxable: false, accountId, actor });
      added += 1;
    }
    return { added, items: await listItems(c, companyId) };
  });
}

// ---------------------------------------------------------------- Sales tax rate, letterhead and logo

/** The sales tax rate filled in on each new invoice ('' or null clears it). */
export async function setDefaultTaxRate(pool, companyId, { rate, actor = null }) {
  let r = rate == null ? '' : String(rate).trim();
  if (r === '0') r = '';
  if (r) {
    if (!/^\d{1,2}(\.\d{1,4})?$/.test(r)) throw new LedgerError('Sales tax rate must be a percent like 8.25');
    if (percentToPpm(r) > 200_000) throw new LedgerError('Sales tax rate must be 20% or less');
  }
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    await c.query('UPDATE companies SET default_sales_tax_rate = $2 WHERE id = $1', [companyId, r || null]);
    await appendAudit(c, companyId, { action: 'update_settings', entity: 'company', entityId: companyId, actor, payload: { defaultSalesTaxRate: r || null } });
    return { defaultSalesTaxRate: r || null };
  });
}

/** The invoice letterhead: address, a note (tax ID, firm registration number) and a closing line. */
export async function setLetterhead(pool, companyId, { address, note, footer, actor = null }) {
  const v = { address: blockText(address, 300, 'address'), note: blockText(note, 300, 'note'), footer: blockText(footer, 300, 'closing line') };
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    await c.query('UPDATE companies SET invoice_address = $2, invoice_note = $3, invoice_footer = $4 WHERE id = $1', [companyId, v.address, v.note, v.footer]);
    await appendAudit(c, companyId, { action: 'update_settings', entity: 'company', entityId: companyId, actor, payload: { letterhead: v } });
    return v;
  });
}

/** Store the company logo (a PNG or JPEG data: URL, already shrunk by the browser); null removes it. */
export async function setLogo(pool, companyId, { picture, actor = null }) {
  const p = readPicture(picture);
  if (p && p.bytes.length > MAX_LOGO_BYTES) throw new LedgerError('The logo is too large (1 MB at most)');
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    if (!p) await c.query('DELETE FROM company_logos WHERE company_id = $1', [companyId]);
    else {
      await c.query(
        `INSERT INTO company_logos (company_id, picture, picture_type, updated_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (company_id) DO UPDATE SET picture = EXCLUDED.picture, picture_type = EXCLUDED.picture_type, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [companyId, p.bytes, p.type, actor]);
    }
    // The audit trail records that the logo changed and its size, not the picture itself.
    await appendAudit(c, companyId, { action: p ? 'set_logo' : 'remove_logo', entity: 'company', entityId: companyId, actor,
      payload: p ? { type: p.type, bytes: p.bytes.length } : {} });
    return { hasLogo: !!p };
  });
}

export async function getLogo(db, companyId) {
  const { rows: [r] } = await db.query('SELECT picture, picture_type FROM company_logos WHERE company_id = $1', [companyId]);
  if (!r) throw new LedgerError('This company has no logo');
  return { name: `logo.${r.picture_type === 'image/png' ? 'png' : 'jpg'}`, type: r.picture_type, body: r.picture, inline: true };
}

export async function hasLogo(db, companyId) {
  const { rows } = await db.query('SELECT updated_at FROM company_logos WHERE company_id = $1', [companyId]);
  return rows[0] ? new Date(rows[0].updated_at).getTime() : null;
}
