import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// A long settled reply keeps only the blocks near the reader in the DOM
// (markdown-block-parking). In a real Chrome against the app's stylesheets and
// markdown components, the same reply is rendered twice, once whole: wherever
// the reader scrolls, every block of the parked one sits where the whole one
// has it, to the layout unit, and the reply is as tall.

const SECTIONS = 40;

// The link component reaches the code editor, which only Vite can bundle; no
// reply block here opens it.
const WITHOUT_EDITOR = {
  name: 'without-editor',
  setup(bundler) {
    bundler.onResolve({ filter: /monaco/ }, (args) => ({ path: args.path, namespace: 'without-editor' }));
    bundler.onLoad({ filter: /.*/, namespace: 'without-editor' }, () => ({
      contents: 'module.exports = new Proxy({}, { get: () => () => null });',
      loader: 'js',
    }));
  },
};

// hast, as the markdown parser emits it.
const HAST = `
  const el = (tagName, children, properties = {}) => ({ type: 'element', tagName, properties, children });
  const text = (value) => ({ type: 'text', value });
  const words = (n, seed) => Array.from({ length: n }, (_, i) => 'word' + ((i * 7 + seed) % 23)).join(' ');
  const section = (n) => [
    el('h' + (1 + (n % 3)), [text('Section ' + n)]),
    text('\\n'),
    el('p', [text(words(40 + (n % 5) * 30, n)), el('code', [text('inline')]), text(' tail')]),
    text('\\n'),
    el('ul', [1, 2, 3].map((i) => el('li', [el('p', [text(words(12 * i, n + i))])]))),
    text('\\n'),
    el('blockquote', [el('p', [text(words(25, n))]), el('p', [text(words(9, n + 3))])]),
    text('\\n'),
    el('pre', [el('code', [text(Array.from({ length: 6 + (n % 4) }, (_, i) => 'const v' + i + ' = ' + n + ';').join('\\n') + '\\n')], { className: ['language-js'] })]),
    text('\\n'),
    el('table', [
      el('thead', [el('tr', [el('th', [text('Name')]), el('th', [text('Value')])])]),
      el('tbody', [1, 2].map((i) => el('tr', [el('td', [text('row ' + i)]), el('td', [text(words(14, n + i))])]))),
    ]),
    text('\\n'),
    el('hr', []),
    text('\\n'),
    el('ol', [1, 2].map((i) => el('li', [text(words(8, n * i))]))),
    text('\\n'),
  ];
  // The reply opens and closes on a block whose child's margin leaves through
  // the reply's own edge.
  const edge = () => el('ul', [el('li', [el('h1', [text('Edge')])])]);
  window.replyRoot = (count) => ({
    type: 'root',
    children: [edge(), text('\\n'), ...Array.from({ length: count }, (_, n) => section(n)).flat(), edge()],
  });
`;

const PAGE = (width) => `
  <style>.pane { position: absolute; top: 0; height: 600px; overflow-y: auto; }</style>
  ${['whole', 'parked']
    .map(
      (id, index) => `
  <div class="pane" id="${id}" style="left:${index * 620}px;width:${width}px">
    <div style="height:500px"></div>
    <div class="transcript-virtual-row"><article class="message assistant settled"><div class="message-body" id="${id}-host"></div></article></div>
    <div style="height:500px"></div>
  </div>`
    )
    .join('')}`;

const PROBE = `
  window.frames = (count = 8) => new Promise((resolve) => {
    let seen = 0;
    const next = () => (++seen > count ? resolve() : requestAnimationFrame(next));
    next();
  });
  window.blocksOf = (id) => {
    const reply = document.querySelector('#' + id + ' .markdown');
    const top = reply.getBoundingClientRect().top;
    const rows = [...reply.children]
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { top: rect.top - top, height: rect.height, parked: node.hasAttribute('data-md-parked'), text: node.textContent };
      });
    return { height: reply.getBoundingClientRect().height, rows, elements: reply.querySelectorAll('*').length };
  };
  window.scrollBoth = async (top) => {
    for (const id of ['whole', 'parked']) document.getElementById(id).scrollTop = top;
    await window.frames();
  };
`;

function sameGeometry(whole, parked, label) {
  assert.equal(parked.height, whole.height, `${label}: reply height`);
  assert.equal(parked.rows.length, whole.rows.length, `${label}: block count`);
  parked.rows.forEach((row, index) => {
    const expected = whole.rows[index];
    assert.equal(row.top, expected.top, `${label}: block ${index} top`);
    assert.equal(row.height, expected.height, `${label}: block ${index} height`);
    if (!row.parked) assert.equal(row.text, expected.text, `${label}: block ${index} text`);
  });
}

