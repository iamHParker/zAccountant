// A PDF written by hand for tests: each word drawn at its x, y in 9-point Helvetica, the way Excel or a bank's
// statement printer places it. words: [{x, y, str, page?}] (page counts from 1). Returns base64.
export function tinyPdf(words) {
  const esc = (t) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const pages = Math.max(1, ...words.map((w) => w.page ?? 1));
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${pages} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let p = 1; p <= pages; p++) {
    const stream = words.filter((w) => (w.page ?? 1) === p).map((w) => `BT /F1 9 Tf ${w.x} ${w.y} Td (${esc(w.str)}) Tj ET`).join('\n');
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + 2 * (p - 1)} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = '%PDF-1.4\n'; const at = [];
  objs.forEach((o, i) => { at.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1').toString('base64');
}
