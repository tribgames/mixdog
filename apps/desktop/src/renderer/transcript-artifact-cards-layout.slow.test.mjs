import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const css = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const registered = (css('./font-faces.css').match(/@property[^}]*\}/g) ?? []).join('\n');
const STYLES = [
  registered,
  css('./ui/tokens.css'),
  css('./desktop/01-tokens.css'),
  css('./desktop/13-tool-cards.css'),
].join('\n');

const PAGE = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { onBrowserPageRevealRequested } from './browser-page-request.ts';
  import { ToolActivityGroup } from './transcript-tool-ui.tsx';
  import { MarkdownProjectContext } from './MarkdownLink.tsx';
  onBrowserPageRevealRequested(() => {});
  const svg = (width, height, fill) =>
    btoa('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><rect width="100%" height="100%" fill="' + fill + '"/></svg>');
  const pages = { 'report.pdf': [320, 414, '#ef4444'], 'sheet.xlsx': [320, 226, '#22c55e'] };
  window.mixdogDesktop = {
    browserPageIdentity: async (url) => ({ url, title: 'Example Domain', thumbnail: 'data:image/svg+xml;base64,' + svg(300, 1800, '#3b82f6') }),
    resolveLocalPaths: async ([absolutePath]) => {
      if (/gone/.test(absolutePath)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [{ absolutePath, dir: false, projectPath: 'C:/work', relPath: absolutePath.slice('C:/work/'.length) }];
    },
    statProjectFile: async () => ({ mtimeMs: 1, size: 6144 }),
    previewDocumentPages: async (_project, relPath) => {
      const page = pages[relPath];
      if (!page) throw new Error('no converter');
      return { pageCount: 1, pages: [{ page: 1, width: page[0], height: page[1], mime: 'image/svg+xml', base64: svg(...page) }] };
    },
  };
  const office = (path) => ({ kind: 'tool', id: path, name: 'office', args: { action: 'create' }, result: { ok: true, artifacts: [{ path, operation: 'create' }] }, completedAt: 1 });
  createRoot(document.getElementById('root')).render(
    React.createElement(MarkdownProjectContext.Provider, { value: 'C:/work' },
      React.createElement(ToolActivityGroup, {
        items: [
          { kind: 'tool', id: 'nav', name: 'browser', args: { action: 'navigate', input: { url: 'https://example.org/' } }, result: 'ok', completedAt: 1 },
          office('C:/work/sheet.xlsx'),
          office('C:/work/notes.docx'),
          office('C:/work/report.pdf'),
          office('C:/work/gone.pptx'),
        ],
        disclosureScope: 'sess-artifacts',
      })));
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  };
  window.__ready = () => {
    const thumbs = [...document.querySelectorAll('.transcript-artifact-thumb')];
    const shot = document.querySelector('.transcript-browser-page-thumb img');
    return thumbs.length === 4 && thumbs.every((t) => t.dataset.thumb !== 'loading') &&
      [...document.querySelectorAll('.transcript-artifact-thumb img, .transcript-browser-page-thumb img')].length === 3 &&
      [...document.querySelectorAll('img')].every((img) => img.complete && img.naturalWidth > 0) && Boolean(shot);
  };
  window.__measure = () =>
    [...document.querySelectorAll('.transcript-browser-page, .transcript-artifact-file')].map((card) => {
      const thumb = card.querySelector('.transcript-artifact-thumb, .transcript-browser-page-thumb');
      const img = thumb.querySelector('img');
      return {
        name: card.querySelector('.transcript-artifact-body > span, .transcript-browser-page-copy > b').textContent,
        card: box(card),
        thumb: box(thumb),
        picture: img ? box(img) : null,
        glyph: thumb.querySelector('svg') ? box(thumb.querySelector('svg')) : null,
      };
    });
`;

async function page(t) {
  const bundle = await build({
    plugins: [
      {
        name: 'worker-stub',
        setup(builder) {
          builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
          builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
            contents: 'export default class {};',
            loader: 'js',
          }));
        },
      },
    ],
    stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'tsx' },
    outfile: 'transcript-artifact-cards-layout.js',
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
  const script = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const tab = await browser.newPage();
  await tab.setViewport({ width: 900, height: 900 });
  await tab.setContent(`<!doctype html><html><head><style>
    body { margin: 0; font-family: sans-serif; }
    ${STYLES}
  </style></head><body><div id="root" style="width:720px"></div></body></html>`);
  await tab.addScriptTag({ content: script });
  await tab.waitForFunction(() => window.__ready());
  return tab;
}

test('every artifact card shares one thumbnail box and one height, wide and narrow', async (t) => {
  const tab = await page(t);
  for (const width of [720, 300]) {
    await tab.evaluate((w) => {
      document.getElementById('root').style.width = `${w}px`;
    }, width);
    const cards = await tab.evaluate(() => window.__measure());
    assert.deepEqual(
      cards.map((card) => card.name),
      ['Example Domain', 'sheet.xlsx', 'notes.docx', 'report.pdf', 'gone.pptx']
    );
    const [first] = cards;
    for (const card of cards) {
      assert.deepEqual(card.thumb, { width: 104, height: 66 }, `${width}px ${card.name}: thumbnail box`);
      assert.equal(card.card.height, first.card.height, `${width}px ${card.name}: card height`);
      assert.equal(card.card.width, first.card.width, `${width}px ${card.name}: card width`);
      // A real preview fills the box; the type glyph sits inside it.
      if (card.picture) assert.deepEqual(card.picture, card.thumb, `${width}px ${card.name}: preview fills the box`);
      else assert.ok(card.glyph.width <= 104 && card.glyph.height <= 66, `${width}px ${card.name}: glyph fits`);
    }
    assert.deepEqual(
      cards.map((card) => Boolean(card.picture)),
      [true, true, false, true, false],
      'previews where they exist, glyphs otherwise'
    );
    assert.ok(first.card.width <= width, `${width}px: cards never overflow the column`);
  }
});
