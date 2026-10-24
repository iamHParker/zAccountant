// Tamper-evident audit trail (keyed hash chain).
// Each row's hash = HMAC-SHA-256(key, previous row's hash + this row's content). Changing or deleting
// any historical row breaks every hash after it, which verifyChain() detects — like a surveyor's
// closed traverse: one bad shot and the loop no longer closes.
//
// The key (AUDIT_HMAC_KEY) lives OUTSIDE the database (env var now, cloud KMS in Sprint 1), so someone
// who can write to the database still cannot forge a valid chain. Remaining gap (Sprint 1): publish
// the latest hash outside the database daily, so deleting the newest rows is also detectable.
import { createHmac } from 'node:crypto';

export const GENESIS = '0'.repeat(64);
const DEV_KEY = 'zacc-dev-only-audit-key-do-not-use-in-production';

function auditKey() {
  const k = process.env.AUDIT_HMAC_KEY;
  if (k) return k;
  if (process.env.NODE_ENV === 'production') throw new Error('AUDIT_HMAC_KEY must be set in production');
  return DEV_KEY;
}

/** JSON with object keys sorted, so the same data always hashes the same way. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function auditHash(prevHash, { companyId, seq, action, entity, entityId, actor, payload }) {
  return createHmac('sha256', auditKey())
    .update([prevHash, companyId, seq, action, entity, entityId ?? '', actor ?? '', canonicalJson(payload)].join('|'))
    .digest('hex');
}

/** Append an audit row. Caller must hold the company row lock (SELECT ... FOR UPDATE) in this transaction. */
export async function appendAudit(client, companyId, { action, entity, entityId = null, actor = null, payload }) {
  const { rows } = await client.query('SELECT hash, seq FROM audit_log WHERE company_id = $1 ORDER BY seq DESC LIMIT 1', [companyId]);
  const prevHash = rows[0]?.hash ?? GENESIS;
  const seq = (rows[0]?.seq ?? 0) + 1;
  const hash = auditHash(prevHash, { companyId, seq, action, entity, entityId, actor, payload });
  await client.query(
    `INSERT INTO audit_log (company_id, seq, action, entity, entity_id, actor, payload, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [companyId, seq, action, entity, entityId, actor, JSON.stringify(payload), prevHash, hash],
  );
  return hash;
}

/**
 * Verify a company's books against its audit trail:
 *  1. recompute the keyed hash chain (detects edited, inserted or reordered audit rows), and
 *  2. reconcile every journal entry's lines in the ledger with the lines recorded in the audit trail
 *     (detects ledger rows edited or deleted behind the application's back).
 * Returns { ok, rows, brokenAt, ledgerMismatches }.
 */
export async function verifyChain(db, companyId) {
  const { rows } = await db.query('SELECT * FROM audit_log WHERE company_id = $1 ORDER BY seq', [companyId]);
  let prev = GENESIS;
  let brokenAt = null;
  const posted = new Map();
  for (const [i, r] of rows.entries()) {
    const expected = auditHash(prev, { companyId, seq: r.seq, action: r.action, entity: r.entity, entityId: r.entity_id, actor: r.actor, payload: r.payload });
    if (r.seq !== i + 1 || r.prev_hash !== prev || r.hash !== expected) { brokenAt = r.seq; break; }
    if (r.action === 'post' && r.entity === 'journal_entry') posted.set(r.entity_id, r.payload);
    prev = r.hash;
  }
  const ledgerMismatches = [];
  if (brokenAt === null) {
    const { rows: entries } = await db.query(
      `SELECT e.id, e.entry_number, e.entry_date,
              coalesce(json_agg(json_build_object('a', l.account_id, 'd', l.debit_cents, 'c', l.credit_cents) ORDER BY l.id)
                       FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
         FROM journal_entries e LEFT JOIN journal_lines l ON l.entry_id = e.id
        WHERE e.company_id = $1 GROUP BY e.id`, [companyId]);
    for (const e of entries) {
      const p = posted.get(e.id);
      const ledgerLines = canonicalJson(e.lines.map((l) => [l.a, Number(l.d), Number(l.c)]));
      const auditLines = p && canonicalJson(p.lines.map((l) => [l.accountId, l.debitCents, l.creditCents]));
      if (!p || p.date !== e.entry_date || p.number !== e.entry_number || ledgerLines !== auditLines) ledgerMismatches.push(e.entry_number);
      posted.delete(e.id);
    }
    for (const p of posted.values()) ledgerMismatches.push(p.number); // in audit trail but missing from ledger
  }
  return { ok: brokenAt === null && ledgerMismatches.length === 0, rows: rows.length, brokenAt, ledgerMismatches };
}
