// Download a full backup (Developer dashboard). ℹ️ A stopgap while Railway's Hobby plan can't schedule
// backups: a developer downloads one copy of the whole database to their own computer, say weekly.
// The file is pg_dump's "custom" format: restore it with pg_restore of the same PostgreSQL version
// (the restore drill in src/jobs/restoreDrill.js does exactly that and checks the books).
// It holds every company's books, so the server only streams it to a signed-in developer and never keeps a copy.
// Social Security numbers stay encrypted inside it (the key, FIELD_ENCRYPTION_KEY, is not in the database).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import pg from 'pg';

/** pg_dump for the server's major version when several are installed (the Docker image has 16, 17 and 18). */
export async function pgDumpFor(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  let major;
  try { major = Math.floor(Number((await c.query('SHOW server_version_num')).rows[0].server_version_num) / 10000); } finally { await c.end(); }
  const exact = `/usr/lib/postgresql/${major}/bin/pg_dump`;
  return { major, bin: existsSync(exact) ? exact : 'pg_dump' };
}

/** Stream a backup of `url` into an HTTP response. Resolves when done; rejects if pg_dump can't start or fails before sending. */
export async function streamBackup(url, res, { log = () => {}, today = new Date().toISOString().slice(0, 10) } = {}) {
  const { major, bin } = await pgDumpFor(url);
  const p = spawn(bin, ['--format=custom', '--no-owner', '--no-acl', `--dbname=${url}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  return new Promise((resolve, reject) => {
    let started = false;
    p.on('error', (e) => reject(new Error(`pg_dump could not start: ${e.message}`)));
    p.stdout.once('data', () => {
      started = true;
      res.status(200).type('application/octet-stream')
        .set('Content-Disposition', `attachment; filename="zaccountant-backup-${today}-pg${major}.dump"`);
    });
    p.stdout.on('data', (d) => res.write(d));
    p.on('close', (code) => {
      if (code === 0 && started) { res.end(); log({ ok: true, major }); return resolve(); }
      const e = new Error(`pg_dump failed (${code}): ${err.trim().slice(0, 300)}`);
      if (started) { res.destroy(e); return resolve(); } // the download breaks off, so a half file is never mistaken for a whole one
      return reject(e);
    });
  });
}
