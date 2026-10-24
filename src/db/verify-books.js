// Nightly integrity check (Section 14.2): every company's trial balance must be zero and
// its audit hash chain must verify. Exits non-zero (alerts) if anything is wrong.
import { createPool } from './pool.js';
import { listCompanies } from '../services/ledgerService.js';
import { getTrialBalance } from '../services/reportService.js';
import { verifyChain } from '../services/audit.js';

const pool = createPool();
let failures = 0;
try {
  const asOf = '9999-12-31';
  for (const co of await listCompanies(pool)) {
    const tb = await getTrialBalance(pool, co.id, { asOf });
    const chain = await verifyChain(pool, co.id);
    const ok = tb.balanced && chain.ok;
    if (!ok) failures++;
    console.log(JSON.stringify({ company: co.id, trialBalanceDiffCents: tb.check, auditChainOk: chain.ok, auditRows: chain.rows, ok }));
  }
} finally {
  await pool.end();
}
if (failures) { console.error(`${failures} company(ies) failed verification`); process.exitCode = 1; }
