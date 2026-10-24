// The nightly books check — like a surveyor re-closing the traverse every night.
//
// For each company it:
//   1. posts recurring entries that have come due,
//   2. re-verifies the audit hash chain and reconciles every ledger entry against it,
//   3. confirms the trial balance and balance sheet both balance,
//   4. confirms last night's chain fingerprint ("anchor") is still in the chain — so if someone deleted
//      the newest audit rows, we notice — and takes tonight's anchor.
// Each night's anchor is also written to the server log, which is stored outside the database.
//
// Run by the server's built-in scheduler (about 2 a.m. Central) or by hand: npm run job:nightly
import { fileURLToPath } from 'node:url';
import { createPool, withTransaction } from '../db/pool.js';
import { postDueRecurring } from '../services/ledgerService.js';
import { getTrialBalance, getBalanceSheet } from '../services/reportService.js';
import { verifyChain } from '../services/audit.js';

/** Today's date in Central time (the business day the books are kept in). */
export const centralToday = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(now);

/** Run the check for one company. `db` may be a pool or a request client already scoped to the company. */
export async function runBooksCheck(db, companyId, { asOf = centralToday(), trigger = 'manual' } = {}) {
  const problems = [];
  const recurring = await postDueRecurring(db, companyId, { asOf });
  for (const p of recurring.problems) problems.push(`Recurring entry "${p.name}" due ${p.date} was not posted: ${p.error}`);

  const chain = await verifyChain(db, companyId);
  if (chain.brokenAt !== null) problems.push(`Audit trail is broken at record ${chain.brokenAt}`);
  if (chain.ledgerMismatches.length) problems.push(`Ledger entries don't match the audit trail: #${chain.ledgerMismatches.join(', #')}`);

  const tb = await getTrialBalance(db, companyId, { asOf });
  if (!tb.balanced) problems.push(`Trial balance is off by ${tb.check}¢`);
  const bs = await getBalanceSheet(db, companyId, { asOf });
  if (!bs.balanced) problems.push(`Balance sheet is off by ${bs.check}¢`);

  const { rows: [prev] } = await db.query(
    'SELECT anchor_seq, anchor_hash FROM books_checks WHERE company_id = $1 AND anchor_seq IS NOT NULL ORDER BY run_at DESC, id DESC LIMIT 1', [companyId]);
  if (prev) {
    const { rows: [still] } = await db.query('SELECT hash FROM audit_log WHERE company_id = $1 AND seq = $2', [companyId, prev.anchor_seq]);
    if (!still || still.hash !== prev.anchor_hash) problems.push(`Audit record ${prev.anchor_seq} from the last check is missing or changed`);
  }
  const { rows: [head] } = await db.query('SELECT seq, hash FROM audit_log WHERE company_id = $1 ORDER BY seq DESC LIMIT 1', [companyId]);

  const result = {
    ok: problems.length === 0,
    asOf,
    auditRows: chain.rows,
    anchor: head ? { seq: head.seq, hash: head.hash } : null,
    recurringPosted: recurring.posted,
    problems,
  };
  await withTransaction(db, (c) => c.query(
    `INSERT INTO books_checks (company_id, as_of, ok, audit_rows, anchor_seq, anchor_hash, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [companyId, asOf, result.ok, chain.rows, head?.seq ?? null, head?.hash ?? null,
      JSON.stringify({ trigger, problems, recurringPosted: recurring.posted, trialBalance: tb.check, balanceSheet: bs.check })]));
  // Structured log line: the off-database copy of the anchor. No personal data.
  console.log(JSON.stringify({ level: result.ok ? 'info' : 'error', msg: 'books_check', companyId, asOf, ok: result.ok,
    anchorSeq: result.anchor?.seq ?? null, anchorHash: result.anchor?.hash ?? null, problems: problems.length }));
  return result;
}

export async function latestBooksCheck(db, companyId) {
  const { rows: [r] } = await db.query(
    'SELECT run_at, as_of, ok, audit_rows, anchor_seq, details FROM books_checks WHERE company_id = $1 ORDER BY run_at DESC, id DESC LIMIT 1', [companyId]);
  if (!r) return null;
  return { runAt: r.run_at, asOf: r.as_of, ok: r.ok, auditRows: r.audit_rows, anchorSeq: r.anchor_seq,
    problems: r.details.problems ?? [], recurringPosted: r.details.recurringPosted ?? [] };
}

const JOB_LOCK = 72_011_001; // advisory-lock id: only one server runs the nightly job at a time

/**
 * Check every company. Needs the OWNER connection (it works across companies). Returns a summary.
 * If another server is already running it, returns { skipped: true }.
 */
export async function runNightly(ownerPool, { asOf = centralToday() } = {}) {
  const lockClient = await ownerPool.connect();
  try {
    const { rows: [{ got }] } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS got', [JOB_LOCK]);
    if (!got) return { skipped: true };
    try {
      const { rows: companies } = await ownerPool.query('SELECT id FROM companies ORDER BY created_at');
      const summary = { asOf, companies: companies.length, ok: 0, failed: [] };
      for (const { id } of companies) {
        try {
          const r = await runBooksCheck(ownerPool, id, { asOf, trigger: 'nightly' });
          if (r.ok) summary.ok++; else summary.failed.push({ companyId: id, problems: r.problems });
        } catch (err) {
          console.error(JSON.stringify({ level: 'error', msg: 'books_check_crashed', companyId: id, error: err.message }));
          summary.failed.push({ companyId: id, problems: ['check could not run'] });
        }
      }
      return summary;
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [JOB_LOCK]);
    }
  } finally {
    lockClient.release();
  }
}

/** Has tonight's job already run for this business day? */
async function ranToday(ownerPool, asOf) {
  const { rows } = await ownerPool.query("SELECT 1 FROM books_checks WHERE as_of = $1 AND details->>'trigger' = 'nightly' LIMIT 1", [asOf]);
  return rows.length > 0;
}

/** Built-in scheduler: every 15 minutes, if it's past 2 a.m. Central and today's check hasn't run, run it. */
export function startNightlyScheduler(ownerPool, { hour = 2, everyMs = 15 * 60_000 } = {}) {
  const tick = async () => {
    const now = new Date();
    const ctHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(now));
    const asOf = centralToday(now);
    if (ctHour < hour) return;
    try {
      if (await ranToday(ownerPool, asOf)) return;
      const s = await runNightly(ownerPool, { asOf });
      console.log(JSON.stringify({ level: 'info', msg: 'nightly_done', ...s, failed: s.failed?.length ?? 0 }));
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'nightly_failed', error: err.message }));
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  setTimeout(tick, 30_000).unref();
  return timer;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPool(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL);
  runNightly(pool, { asOf: process.argv[2] ?? centralToday() })
    .then((s) => { console.log(JSON.stringify(s, null, 2)); if (s.failed?.length) process.exitCode = 2; })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
