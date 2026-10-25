// Minimal Excel (.xlsx) reader: returns the first worksheet as rows of text cells.
//
// ℹ️ An .xlsx file is a ZIP archive of XML files. We read the ZIP directory, inflate the three parts
// we need (workbook, shared strings, first sheet) with Node's built-in zlib, and pull out cell values.
// Formulas come through as their last calculated value. No third-party library needed.
import { inflateRawSync } from 'node:zlib';

export class XlsxError extends Error {}

/** Read a .zip: returns name → text (or, with { raw: true }, a Buffer), or null when the name isn't there. */
export function unzip(buf) {
  // Find the "end of central directory" record (signature 0x06054b50) near the end of the file.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new XlsxError('This is not an Excel .xlsx file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('Damaged .xlsx file');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, { method, compSize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return (name, { raw = false } = {}) => {
    const f = files.get(name);
    if (!f) return null;
    const start = f.local + 30 + buf.readUInt16LE(f.local + 26) + buf.readUInt16LE(f.local + 28);
    const data = buf.subarray(start, start + f.compSize);
    const out = f.method === 0 ? data : f.method === 8 ? inflateRawSync(data, { maxOutputLength: 50_000_000 }) : null;
    if (out) return raw ? Buffer.from(out) : out.toString('utf8');
    throw new XlsxError('Unsupported compression in .xlsx file');
  };
}

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');
const textOf = (xml) => unescapeXml([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

/** Column letters → 0-based index (A=0, Z=25, AA=26). */
const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** Excel date serial (days since 1899-12-30) → YYYY-MM-DD. */
export function excelSerialToIso(serial) {
  const ms = Math.round(Number(serial) * 86_400_000) + Date.UTC(1899, 11, 30);
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Read the first worksheet. Returns rows of strings. Cells formatted as dates are converted to
 * YYYY-MM-DD; numbers keep full precision as text (money is converted to cents later, exactly).
 */
export function readXlsx(buffer) {
  const read = unzip(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  const rels = read('xl/_rels/workbook.xml.rels') ?? '';
  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new XlsxError('This is not an Excel .xlsx file');
  const firstSheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const target = firstSheet && new RegExp(`<Relationship\\b[^>]*Id="${firstSheet}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
  const sheetPath = target ? `xl/${target.replace(/^\/?xl\//, '')}` : 'xl/worksheets/sheet1.xml';
  const sheet = read(sheetPath);
  if (!sheet) throw new XlsxError('The workbook has no worksheet');
  const shared = [...(read('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));

  // Which cell styles are dates? (built-in date formats 14-22, 45-47, or custom formats containing d/m/y)
  const styles = read('xl/styles.xml') ?? '';
  const customDate = new Set([...styles.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)]
    .filter((m) => /[dmy]/i.test(m[2].replace(/\[[^\]]*\]|"[^"]*"/g, ''))).map((m) => Number(m[1])));
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const dateStyle = [...xfs.matchAll(/<xf\b([^>]*)\/?>/g)].map((m) => {
    const id = Number(/numFmtId="(\d+)"/.exec(m[1])?.[1] ?? 0);
    return (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || customDate.has(id);
  });

  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row = [];
    for (const cm of (rm[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? 0);
      const inner = cm[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(inner);
      else if (type === 'str' || type === 'e') value = v != null ? unescapeXml(v) : '';
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (v != null) value = dateStyle[style] ? excelSerialToIso(v) : normalizeNumber(v);
      const idx = ref ? colIndex(ref) : row.length;
      while (row.length < idx) row.push('');
      row[idx] = value;
    }
    if (row.some((x) => String(x).trim() !== '')) rows.push(row);
    if (rows.length > 100_000) throw new XlsxError('The worksheet is too large');
  }
  return rows;
}

/**
 * Excel stores numbers as binary floating point text, e.g. 1234.56 may be "1234.5599999999999".
 * Money has at most 2 decimals, so round the text to 6 significant decimals without going through
 * float arithmetic in a way that could change a cent.
 */
function normalizeNumber(v) {
  if (!/^-?\d+(\.\d+)?(E[+-]?\d+)?$/i.test(v)) return v;
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return String(Math.round(n * 1e6) / 1e6);
}
