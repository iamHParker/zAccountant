// Integrity check (Section 14.2): every company's trial balance must be zero and its audit hash chain
// must verify. Run as a script it exits non-zero (alerts) if anything is wrong; the restore drill
// runs the same check against a restored copy.
import { fileURLToPath } from 'node:url';
import { createPool } from './pool.js';
import { listCompanies } from '../services/ledgerService.js';
import { getTrialBalance } from '../services/reportService.js';
import { verifyChain } from '../services/audit.js';

/** Check every company in a database. Returns { companies, failures, results: [...] }. */
export async function verifyAllBooks(pool, { log = (line) => console.log(line) } = {}) {
  const results = [];
  for (const co of await listCompanies(pool)) {
    const tb = await getTrialBalance(pool, co.id, { asOf: '9999-12-31' });
    const chain = await verifyChain(pool, co.id);
    const r = { company: co.id, trialBalanceDiffCents: tb.check, auditChainOk: chain.ok, auditRows: chain.rows, ok: tb.balanced && chain.ok };
    results.push(r);
    log(JSON.stringify(r));
  }
  return { companies: results.length, failures: results.filter((r) => !r.ok).length, results };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPool();
  try {
    const { failures } = await verifyAllBooks(pool);
    if (failures) { console.error(`${failures} company(ies) failed verification`); process.exitCode = 1; }
  } finally {
    await pool.end();
  }
}
