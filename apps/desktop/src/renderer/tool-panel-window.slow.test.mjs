import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// An expanded tool result mounts only the rows near its panel's viewport
// (tool-panel-window). In a real Chrome against the app's stylesheets, the
// same result is rendered twice, once with every row mounted: the panel opens
// alike, and wherever the reader scrolls, the rows in view are the same rows
// at the same place.

// The link component reaches the code editor, which only Vite can bundle; no
// row here opens it.
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

const PAGE = ['whole', 'windowed']
  .map((id, index) => `<div id="${id}" style="position:absolute;top:0;left:${index * 620}px;width:560px"></div>`)
  .join('');

const PROBE = `
  window.frames = (count = 4) => new Promise((resolve) => {
    let seen = 0;
    const next = () => (++seen > count ? resolve() : requestAnimationFrame(next));
    next();
  });
  // Every seventh row wraps.
  const rows = (count, from) => Array.from({ length: count }, (_, index) => ({
    line: from + index,
    text: 'row ' + (from + index) + (index % 7 === 3 ? ' ' + 'wide '.repeat(60) : ''),
  }));
  window.results = {
    code: [{ title: '', rows: rows(600, 1) }],
    sections: [
      ...Array.from({ length: 60 }, (_, index) => ({ title: 'file ' + index, meta: 'L1-3', rows: rows(3, index * 10) })),
      { title: 'long file', rows: rows(200, 1) },
      ...Array.from({ length: 20 }, (_, index) => ({ title: 'late ' + index, rows: rows(2, index) })),
    ],
  };
  const bodyOf = (id) => document.querySelector('#' + id + ' .tool-panel-body');
  window.viewOf = (id) => {
    const body = bodyOf(id);
    const box = body.getBoundingClientRect();
    const rows = [...body.querySelectorAll('.tool-code-row, .tool-section-header')]
      .map((node) => ({ rect: node.getBoundingClientRect(), text: node.textContent }))
      .filter(({ rect }) => rect.bottom > box.top && rect.top < box.bottom)
      .map(({ rect, text }) => ({ top: rect.top - box.top, height: rect.height, text }));
    return {
      height: box.height,
      scrollTop: body.scrollTop,
      scrollHeight: body.scrollHeight,
      rows,
      mounted: body.querySelectorAll('.tool-code-row').length,
    };
  };
  window.scrollBoth = async (top) => {
    for (const id of ['whole', 'windowed']) bodyOf(id).scrollTop = top;
    await window.frames();
  };
`;

let assets;

function panelAssets() {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  assets ??= Promise.all([
    build({
      stdin: {
        resolveDir,
        loader: 'tsx',
        contents: `
          import { createElement } from 'react';
          import { createRoot } from 'react-dom/client';
          import { ToolPanel, ToolSections } from './transcript-tool-panel';
          import { ToolPanelViewContext } from './tool-panel-window';
          const roots = new Map();
          // The result in pane \`id\`; \`windowed\` false mounts every row.
          window.showResult = (id, sections, windowed) => {
            if (!roots.has(id)) roots.set(id, createRoot(document.getElementById(id)));
            const result = createElement(ToolSections, { sections });
            roots.get(id).render(createElement(ToolPanel, { kind: 'code' },
              windowed ? result : createElement(ToolPanelViewContext.Provider, { value: null }, result)));
          };`,
      },
      bundle: true,
      write: false,
      logLevel: 'error',
      format: 'iife',
      outfile: 'panel.js',
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
      outfile: 'panel.css',
      bundle: true,
      write: false,
      logLevel: 'error',
      external: ['*.woff2', '*.woff', '*.ttf', '*.otf', '*.svg', '*.png', '*.jpg', '*.webp', '*.gif'],
    }),
  ]);
  return assets;
}

for (const result of ['code', 'sections']) {
  test(`a long tool result (${result}) mounts the rows near its panel's viewport, each in its place`, async (t) => {
    const [bundle, styles] = await panelAssets();
    const browser = await launchPuppeteerBrowser(puppeteer, {
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 700 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(`<!doctype html><html><head></head><body style="margin:0">${PAGE}</body></html>`);
    await page.addStyleTag({ content: styles.outputFiles.find((file) => file.path.endsWith('.css')).text });
    await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
    await page.evaluate(`${PROBE}
      window.showResult('whole', window.results.${result}, false);
      window.showResult('windowed', window.results.${result}, true);
      window.frames()`);
    assert.deepEqual(errors, [], 'both panels rendered');

    const read = async () => ({
      whole: await page.evaluate('window.viewOf("whole")'),
      windowed: await page.evaluate('window.viewOf("windowed")'),
    });
    const sameView = ({ whole, windowed }, label) => {
      assert.equal(windowed.height, whole.height, `${label}: panel height`);
      assert.equal(windowed.scrollTop, whole.scrollTop, `${label}: scroll offset`);
      assert.deepEqual(windowed.rows, whole.rows, `${label}: rows in view`);
      assert.ok(
        windowed.mounted < whole.mounted / 2,
        `${label}: most rows are out of the DOM: ${windowed.mounted} of ${whole.mounted}`
      );
    };

    const opened = await read();
    assert.ok(opened.whole.scrollHeight > 20 * opened.whole.height, 'the result is many panels long');
    assert.ok(opened.whole.rows.length > 0);
    sameView(opened, 'opened');

    // Down a panel at a time: each window is shown once, so it takes its real
    // height, wrapped rows included. Then back up over the measured boxes.
    const max = opened.whole.scrollHeight - opened.whole.height;
    const step = opened.whole.height - 40;
    for (let top = step; top < max + step; top += step) {
      await page.evaluate(`window.scrollBoth(${Math.min(top, max)})`);
      sameView(await read(), `down at ${Math.min(top, max)}`);
    }
    const end = await read();
    assert.equal(
      end.windowed.scrollHeight,
      end.whole.scrollHeight,
      'the result is as long once every window was shown'
    );
    for (let top = max - step; top > -step; top -= 3 * step) {
      await page.evaluate(`window.scrollBoth(${Math.max(top, 0)})`);
      const at = await read();
      sameView(at, `up at ${Math.max(top, 0)}`);
      assert.equal(at.windowed.scrollHeight, at.whole.scrollHeight);
    }

    // A click inside a row eight panels down (past the windows that are
    // always mounted), a jump to the end and a
    // shift-click on the last row: the selection starts at the clicked
    // character and holds the text of every row between. Its rows are freed
    // once it ends.
    await page.evaluate(`window.scrollBoth(${8 * step})`);
    const selectedText = (id) =>
      page.evaluate(`(async () => {
        const body = document.querySelector('#${id} .tool-panel-body');
        const box = body.getBoundingClientRect();
        const clicked = [...body.querySelectorAll('.tool-code-text')].find((row) => row.getBoundingClientRect().top > box.top);
        getSelection().collapse(clicked.firstChild, 2);
        body.scrollTop = ${max};
        await window.frames();
        const rows = body.querySelectorAll('.tool-code-text');
        const last = rows[rows.length - 1];
        getSelection().extend(last, last.childNodes.length);
        await window.frames();
        const text = getSelection().toString();
        getSelection().removeAllRanges();
        await window.frames();
        return text;
      })()`);
    const wholeText = await selectedText('whole');
    assert.ok(wholeText.startsWith('w ') && wholeText.split('\n').length > 200, wholeText.slice(0, 40));
    assert.equal(await selectedText('windowed'), wholeText, 'the selection holds every row from the clicked character');
    sameView(await read(), 'after the selection ended');

    assert.deepEqual(errors, []);
  });
}
