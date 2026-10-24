// Backup-restore drill (Section 14 / roadmap S8: "RTO drill under 4 h").
// ℹ️ Like a load test on a pile: a backup only counts if we have actually restored it and checked it.
// Steps, each timed:
//   1. back up the live database (pg_dump), or use a backup file you already have (--file);
//   2. restore it into an EMPTY database (refuses to touch one that has tables);
//   3. compare row counts table by table with the source;
//   4. run the full books check on the copy: every trial balance is zero, every audit chain verifies.
// Usage:
//   BACKUP_SOURCE_URL=postgres://...live  RESTORE_TARGET_URL=postgres://...empty  node src/jobs/restoreDrill.js
//   RESTORE_TARGET_URL=... node src/jobs/restoreDrill.js --file backup.dump     (restore an existing backup)
// Needs pg_dump / pg_restore on the PATH, and the same AUDIT_HMAC_KEY as production (or the chains can't verify).
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { verifyAllBooks } from '../db/verify-books.js';

const RTO_TARGET_HOURS = 4;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code}): ${err.trim().slice(0, 500)}`))));
  });
}

/** Rows per table in the public schema (exact counts; fine at our size). */
async function rowCounts(client) {
  const { rows } = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  const counts = {};
  for (const { tablename } of rows) {
    counts[tablename] = Number((await client.query(`SELECT count(*) AS n FROM public."${tablename.replace(/"/g, '""')}"`)).rows[0].n);
  }
  return counts;
}

export async function restoreDrill({ sourceUrl, targetUrl, file = null, log = (line) => console.log(line) }) {
  if (!targetUrl) throw new Error('Set RESTORE_TARGET_URL to an empty database to restore into');
  if (!file && !sourceUrl) throw new Error('Set BACKUP_SOURCE_URL, or pass --file with an existing backup');
  if (sourceUrl && sourceUrl === targetUrl) throw new Error('The restore target must not be the source database');
  const t0 = Date.now();
  const steps = [];
  const step = async (name, fn) => {
    const s = Date.now();
    const detail = await fn();
    steps.push({ step: name, seconds: Math.round((Date.now() - s) / 100) / 10, ...detail });
    log(JSON.stringify(steps.at(-1)));
  };

  const target = new pg.Client({ connectionString: targetUrl });
  await target.connect();
  let dir = null;
  try {
    const { rows: [{ n }] } = await target.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`);
    if (n > 0) throw new Error(`The restore target already has ${n} tables. Use an empty database; the drill never overwrites data.`);

    let dump = file;
    if (!dump) {
      dir = await mkdtemp(join(tmpdir(), 'zacc-drill-'));
      dump = join(dir, 'backup.dump');
      await step('backup', async () => {
        await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', `--file=${dump}`, `--dbname=${sourceUrl}`]);
        return { bytes: (await stat(dump)).size };
      });
    }
    await step('restore', async () => {
      await run('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', `--dbname=${targetUrl}`, dump]);
      return {};
    });

    let restored;
    await step('row counts', async () => {
      restored = await rowCounts(target);
      if (!sourceUrl) return { tables: Object.keys(restored).length, rows: Object.values(restored).reduce((a, b) => a + b, 0) };
      const source = new pg.Client({ connectionString: sourceUrl });
      await source.connect();
      try {
        const live = await rowCounts(source);
        const missing = Object.keys(live).filter((t) => !(t in restored));
        if (missing.length) throw new Error(`Tables missing from the restored copy: ${missing.join(', ')}`);
        // Counts can differ when the live database kept working after the backup started (new entries,
        // expired sign-in sessions removed): listed for the record, not a failure.
        const changedSinceBackup = Object.keys(live).filter((t) => live[t] !== restored[t]);
        return { tables: Object.keys(restored).length, rows: Object.values(restored).reduce((a, b) => a + b, 0), changedSinceBackup };
      } finally {
        await source.end();
      }
    });

    let check;
    await step('books check', async () => {
      const pool = new pg.Pool({ connectionString: targetUrl, max: 2 });
      try { check = await verifyAllBooks(pool, { log: () => {} }); } finally { await pool.end(); }
      return { companies: check.companies, failures: check.failures };
    });

    const hours = (Date.now() - t0) / 3_600_000;
    const ok = check.failures === 0 && hours < RTO_TARGET_HOURS;
    const summary = { level: ok ? 'info' : 'error', msg: 'restore drill', ok, minutes: Math.round(hours * 600) / 10, rtoTargetHours: RTO_TARGET_HOURS, steps };
    log(JSON.stringify(summary));
    return summary;
  } finally {
    await target.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fileAt = process.argv.indexOf('--file');
  try {
    const r = await restoreDrill({
      sourceUrl: process.env.BACKUP_SOURCE_URL, targetUrl: process.env.RESTORE_TARGET_URL,
      file: fileAt > 0 ? process.argv[fileAt + 1] : null,
    });
    if (!r.ok) process.exitCode = 1;
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'restore drill failed', error: e.message }));
    process.exitCode = 1;
  }
}
