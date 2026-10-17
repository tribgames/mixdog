import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Chromium rebuilds a stylesheet's rule set when one of its @media/@container
// conditions flips; a rebuilt set holding @font-face or @property rules
// relaid out every text node (and restyled the document) at each breakpoint a
// window drag crossed. Those rules live in font-faces.css, its own sheet.
const renderer = fileURLToPath(new URL('.', import.meta.url));
const read = (path) => readFile(join(renderer, path), 'utf8');
const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('the font sheet holds no conditional rule', async () => {
  const css = withoutComments(await read('font-faces.css'));
  assert.doesNotMatch(css, /@(media|container|supports)\b/);
  assert.match(css, /@font-face/);
  assert.match(css, /@property/);
});

test('the app sheet carries no font face or registered property', async () => {
  const app = ['styles.css', 'desktop.css', 'pane-layout.css', 'mobile-web-runtime.css', 'ui/tokens.css'];
  const layers = (await readdir(join(renderer, 'desktop'))).filter((name) => name.endsWith('.css'));
  for (const file of [...app, ...layers.map((name) => `desktop/${name}`)]) {
    const css = withoutComments(await read(file));
    assert.doesNotMatch(css, /@font-face|@property/, `${file} keeps font faces/registrations out of the app sheet`);
    assert.doesNotMatch(css, /katex\.min\.css/, `${file} leaves KaTeX's faces to font-faces.css`);
  }
});

test('the font sheet builds as its own file, ahead of the app sheet', async () => {
  const config = await readFile(join(renderer, '../../electron.vite.config.ts'), 'utf8');
  assert.match(config, /'font-faces': \[[^\]]*src\/renderer\/font-faces\.css/);
  const bootstrap = await read('bootstrap.tsx');
  const fonts = bootstrap.indexOf("import './font-faces-styles';");
  assert.ok(fonts >= 0 && fonts < bootstrap.indexOf("import './bootstrap-styles';"));
  assert.doesNotMatch(await read('bootstrap-styles.ts'), /import '[^']*(fontsource|pretendard|codicon|font-faces)/);
});
