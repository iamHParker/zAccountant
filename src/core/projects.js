// Projects from folder names (Homer, 2026-10-25). Homer keeps one folder per project, named by project number
// and name ("2601 Smith Residence", "2602 - DWH Jones roof"). In File Explorer, select the folders, Shift +
// right-click → "Copy as path", and paste: each line is a path in quotes ("C:\Jobs\2026\2601 Smith Residence").
// A plain list of names (one per line, or `dir /b` output) works too.
//
// Pure: no database. The service adds the projects that aren't on the list yet.

const MAX_LINES = 2000;

/** The last part of a path, without quotes or a trailing slash: "C:\Jobs\2601 Smith\" → "2601 Smith". */
export function folderName(line) {
  let s = String(line ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim(); // eslint-disable-line no-control-regex
  s = s.replace(/^["']+|["']+$/g, '').trim().replace(/[\\/]+$/, '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1].replace(/\s+/g, ' ').trim();
}

/**
 * One folder name → { name, code }. The project number is the leading run of digits (with an optional
 * letter prefix or suffix and dashes or dots inside, e.g. 2601, 26-014, P2601, 2601A); the name keeps the
 * whole folder name, so two "Smith Residence" projects with different numbers stay apart.
 * A name with no number gets code null.
 */
export function parseProjectFolder(line) {
  const name = folderName(line);
  if (!name) return null;
  const m = /^([A-Za-z]{0,3}\d[\d.-]*[A-Za-z]?)(?=$|[\s_–—:-])/.exec(name);
  const code = m ? m[1].replace(/[.-]+$/, '') : null;
  return { name: name.slice(0, 80), code: code && code.length <= 30 ? code : null };
}

/** Pasted text → unique projects (by name, ignoring case), in the order pasted; blank lines skipped. */
export function parseProjectList(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines.length > MAX_LINES) throw new Error(`Paste at most ${MAX_LINES} folders at a time`);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const p = parseProjectFolder(line);
    if (!p || seen.has(p.name.toLowerCase())) continue;
    seen.add(p.name.toLowerCase());
    out.push(p);
  }
  return out;
}
