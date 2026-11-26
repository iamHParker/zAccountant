// When a photo was taken, from its EXIF block (public/photoDate.js). The test builds tiny JPEGs by hand, byte by byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoTakenAt, exifStamp } from '../public/photoDate.js';

/**
 * A JPEG that is only SOI + an APP1 "Exif" section: a TIFF block with directory 0 → EXIF directory → DateTimeOriginal.
 * little: the byte order ("II" or "MM"); ifd0Date: put DateTime in directory 0 instead.
 */
function jpegWithDate(stamp, { little = false, ifd0Date = false } = {}) {
  const t = new DataView(new ArrayBuffer(200));
  const u16 = (o, x) => t.setUint16(o, x, little), u32 = (o, x) => t.setUint32(o, x, little);
  t.setUint16(0, little ? 0x4949 : 0x4d4d); u16(2, 42); u32(4, 8);
  const textAt = 100;
  for (let i = 0; i < stamp.length; i++) t.setUint8(textAt + i, stamp.charCodeAt(i));
  const entry = (o, tag, type, count, value) => { u16(o, tag); u16(o + 2, type); u32(o + 4, count); u32(o + 8, value); };
  if (ifd0Date) { u16(8, 1); entry(10, 0x0132, 2, stamp.length + 1, textAt); u32(22, 0); }
  else {
    u16(8, 1); entry(10, 0x8769, 4, 1, 26); u32(22, 0); // directory 0: the EXIF directory is at 26
    u16(26, 1); entry(28, 0x9003, 2, stamp.length + 1, textAt); u32(40, 0);
  }
  const tiff = new Uint8Array(t.buffer);
  const app1 = new Uint8Array(4 + 6 + tiff.length);
  const a = new DataView(app1.buffer);
  a.setUint16(0, 0xffe1); a.setUint16(2, 2 + 6 + tiff.length);
  app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); app1.set(tiff, 10);
  const jfif = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]; // an APP0 before it, like a real phone photo
  return new Uint8Array([0xff, 0xd8, ...jfif, ...app1, 0xff, 0xda]).buffer;
}

test('DateTimeOriginal is read, big-endian (iPhone) and little-endian (most Android)', () => {
  assert.deepEqual(photoTakenAt(jpegWithDate('2026:05:06 20:04:02')), { date: '2026-05-06', time: '20:04' });
  assert.deepEqual(photoTakenAt(jpegWithDate('2026:11:26 15:47:07', { little: true })), { date: '2026-11-26', time: '15:47' });
});

test('no DateTimeOriginal: directory 0\'s DateTime is the fallback', () => {
  assert.deepEqual(photoTakenAt(jpegWithDate('2026:11:23 19:22:00', { ifd0Date: true })), { date: '2026-11-23', time: '19:22' });
});

test('no EXIF, not a JPEG, or damaged: null, never an error', () => {
  assert.equal(photoTakenAt(new Uint8Array([0xff, 0xd8, 0xff, 0xda]).buffer), null);
  assert.equal(photoTakenAt(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer), null); // a PNG
  assert.equal(photoTakenAt(jpegWithDate('2026:11:26 15:47:07').slice(0, 30)), null); // cut short
  assert.equal(photoTakenAt(new ArrayBuffer(0)), null);
});

test('exifStamp: only real-looking dates', () => {
  assert.deepEqual(exifStamp('2026:02:28 07:05:00'), { date: '2026-02-28', time: '07:05' });
  assert.equal(exifStamp('0000:00:00 00:00:00'), null); // what a camera with no clock writes
  assert.equal(exifStamp('2026:13:01 07:05:00'), null);
  assert.equal(exifStamp(undefined), null);
});
