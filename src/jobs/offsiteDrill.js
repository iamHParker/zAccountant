// The restore drill, run against the real off-site copy, in one command (Homer, 2026-11-23: "make the pre-Dec 1 backup work").
// ℹ️ Like pulling a core from the finished slab rather than testing the mix: it proves the file in the bucket, not
// a fresh dump, turns back into books that balance.
// Steps:
//   1. find the newest backup that was sent (offsite_backups) and download it from the bucket;
//   2. check it is byte-for-byte what was sent (SHA-256 recorded at send time) and unlock it with BACKUP_ENCRYPTION_KEY;
//   3. create a throwaway database on the same server (zacc_drill_<date>), restore into it, compare row counts with
//      the live database, and run the full books check (restoreDrill.js);
//   4. delete the throwaway database, pass or fail. The live database is only read.
// Usage (Railway → service → Console):   npm run drill:offsite        (or: npm run drill:offsite -- <object key>)
// Needs the BACKUP_* variables, AUDIT_HMAC_KEY (so the audit chains verify), and an owner login that may CREATE DATABASE
// (MIGRATION_DATABASE_URL, else DATABASE_URL).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { offsiteConfig, getObject, decryptBackup } from './offsiteBackup.js';
import { restoreDrill } from './restoreDrill.js';

/** The same server, another database name. */
export function databaseUrlFor(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function offsiteDrill({ url, cfg = offsiteConfig(), objectKey = null, fetchImpl = fetch, log = (l) => console.log(l), today = new Date(), database = null } = {}) {
  if (!cfg) throw new Error('The off-site backup is not set up (no BACKUP_* variables)');
  if (!url) throw new Error('Set MIGRATION_DATABASE_URL or DATABASE_URL');
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const name = database ?? `zacc_drill_${today.toISOString().slice(0, 10).replace(/-/g, '')}`;
  let dir = null; let created = false;
  try {
    const { rows } = objectKey
      ? await admin.query('SELECT object_key, sha256 FROM offsite_backups WHERE ok AND object_key = $1 ORDER BY started_at DESC LIMIT 1', [objectKey])
      : await admin.query('SELECT object_key, sha256 FROM offsite_backups WHERE ok ORDER BY started_at DESC LIMIT 1');
    const key = rows[0]?.object_key ?? objectKey;
    if (!key) throw new Error('No off-site backup has been sent yet: run npm run backup:offsite first');
    const file = await getObject(cfg, key, { fetchImpl });
    const sha = createHash('sha256').update(file).digest('hex');
    if (rows[0]?.sha256 && rows[0].sha256 !== sha) throw new Error(`The file in the bucket is not the one that was sent (SHA-256 differs): ${key}`);
    const dump = decryptBackup(file, cfg.encryptionKey);
    log(JSON.stringify({ step: 'download', objectKey: key, bytes: file.length, sha256Matches: Boolean(rows[0]?.sha256) }));

    dir = await mkdtemp(join(tmpdir(), 'zacc-offsite-drill-'));
    const dumpPath = join(dir, 'backup.dump');
    await writeFile(dumpPath, dump, { mode: 0o600 });

    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); // a drill that died half way left one behind
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    const summary = await restoreDrill({ sourceUrl: url, targetUrl: databaseUrlFor(url, name), file: dumpPath, log });
    return { ...summary, objectKey: key };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
    if (created) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch((e) => log(JSON.stringify({ level: 'error', msg: `could not delete ${name}`, error: e.message })));
    await admin.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const r = await offsiteDrill({ url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL, objectKey: process.argv[2] ?? null });
    console.log(r.ok ? `PASSED: ${r.objectKey} restored and every company's books check out (${r.minutes} min). The throwaway copy is deleted.`
      : `FAILED: see the lines above. The throwaway copy is deleted.`);
    if (!r.ok) process.exitCode = 1;
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'off-site restore drill failed', error: e.message.replace(/postgres(ql)?:\/\/\S+/g, '[url]') }));
    process.exitCode = 1;
  }
}
