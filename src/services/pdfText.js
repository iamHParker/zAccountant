// Reads the words out of a PDF, with their positions, for the PDF readers (old invoices, bank statements).
// The PDF stays in memory and is dropped; it is never logged, stored or audited (it names clients and accounts).
import { getDocument as openPdf, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { LedgerError } from '../core/ledger.js';

/** base64 (or a data: URL) → PDF bytes, refusing anything over maxBytes or not a PDF. */
export function pdfBytes(pdf, maxBytes, what = 'a PDF') {
  if (typeof pdf !== 'string' || !pdf) throw new LedgerError(`Choose ${what}`);
  const bytes = Buffer.from(pdf.replace(/^data:[^,]*,/, ''), 'base64');
  if (bytes.length > maxBytes) throw new LedgerError(`That PDF is too large (${Math.round(maxBytes / 1048576)} MB at most)`);
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new LedgerError('That file is not a PDF');
  return bytes;
}

/**
 * PDF bytes → positioned words [{str, x, y, width}] of the first maxPages pages. Each page sits 2000 points below the
 * one before (a letter page is 792 points tall), so rows never mix across pages and stay in reading order.
 */
export async function pdfWords(bytes, maxPages = 2) {
  let task;
  try {
    task = openPdf({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
      verbosity: VerbosityLevel.ERRORS });
    const doc = await task.promise;
    const words = [];
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const shift = (n - 1) * 2000;
      for (const it of (await page.getTextContent()).items) {
        if (it.str) words.push({ str: it.str, x: it.transform[4], y: it.transform[5] - shift, width: it.width });
      }
    }
    if (!words.length) throw new LedgerError('That PDF has no text in it (a scanned picture cannot be read yet)');
    return words;
  } catch (e) {
    if (e instanceof LedgerError) throw e;
    throw new LedgerError('That PDF could not be read');
  } finally { await task?.destroy(); }
}