test('parked blocks leave the DOM and the reply keeps its exact geometry', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const [bundle, styles] = await Promise.all([
    build({
      stdin: {
        resolveDir,
        loader: 'tsx',
        contents: `
          import { createElement, useLayoutEffect, useRef, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import MarkdownAstBody from './MarkdownAstBody';
          import { createBlockParking, MarkdownBlockParkingContext } from './markdown-block-parking';
          const Copy = () => null;
          function Reply({ root, parks }) {
            const ref = useRef(null);
            const [parking] = useState(createBlockParking);
            useLayoutEffect(() => { if (parks) parking.attach(ref.current, true); }, [parking, parks]);
            return createElement(MarkdownBlockParkingContext.Provider, { value: parks ? parking : null },
              createElement('div', { ref, className: 'markdown' }, createElement(MarkdownAstBody, { root, copyControl: Copy })));
          }
          window.mountReply = (host, root, parks) => createRoot(host).render(createElement(Reply, { root, parks }));`,
      },
      bundle: true,
      write: false,
      logLevel: 'error',
      format: 'iife',
      outfile: 'parking.js',
      loader: { '.svg': 'dataurl', '.png': 'dataurl', '.css': 'empty' },
      plugins: [WITHOUT_EDITOR],
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents: ['font-faces', 'ui/tokens', 'styles', 'desktop', 'pane-layout']
          .map((sheet) => `@import "./${sheet}.css";`)
          .join('\n'),
      },
      outfile: 'parking.css',
      bundle: true,
      write: false,
      logLevel: 'error',
      external: ['*.woff2', '*.woff', '*.ttf', '*.otf', '*.svg', '*.png', '*.jpg', '*.webp', '*.gif'],
    }),
  ]);
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1300, height: 700 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(`<!doctype html><html><head></head><body style="margin:0">${PAGE(560)}</body></html>`);
  await page.addStyleTag({ content: styles.outputFiles.find((file) => file.path.endsWith('.css')).text });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  await page.evaluate(`${HAST}${PROBE}
    const root = window.replyRoot(${SECTIONS});
    window.mountReply(document.getElementById('whole-host'), root, false);
    window.mountReply(document.getElementById('parked-host'), root, true);`);
  await page.evaluate('window.frames()');
  assert.deepEqual(errors, [], 'both replies rendered');

  const read = async () => ({
    whole: await page.evaluate('window.blocksOf("whole")'),
    parked: await page.evaluate('window.blocksOf("parked")'),
  });
  const max = await page.evaluate(
    '(() => { const pane = document.getElementById("whole"); return pane.scrollHeight - pane.clientHeight; })()'
  );
  assert.ok(max > 6000, `the reply is many viewports long: ${max}`);

  const first = await read();
  assert.ok(
    first.parked.rows.some((row) => row.parked),
    'blocks far below the reader are parked'
  );
  assert.ok(
    first.parked.elements < first.whole.elements / 3,
    `most of the reply left the DOM: ${first.parked.elements} of ${first.whole.elements} elements`
  );
  sameGeometry(first.whole, first.parked, 'at the top');

  for (const top of [max / 3, max, max / 2, 0, max * 0.8]) {
    await page.evaluate(`window.scrollBoth(${top})`);
    const at = await read();
    sameGeometry(at.whole, at.parked, `at ${Math.round(top)}`);
    const view = { top: top - 500, bottom: top - 500 + 600 };
    for (const row of at.parked.rows) {
      const inView = row.top + row.height > view.top && row.top < view.bottom;
      if (inView) assert.equal(row.parked, false, `a block in view at ${Math.round(top)} is mounted`);
    }
    assert.ok(at.parked.elements < at.whole.elements / 3, `still mostly out of the DOM at ${Math.round(top)}`);
  }

  // Another width: a parked box stands for its block as measured, so each
  // block takes its real height when the reader reaches it. Once the reader
  // has passed over the whole reply, it is laid out as the whole one again.
  await page.evaluate(`
    for (const id of ['whole', 'parked']) document.getElementById(id).style.width = '400px';
    window.frames()`);
  const narrowMax = await page.evaluate(
    '(() => { const pane = document.getElementById("whole"); return pane.scrollHeight - pane.clientHeight; })()'
  );
  for (let top = 0; top <= narrowMax + 600; top += 300) await page.evaluate(`window.scrollBoth(${top})`);
  for (let top = narrowMax; top >= 0; top -= 300) await page.evaluate(`window.scrollBoth(${top})`);
  await page.evaluate('window.scrollBoth(0)');
  const narrow = await read();
  sameGeometry(narrow.whole, narrow.parked, 'after the width changed');
  assert.ok(narrow.parked.rows.some((row) => row.parked));

  assert.deepEqual(errors, []);
});
