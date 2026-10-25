// Nightly off-site backup (Homer, 2026-10-25: stay on Railway Hobby, which keeps no backups).
//
// ℹ️ Like keeping a second set of drawings in another building. Each night, after the books check, the server makes a
// full copy of the database (pg_dump, the same file the Developer dashboard downloads), locks it with a key only we
// hold (AES-256-GCM), and sends it to a storage bucket at another company (Cloudflare R2, Backblaze B2, Amazon S3:
// anything that speaks the S3 protocol). The storage company sees only scrambled bytes. To use a copy: download it,
// unlock it with `npm run backup:decrypt`, then restore it (the restore drill, docs/runbooks/operations.md).
//
// Off unless these are set (Railway → the app's service → Variables):
//   BACKUP_S3_ENDPOINT    https://<account>.r2.cloudflarestorage.com  (or https://s3.us-west-004.backblazeb2.com …)
//   BACKUP_S3_BUCKET      the bucket's name
//   BACKUP_S3_REGION      'auto' for R2; the region for B2/S3 (us-west-004, us-east-1 …)
//   BACKUP_S3_KEY_ID / BACKUP_S3_SECRET   an access key allowed to write to that bucket (and nothing else)
//   BACKUP_ENCRYPTION_KEY at least 32 random characters. Keep a copy OUTSIDE Railway (a password manager):
//                         without it no backup can be opened.
import { spawn } from 'node:child_process';
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pgDumpFor } from './backup.js';

const MAGIC = Buffer.from('ZACCBK1\n'); // 8 bytes: file type and version
const LOCK = 72_011_002; // advisory-lock id: one server at a time

const sha256hex = (b) => createHash('sha256').update(b).digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s).digest();

/** The bucket settings from the environment, or null when off. Throws when only some are set (a typo shouldn't pass silently). */
export function offsiteConfig(env = process.env) {
  const names = ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_KEY_ID', 'BACKUP_S3_SECRET', 'BACKUP_ENCRYPTION_KEY'];
  const set = names.filter((n) => env[n]);
  if (!set.length) return null;
  if (set.length < names.length) throw new Error(`Off-site backup is half set up: also set ${names.filter((n) => !env[n]).join(', ')}`);
  if (env.BACKUP_ENCRYPTION_KEY.length < 32) throw new Error('BACKUP_ENCRYPTION_KEY must be at least 32 characters');
  const endpoint = new URL(env.BACKUP_S3_ENDPOINT);
  if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(endpoint.hostname)) throw new Error('BACKUP_S3_ENDPOINT must start with https://');
  return { endpoint: endpoint.origin, bucket: env.BACKUP_S3_BUCKET, region: env.BACKUP_S3_REGION || 'auto',
    keyId: env.BACKUP_S3_KEY_ID, secret: env.BACKUP_S3_SECRET, encryptionKey: env.BACKUP_ENCRYPTION_KEY };
}

// ---------------------------------------------------------------- Locking and unlocking a backup file

const fileKey = (keyText) => Buffer.from(hkdfSync('sha256', Buffer.from(keyText, 'utf8'), Buffer.from('zaccountant-backup'), Buffer.from('v1'), 32));

/** File layout: MAGIC (8) | IV (12) | ciphertext | GCM tag (16). The tag proves the file is whole and unchanged. */
export function encryptBackup(plain, keyText) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', fileKey(keyText), iv);
  c.setAAD(MAGIC);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, body, c.getAuthTag()]);
}

export function decryptBackup(file, keyText) {
  if (file.length < MAGIC.length + 28 || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('That is not a zAccountant backup file');
  const iv = file.subarray(8, 20);
  const tag = file.subarray(file.length - 16);
  const d = createDecipheriv('aes-256-gcm', fileKey(keyText), iv);
  d.setAAD(MAGIC);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(file.subarray(20, file.length - 16)), d.final()]);
  } catch {
    throw new Error('The backup could not be unlocked: wrong BACKUP_ENCRYPTION_KEY, or the file is damaged');
  }
}

// ---------------------------------------------------------------- Sending it: an S3 "PUT object", signed (AWS Signature Version 4)

const encodePath = (p) => p.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

/**
 * Sign a request the way S3 expects (AWS SigV4). Returns the headers to send, Authorization included.
 * `headers` must include host; `payloadHash` is the SHA-256 (hex) of the body.
 */
