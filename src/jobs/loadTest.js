// Load test (roadmap S8). ℹ️ Like proof-loading a beam: push the running server to its design load and
// measure. Design point (Section 14.1): 50 requests/second sustained per server copy, p95 under 800 ms.
//
// Each simulated user signs up (with two-step sign-in), creates a company, then loops a realistic mix
// for the test duration: record a transaction, open the dashboard, search the journal, run reports.
//
//   1. Start a server for testing (never production):  API_RATE_LIMIT=1000000 AUTH_RATE_LIMIT=1000 npm start
//      (the per-address limits would otherwise stop one machine pretending to be many users)
//   2. node src/jobs/loadTest.js --url http://localhost:3000 --users 20 --seconds 60
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { totpCode } from '../security/totp.js';

const DESIGN = { rps: 50, p95Ms: 800, errorRate: 0.01 };

function client(base) {
  let cookie = '';
  return async (method, path, body) => {
    const t0 = performance.now();
    const r = await fetch(base + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await r.json().catch(() => null);
    return { status: r.status, body: data, ms: performance.now() - t0 };
  };
}

async function newUser(base, n) {
  const call = client(base);
  const email = `load-${n}-${randomBytes(4).toString('hex')}@example.com`;
  const must = (r, what) => { if (r.status >= 300) throw new Error(`${what} failed (${r.status}): ${r.body?.error}`); return r.body; };
  must(await call('POST', '/api/auth/signup', { email, name: `Load ${n}`, password: 'load test passphrase 2026' }), 'sign-up');
  const { secret } = must(await call('POST', '/api/auth/mfa/setup', {}), '2FA setup');
  must(await call('POST', '/api/auth/mfa/enable', { code: totpCode(secret) }), '2FA enable');
  const co = must(await call('POST', '/api/companies', { name: `Load Co ${n}`, homeState: 'TX', fiscalYearStartMonth: 1 }), 'company');
  const accts = must(await call('GET', `/api/companies/${co.id}/accounts`), 'accounts');
  const id = (code) => accts.find((a) => a.code === code)?.id;
  return { call, base: `/api/companies/${co.id}`, bank: id('1000'), income: id('4000'), expense: id('6300') };
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0);

export async function loadTest({ url, users = 10, seconds = 30, log = (l) => console.log(l) }) {
  log(`Setting up ${users} users on ${url}…`);
  const us = await Promise.all(Array.from({ length: users }, (_, i) => newUser(url, i)));
  const samples = []; // { name, ms, ok }
  const end = Date.now() + seconds * 1000;
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const mix = [
    (u, i) => ['record transaction', u.call('POST', `${u.base}/entries/simple`, { date: today, memo: `Load ${i}`, amount: `${(i % 900) + 1}.25`,
      ...(i % 3 ? { fromAccountId: u.bank, toAccountId: u.expense } : { fromAccountId: u.income, toAccountId: u.bank }) })],
    (u) => ['dashboard', u.call('GET', `${u.base}/reports/dashboard`)],
    (u) => ['journal search', u.call('GET', `${u.base}/entries?text=Load&limit=50`)],
    (u) => ['profit & loss', u.call('GET', `${u.base}/reports/income-statement?from=${year}-01-01&to=${today}&compare=prior_year`)],
    (u) => ['balance sheet', u.call('GET', `${u.base}/reports/balance-sheet?asOf=${today}`)],
    (u) => ['trial balance', u.call('GET', `${u.base}/reports/trial-balance?asOf=${today}`)],
  ];
  const started = Date.now();
  await Promise.all(us.map(async (u, k) => {
    for (let i = k; Date.now() < end; i++) {
      const [name, p] = mix[i % mix.length](u, i);
      try {
        const r = await p;
        samples.push({ name, ms: r.ms, ok: r.status < 400, status: r.status });
      } catch (e) {
        samples.push({ name, ms: 0, ok: false, status: e.message });
      }
    }
  }));
  const secs = (Date.now() - started) / 1000;
  const summarize = (list) => {
    const ms = list.map((s) => s.ms).sort((a, b) => a - b);
    return { requests: list.length, errors: list.filter((s) => !s.ok).length, p50Ms: Math.round(pct(ms, 50)), p95Ms: Math.round(pct(ms, 95)), p99Ms: Math.round(pct(ms, 99)) };
  };
  const byName = Object.fromEntries(mix.map((f) => f(us[0], 0)[0]).map((n) => [n, summarize(samples.filter((s) => s.name === n))]));
  const all = summarize(samples);
  const rps = Math.round((all.requests / secs) * 10) / 10;
  const errorRate = all.requests ? all.errors / all.requests : 1;
  const verdict = { rpsOk: rps >= DESIGN.rps, p95Ok: all.p95Ms <= DESIGN.p95Ms, errorsOk: errorRate <= DESIGN.errorRate };
  const errorStatuses = [...new Set(samples.filter((s) => !s.ok).map((s) => s.status))].slice(0, 5);
  return { users, seconds: Math.round(secs), rps, ...all, errorStatuses, byName, design: DESIGN, verdict, ok: Object.values(verdict).every(Boolean) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
  const r = await loadTest({ url: arg('url', 'http://localhost:3000'), users: Number(arg('users', 10)), seconds: Number(arg('seconds', 30)) });
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) process.exitCode = 1;
}
