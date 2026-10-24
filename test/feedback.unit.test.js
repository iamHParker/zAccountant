import test from 'node:test';
import assert from 'node:assert/strict';
import { boundValue, readPicture, checkFeedbackInput, buildClaudeText } from '../src/services/feedbackService.js';
import { platformRole, appVersion } from '../src/core/platform.js';

test('platform roles come only from the environment lists, case-insensitively', () => {
  const env = { DEVELOPER_EMAILS: 'Homer@Example.com, dev2@example.com', ADMIN_EMAILS: 'admin@example.com' };
  assert.equal(platformRole('homer@example.com', env), 'developer');
  assert.equal(platformRole('DEV2@example.com', env), 'developer');
  assert.equal(platformRole('admin@example.com', env), 'admin');
  assert.equal(platformRole('someone@example.com', env), null);
  assert.equal(platformRole('', env), null);
  assert.equal(platformRole('homer@example.com', {}), null);
});

test('the version names the deployed commit when Railway gives one', () => {
  assert.match(appVersion({ RAILWAY_GIT_COMMIT_SHA: 'abcdef1234567' }), /^\d+\.\d+\.\d+\+abcdef1$/);
  assert.match(appVersion({}), /^\d+\.\d+\.\d+$/);
});

test('captured details are capped: long strings, long lists, deep nesting, non-JSON values', () => {
  assert.equal(boundValue('x'.repeat(2000)).length, 1001);
  assert.equal(boundValue(Array.from({ length: 100 }, (_, i) => i)).length, 40);
  assert.deepEqual(boundValue(Array.from({ length: 100 }, (_, i) => i)).slice(0, 2), [60, 61], 'keeps the most recent');
  assert.deepEqual(boundValue({ a: { b: { c: { d: { e: { f: 1 } } } } } }), { a: { b: { c: { d: { e: null } } } } });
  assert.deepEqual(boundValue({ n: Infinity, f: () => 1, u: undefined, ok: true }), { n: null, ok: true });
});

test('pictures: only real PNG or JPEG, checked by their first bytes', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString('base64');
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString('base64');
  assert.equal(readPicture(`data:image/png;base64,${png}`).type, 'image/png');
  assert.equal(readPicture(`data:image/jpeg;base64,${jpg}`).type, 'image/jpeg');
  assert.equal(readPicture(null), null);
  assert.throws(() => readPicture(`data:image/png;base64,${jpg}`), /PNG or JPEG/, 'a JPEG claiming to be a PNG');
  assert.throws(() => readPicture('data:text/html;base64,PHNjcmlwdD4='), /PNG or JPEG/);
  assert.throws(() => readPicture(`data:image/jpeg;base64,${Buffer.alloc(4_000_001, 0xff).toString('base64')}`), /too large/);
});

test('the note is required and trimmed; a picture without a source counts as a screen picture', () => {
  assert.throws(() => checkFeedbackInput({ note: '  ' }), /what went wrong/);
  assert.throws(() => checkFeedbackInput({ note: 'x'.repeat(4001) }), /4000/);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64');
  const v = checkFeedbackInput({ note: ' broke ', picture: `data:image/jpeg;base64,${jpg}` });
  assert.deepEqual([v.note, v.pictureSource, v.context], ['broke', 'screen', {}]);
  assert.equal(checkFeedbackInput({ note: 'x', picture: `data:image/jpeg;base64,${jpg}`, pictureSource: 'photo' }).pictureSource, 'photo');
});

test('the write-up for Claude has the problem and how to reproduce it, not the person', () => {
  const text = buildClaudeText({
    number: 7, appVersion: '0.1.0+abc1234', createdAt: '2026-10-24T15:00:00Z', note: 'Total is wrong ``` here',
    reporterName: 'Pat Tester', reporterEmail: 'pat@example.com', hasPicture: true, pictureSource: 'photo',
    context: { location: { tab: 'Reports', panel: 'Balance Sheet', role: 'Owner' }, actions: [{ at: '1', what: 'click button "Run"' }],
      errors: [{ at: '2', kind: 'server', message: 'GET /x → 500', reqId: 'r-1' }] },
  }, { siteUrl: 'https://z.example' });
  assert.match(text, /^## zAccountant beta report 7 \(version 0\.1\.0\+abc1234\)/);
  assert.match(text, /\| screen \| Reports › Balance Sheet \|/);
  assert.match(text, /1\. 1 click button "Run"/);
  assert.match(text, /\[server\] GET \/x → 500 \(request r-1\)/);
  assert.match(text, /photo the tester attached/);
  assert.ok(!text.includes('Pat Tester') && !text.includes('pat@example.com'));
  assert.ok(!/Total is wrong ``` here/.test(text), 'a fence in the note cannot break out of its code block');
});