export function signV4({ method, path, query = '', headers, payloadHash, region, keyId, secret, now = new Date(), service = 's3' }) {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all).sort();
  const canonical = [method, encodePath(path), query, ...names.map((n) => `${n}:${all[n]}`), '', names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

/** Upload one object (path-style URL: endpoint/bucket/key). */
export async function putObject(cfg, key, body, { fetchImpl = fetch, now = new Date() } = {}) {
  const path = `/${cfg.bucket}/${key}`;
  const url = new URL(cfg.endpoint);
  const headers = signV4({ method: 'PUT', path, headers: { host: url.host, 'content-length': body.length, 'content-type': 'application/octet-stream' },
    payloadHash: sha256hex(body), region: cfg.region, keyId: cfg.keyId, secret: cfg.secret, now });
  delete headers.host; // fetch sets it
  const res = await fetchImpl(`${cfg.endpoint}${encodePath(path)}`, { method: 'PUT', headers, body, signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`The storage service refused the backup (HTTP ${res.status}): ${text}`);
  }
}

// ---------------------------------------------------------------- The nightly job

/** pg_dump (custom format) of the whole database, into memory (fine at our size: the database is a few MB). */
export async function dumpDatabase(url) {
  const { major, bin } = await pgDumpFor(url);
  const p = spawn(bin, ['--format=custom', '--no-owner', '--no-acl', `--dbname=${url}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; let err = '';
  p.stdout.on('data', (d) => chunks.push(d));
  p.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((resolve, reject) => { p.on('error', reject); p.on('close', resolve); });
  if (code !== 0) throw new Error(`pg_dump failed (${code}): ${err.trim().slice(0, 300)}`);
  return { major, dump: Buffer.concat(chunks) };
}

/**
 * Back up, lock, send, and record the result in offsite_backups. `dump` can be passed in (tests); otherwise pg_dump
 * runs against `url`. Returns { ok, objectKey, bytes } or { skipped } when another server holds the job.
 */
export async function runOffsiteBackup(ownerPool, { cfg = offsiteConfig(), url, asOf, dump = null, fetchImpl = fetch, now = new Date() } = {}) {
  if (!cfg) return { skipped: 'not set up' };
  const lockClient = await ownerPool.connect();
  try {
    const { rows: [{ got }] } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK]);
    if (!got) return { skipped: 'running elsewhere' };
    const { rows: [rec] } = await ownerPool.query('INSERT INTO offsite_backups (as_of) VALUES ($1) RETURNING id', [asOf]);
    try {
      let major = null;
      if (!dump) ({ major, dump } = await dumpDatabase(url));
      const file = encryptBackup(dump, cfg.encryptionKey);
      const objectKey = `zaccountant/${asOf.slice(0, 4)}/zaccountant-${asOf}${major ? `-pg${major}` : ''}.dump.zbk`;
      await putObject(cfg, objectKey, file, { fetchImpl, now });
      await ownerPool.query('UPDATE offsite_backups SET ok = true, finished_at = now(), bytes = $2, sha256 = $3, object_key = $4 WHERE id = $1',
        [rec.id, file.length, sha256hex(file), objectKey]);
      return { ok: true, objectKey, bytes: file.length };
    } catch (e) {
      const error = e.message.replace(/postgres(ql)?:\/\/\S+/g, '[url]').slice(0, 500);
      await ownerPool.query('UPDATE offsite_backups SET ok = false, finished_at = now(), error = $2 WHERE id = $1', [rec.id, error]);
      return { ok: false, error };
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK]);
    }
  } finally {
    lockClient.release();
  }
}

/** Did tonight's off-site backup already succeed? */
export async function backedUp(ownerPool, asOf) {
  const { rows } = await ownerPool.query('SELECT 1 FROM offsite_backups WHERE as_of = $1 AND ok LIMIT 1', [asOf]);
  return rows.length > 0;
}

/** The last few tries, for the Developer dashboard. */
export async function recentOffsiteBackups(db, limit = 10) {
  const { rows } = await db.query(
    `SELECT to_char(as_of, 'YYYY-MM-DD') AS "asOf", started_at AS "startedAt", ok, bytes, object_key AS "objectKey", error
       FROM offsite_backups ORDER BY started_at DESC LIMIT $1`, [limit]);
  return rows;
}

// Command line:
//   node src/jobs/offsiteBackup.js                     back up now (needs the BACKUP_* variables and the database URL)
//   node src/jobs/offsiteBackup.js decrypt IN OUT      unlock a downloaded backup (needs BACKUP_ENCRYPTION_KEY)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, inPath, outPath] = process.argv.slice(2);
  if (cmd === 'decrypt') {
    if (!inPath || !outPath || !process.env.BACKUP_ENCRYPTION_KEY) {
      console.error('Usage: BACKUP_ENCRYPTION_KEY=… npm run backup:decrypt -- backup.dump.zbk backup.dump');
      process.exitCode = 1;
    } else {
      readFile(inPath).then((f) => writeFile(outPath, decryptBackup(f, process.env.BACKUP_ENCRYPTION_KEY)))
        .then(() => console.log(`Unlocked: ${outPath} (restore it with the restore drill's --file option)`))
        .catch((e) => { console.error(e.message); process.exitCode = 1; });
    }
  } else {
    const { createPool } = await import('../db/pool.js');
    const { centralToday } = await import('./booksCheck.js');
    const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
    const pool = createPool(url);
    runOffsiteBackup(pool, { url, asOf: centralToday() })
      .then((r) => { console.log(JSON.stringify(r)); if (r.ok === false) process.exitCode = 2; })
      .catch((e) => { console.error(e.message); process.exitCode = 1; })
      .finally(() => pool.end());
  }
}
