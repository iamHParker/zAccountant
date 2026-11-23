import test from 'node:test';
import assert from 'node:assert/strict';
import { signV4, encryptBackup, decryptBackup, offsiteConfig } from '../src/jobs/offsiteBackup.js';

test('S3 request signing matches AWS\'s published example (GET Object, Signature Version 4)', () => {
  // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Example: GET Object".
  const h = signV4({
    method: 'GET', path: '/test.txt', headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', region: 'us-east-1',
    keyId: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
    + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('backup files: locked with the key, refused with another key or when damaged', () => {
  const key = 'a'.repeat(40);
  const plain = Buffer.from('PGDMP pretend database copy');
  const file = encryptBackup(plain, key);
  assert.equal(file.subarray(0, 8).toString(), 'ZACCBK1\n');
  assert.ok(!file.includes(plain)); // scrambled
  assert.deepEqual(decryptBackup(file, key), plain);
  assert.throws(() => decryptBackup(file, 'b'.repeat(40)), /wrong BACKUP_ENCRYPTION_KEY/);
  const bad = Buffer.from(file); bad[25] ^= 1;
  assert.throws(() => decryptBackup(bad, key), /damaged/);
  assert.throws(() => decryptBackup(Buffer.from('PGDMP…'), key), /not a zAccountant backup/);
});

test('off-site settings: off when none are set, an error when half set or the key is short', () => {
  assert.equal(offsiteConfig({}), null);
  const all = { BACKUP_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', BACKUP_S3_BUCKET: 'zacc-backups', BACKUP_S3_KEY_ID: 'k', BACKUP_S3_SECRET: 's', BACKUP_ENCRYPTION_KEY: 'x'.repeat(32) };
  assert.equal(offsiteConfig(all).region, 'auto');
  assert.throws(() => offsiteConfig({ ...all, BACKUP_S3_SECRET: '' }), /half set up: also set BACKUP_S3_SECRET/);
  assert.throws(() => offsiteConfig({ ...all, BACKUP_ENCRYPTION_KEY: 'short' }), /at least 32/);
  assert.throws(() => offsiteConfig({ ...all, BACKUP_S3_ENDPOINT: 'http://example.com' }), /https/);
});

// The command line (`npm run backup:offsite`) once imported booksCheck.js, which imports this file: a circle with a
// top-level await never settles, so Node quit with code 13 and no backup (found on Railway, 2026-11-23).
test('the backup command runs to the end (no import circle)', async () => {
  const { execFile } = await import('node:child_process');
  const env = { PATH: process.env.PATH, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' };
  const out = await new Promise((resolve, reject) =>
    execFile(process.execPath, ['src/jobs/offsiteBackup.js'], { env }, (e, stdout, stderr) =>
      e ? reject(new Error(`exit ${e.code}: ${stderr}`)) : resolve(stdout)));
  assert.deepEqual(JSON.parse(out.trim()), { skipped: 'not set up' });
});
