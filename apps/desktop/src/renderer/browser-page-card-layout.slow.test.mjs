// Real-Chrome geometry of the browser-page card under a turn's browser work:
// the thumbnail slot has its final size from the first paint (placeholder),
// and neither the picture arriving late — of any size or aspect — nor failing
// to decode changes the slot, the card, the row, or the Open button's place.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const css = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const registered = (css('./font-faces.css').match(/@property[^}]*\}/g) ?? []).join('\n');
const STYLES = [registered, css('./desktop/01-tokens.css'), css('./desktop/13-tool-cards.css')].join('\n');

const PAGE = `
  import React from 'react';
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import { onBrowserPageRevealRequested } from './browser-page-request.ts';
  import { ToolActivityGroup } from './TranscriptView.tsx';
  onBrowserPageRevealRequested(() => {});
  const pending = new Map();
  window.mixdogDesktop = {
    browserPageIdentity: (url) => new Promise((resolve) => pending.set(url, resolve)),
  };
  window.__deliver = (url, identity) => pending.get(url)(identity && { url, ...identity });
  const root = createRoot(document.getElementById('root'));
  window.__show = (url) => flushSync(() => root.render(React.createElement(ToolActivityGroup, {
    items: [{ kind: 'tool', id: 'nav-' + url, name: 'browser', args: { action: 'navigate', input: { url } }, result: 'ok', completedAt: 1 }],
    disclosureScope: 'sess-geometry',
  })));
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  window.__measure = () => {
    const card = document.querySelector('.transcript-browser-page');
    const thumb = card.querySelector('.transcript-browser-page-thumb');
    const img = thumb.querySelector('img');
    const imgStyle = img && getComputedStyle(img);
    return {
      row: box(card.closest('article')),
      card: box(card),
      thumb: box(thumb),
      open: box(card.querySelector('.transcript-browser-page-open')),
      img: img ? { ...box(img), fit: imgStyle.objectFit, opacity: imgStyle.opacity, transition: imgStyle.transitionDuration, loaded: img.complete && img.naturalWidth > 0 } : null,
    };
  };
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
    outfile: 'browser-page-card-layout.js',
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
  await tab.setViewport({ width: 900, height: 700 });
  await tab.setContent(`<!doctype html><html><head><style>
    body { margin: 0; font-family: sans-serif; }
    ${STYLES}
  </style></head><body><div id="root" style="width:640px"></div></body></html>`);
  await tab.addScriptTag({ content: script });
  return tab;
}

const svg = (width, height) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#3b82f6"/></svg>`
  )}`;
const sameBox = (a, b, label) => assert.deepEqual(a, b, label);

test('the thumbnail slot keeps its size when the picture arrives late, at any size, or fails', async (t) => {
  const tab = await page(t);
  const measure = () => tab.evaluate(() => window.__measure());
  const scenarios = [
    ['wide', svg(1600, 400)],
    ['tall', svg(300, 1800)],
    ['tiny', svg(24, 24)],
    ['exact', svg(104, 66)],
    ['broken', 'data:image/png;base64,AAAA'],
  ];
  for (const [name, shot] of scenarios) {
    const url = `https://${name}.example.com/page/${name}`;
    await tab.evaluate((u) => window.__show(u), url);
    const first = await measure();
    // From the first paint the slot is the final 104×66 box, holding no image.
    assert.equal(first.img, null, `${name}: no image yet`);
    assert.equal(first.thumb.width, 104, `${name}: slot width at first paint`);
    assert.equal(first.thumb.height, 66, `${name}: slot height at first paint`);

    await tab.evaluate((u, s) => window.__deliver(u, { title: `Title of ${u}`, thumbnail: s }), url, shot);
    if (name === 'broken') {
      await tab.waitForFunction(
        () => !document.querySelector('.transcript-browser-page-thumb img') &&
          document.querySelector('.transcript-browser-page-thumb svg')
      );
    } else {
      await tab.waitForFunction(() => {
        const img = document.querySelector('.transcript-browser-page-thumb img');
        return img?.complete && img.naturalWidth > 0;
      });
    }
    const after = await measure();
    sameBox(after.thumb, first.thumb, `${name}: slot unchanged`);
    sameBox(after.card, first.card, `${name}: card unchanged`);
    sameBox(after.row, first.row, `${name}: row unchanged`);
    sameBox(after.open, first.open, `${name}: Open button unchanged`);
    if (after.img) {
      // The picture fills the slot (cover), at once: no fade holding it blank.
      assert.equal(after.img.width, 104, `${name}: image width`);
      assert.equal(after.img.height, 66, `${name}: image height`);
      assert.equal(after.img.fit, 'cover', `${name}: object-fit`);
      assert.equal(after.img.opacity, '1', `${name}: no fade-in`);
      assert.equal(after.img.transition, '0s', `${name}: no transition`);
    }
  }
});
