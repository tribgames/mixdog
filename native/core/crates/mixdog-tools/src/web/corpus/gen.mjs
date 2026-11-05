// Builds the recorded extraction corpus: every case's body and the output of
// today's Node extractor (src/runtime/web-search/lib/document-content.mjs) on it.
//   node gen.mjs <path to the Node mixdog checkout>
// Output is committed; the Rust gate (../tests.rs) reads it and never needs Node.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { FIXTURES } from './fixtures.mjs';

const nodeRoot = path.resolve(process.argv[2] || 'C:/Project/mixdog');
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'cases');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const { extractDocument } = await import(
  pathToFileURL(path.join(nodeRoot, 'src/runtime/web-search/lib/document-content.mjs')).href
);
const require = createRequire(path.join(nodeRoot, 'package.json'));
const { marked } = require('marked');

const cases = [...FIXTURES];

// Rendered documentation pages in three real-world layouts.
const docs = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/auto-reasoning-effort.md',
  'docs/code-tidy.md',
  'docs/computer-use-architecture.md',
  'docs/computer-use-parity.md',
  'docs/internal/place-plan.md',
  'docs/internal/i18n-audit.md',
  'docs/internal/computer-use-delivery-audit.md',
];
const layouts = [
  (title, html) =>
    `<!doctype html><html><head><title>${title}</title></head><body><header><nav><a href="/">Home</a></nav></header><main><article class="markdown-body">${html}</article></main><footer>© docs</footer></body></html>`,
  (title, html) =>
    `<!doctype html><html><head><title>${title}</title></head><body><div class="top"><a href="/">Home</a> <a href="/docs">Docs</a></div><div class="page"><div class="body">${html}</div><div class="side"><ul><li><a href="/x">X</a></li><li><a href="/y">Y</a></li></ul></div></div></body></html>`,
  (title, html) =>
    `<!doctype html><html><head><title>${title}</title></head><body><div id="app"><aside>menu</aside><article>${html}</article></div></body></html>`,
];
docs.forEach((file, index) => {
  const full = path.join(nodeRoot, file);
  if (!fs.existsSync(full)) return;
  const md = fs.readFileSync(full, 'utf8');
  const html = marked.parse(md, { gfm: true });
  const slug = file.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  cases.push({
    name: `doc-${slug}`,
    url: `https://docs.example.com/${file}`,
    body: layouts[index % layouts.length](file, html),
  });
});

// Real, messy HTML from the checkout (design mockups): style-heavy div soup.
const design = path.join(nodeRoot, 'design');
fs.readdirSync(design)
  .filter((file) => file.endsWith('.html'))
  .sort()
  .filter((file) => fs.statSync(path.join(design, file)).size < 70000)
  .filter((_, index) => index % 3 === 0)
  .slice(0, 28)
  .forEach((file) => {
    cases.push({
      name: `design-${file.replace(/\.html$/, '')}`,
      url: `https://design.example.com/${file}`,
      body: fs.readFileSync(path.join(design, file), 'utf8'),
    });
  });

const summary = {};
for (const item of cases) {
  const contentType = item.contentType ?? 'text/html; charset=utf-8';
  let expected;
  try {
    const payload = await extractDocument(item.url, item.body, contentType);
    expected = { ok: true, title: payload.title, content: payload.content, extractor: payload.extractor };
  } catch (error) {
    expected = { ok: false, code: error.code || 'ERROR', message: error.message };
  }
  summary[expected.ok ? expected.extractor : 'error'] = (summary[expected.ok ? expected.extractor : 'error'] || 0) + 1;
  fs.writeFileSync(path.join(out, `${item.name}.body`), item.body);
  fs.writeFileSync(
    path.join(out, `${item.name}.json`),
    `${JSON.stringify({ url: item.url, contentType, expected }, null, 1)}\n`
  );
}
console.log(cases.length, 'cases', JSON.stringify(summary));
