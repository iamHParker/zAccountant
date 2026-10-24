// Tamper-evident audit trail (hash chain).
// Each row's hash = SHA-256 of (previous row's hash + this row's content). Changing or deleting
// any historical row breaks every hash after it, which verifyChain() detects — like a surveyor's
// closed traverse: one bad shot and the loop no longer closes.
import { createHash } from 'node:crypto';

export const GENESIS = '0'.repeat(64);

/** JSON with object keys sorted, so the same data always hashes the same way. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function auditHash(prevHash, { action, entity, entityId, actor, payload }) {
  return createHash('sha256')
    .update([prevHash, action, entity, entityId ?? '', actor ?? '', canonicalJson(payload)].join('|'))
    .digest('hex');
}

/** Append an audit row. Caller must hold the company row lock (SELECT ... FOR UPDATE) in this transaction. */
export async function appendAudit(client, companyId, { action, entity, entityId = null, actor = null, payload }) {
  const { rows } = await client.query('SELECT hash FROM audit_log WHERE company_id = $1 ORDER BY id DESC LIMIT 1', [companyId]);
  const prevHash = rows[0]?.hash ?? GENESIS;
  const hash = auditHash(prevHash, { action, entity, entityId, actor, payload });
  await client.query(
    `INSERT INTO audit_log (company_id, action, entity, entity_id, actor, payload, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [companyId, action, entity, entityId, actor, JSON.stringify(payload), prevHash, hash],
  );
  return hash;
}

/** Recompute the whole chain for a company. Returns { ok, rows, brokenAt }. */
export async function verifyChain(db, companyId) {
  const { rows } = await db.query('SELECT * FROM audit_log WHERE company_id = $1 ORDER BY id', [companyId]);
  let prev = GENESIS;
  for (const r of rows) {
    const expected = auditHash(prev, { action: r.action, entity: r.entity, entityId: r.entity_id, actor: r.actor, payload: r.payload });
    if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, rows: rows.length, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true, rows: rows.length, brokenAt: null };
}
