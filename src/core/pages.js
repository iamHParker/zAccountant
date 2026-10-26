// The app's screens are written as HTML inside index.html (and road.html). Vue has to turn that HTML into
// JavaScript (a "render function") before it can draw anything. Doing that in the browser made each browser read
// the HTML its own way first, and iPhone Safari read it differently enough to break (Oct 2026). So the server does
// it once, from the file exactly as written, and every browser runs the same code:
//   /app            -> index.html with the screens taken out (just the empty <div id="app">)
//   /app.render.js  -> the screens, already turned into JavaScript
// Like compiling a Fortran program once instead of interpreting it on every machine.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const { compile } = createRequire(import.meta.url)('@vue/compiler-dom');

// Splits the page at <div id="..."> ... </div> (the last </div> before </body>) and compiles what is inside.
// Throws on any template error, so a mistake fails the tests and the start-up instead of a blank page.
export function compilePage(html, id) {
  const start = html.indexOf(`<div id="${id}"`);
  if (start < 0) throw new Error(`No <div id="${id}"> in the page`);
  const open = html.indexOf('>', start) + 1;
  const end = html.lastIndexOf('</div>', html.indexOf('</body>'));
  const errors = [];
  const { code } = compile(html.slice(open, end), {
    mode: 'module',
    prefixIdentifiers: true,
    hoistStatic: true,
    cacheHandlers: true,
    whitespace: 'condense',
    runtimeModuleName: '/vendor/vue.js',
    onError: (e) => errors.push(`${e.message} (line ${html.slice(0, open).split('\n').length - 1 + e.loc.start.line})`),
    onWarn: () => {},
  });
  if (errors.length) throw new Error(`Template errors in #${id}: ${errors.join('; ')}`);
  return { shell: html.slice(0, open) + html.slice(end), code };
}

// Compiled once per file, again only if the file changes (so editing index.html locally needs no restart).
const cache = new Map();
export function page(file, id) {
  const mtime = fs.statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit?.mtime === mtime) return hit;
  const built = { mtime, ...compilePage(fs.readFileSync(file, 'utf8'), id) };
  cache.set(file, built);
  return built;
}
