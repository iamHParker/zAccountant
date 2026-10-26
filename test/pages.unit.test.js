import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { compilePage, page } from '../src/core/pages.js';

const file = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

test('the app and Road screens compile on the server with no template errors', () => {
  for (const [name, id] of [['index.html', 'app'], ['road.html', 'road']]) {
    const { shell, code } = page(file(name), id);
    assert.match(code, /from "\/vendor\/vue\.js"/, `${name} imports the same Vue the browser loads`);
    assert.match(code, /export function render/, name);
    assert.ok(shell.includes(`<div id="${id}" v-cloak></div>`), `${name}: the shell keeps an empty #${id}`);
    assert.ok(!shell.includes('{{'), `${name}: no template left in the shell`);
  }
});

test('a template mistake fails loudly, with its line number', () => {
  const html = '<body>\n<div id="app">\n<p class="a" class="b">x</p>\n</div>\n</body>';
  assert.throws(() => compilePage(html, 'app'), /Duplicate attribute.*line 3/);
});
