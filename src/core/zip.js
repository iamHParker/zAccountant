// Minimal ZIP writer (the reader is in xlsx.js). ℹ️ A .zip is a row of files, each with a small header, followed by a
// table of contents at the end. Each file is squeezed with Node's built-in deflate and carries a CRC-32 check value,
// so Windows Explorer, macOS Finder and Excel's "open" all read it. No third-party library.
import { deflateRawSync, crc32 } from 'node:zlib';

/** files: [{ name, data (Buffer or string) }] → Buffer of a .zip. `date` stamps every file (default: now). */
export function writeZip(files, { date = new Date() } = {}) {
  // MS-DOS time and date, as ZIP stores them.
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts = []; const central = []; let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const packed = deflateRawSync(data);
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); // version, flags: UTF-8 names
    head.writeUInt16LE(8, 8); head.writeUInt16LE(dosTime, 10); head.writeUInt16LE(dosDate, 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10); dir.writeUInt16LE(dosTime, 12); dir.writeUInt16LE(dosDate, 14);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    parts.push(head, name, packed);
    central.push(dir, name);
    offset += head.length + name.length + packed.length;
  }
  const dirSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
