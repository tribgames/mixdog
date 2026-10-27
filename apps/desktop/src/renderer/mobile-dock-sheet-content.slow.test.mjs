import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// The phone's right sheet (PaneSideDock on a phone surface) carries its body
// on every frame of its slide: the open mounts and shows the body in the
// commit that starts the slide, and a close keeps the last open body on the
// sheet (useSheetExit) until the sheet's own transform transition ends, while
// the panel is hidden, inert and aria-hidden from the close commit. The real
// component runs in headless Chrome with the app's stylesheet.

const ENTRY = `
  import React from 'react';
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import { PaneSideDock } from './pane-side-dock.tsx';
  const noop = () => {};
  const descriptors = new Map([['source-control', { id: 'source-control', label: 'Source Control', icon: () => null }]]);
  const root = createRoot(document.getElementById('root'));
  window.setSheet = (open) =>
    flushSync(() =>
      root.render(
        React.createElement(PaneSideDock, {
          leafId: 'pane-1',
          entry: { open, view: 'source-control', surface: '', diff: null },
          groups: [['source-control']],
          descriptors,
          focused: false,
          onSelect: noop,
          onClose: noop,
          onCloseDiff: noop,
          onMoveGroup: noop,
          onMoveView: noop,
          onFocusPane: noop,
          openFileTab: noop,
          // Like the app's views, the body hides itself while inactive.
          renderView: (_id, active) =>
            React.createElement('button', { id: 'inside', type: 'button', hidden: !active || undefined }, 'Body'),
        })
      )
    );
`;

const PROBES = `
  window.nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  window.snap = () => {
    const dock = document.querySelector('.pane-side-dock');
    const panel = dock.querySelector('.workbench-side-panel');
    const button = document.getElementById('inside');
    const box = button?.getBoundingClientRect();
    document.activeElement?.blur();
    button?.focus();
    return {
      left: Math.round(dock.getBoundingClientRect().left),
      body: Boolean(box && box.width > 0 && box.height > 0),
      closing: dock.dataset.closing ?? null,
      hidden: panel.hidden,
      inert: panel.inert,
      ariaHidden: panel.getAttribute('aria-hidden'),
      focused: Boolean(button) && document.activeElement === button,
    };
  };
  // Samples the change commit, then every frame until the sheet stops moving.
  window.changeAndSample = async (open) => {
    const samples = [];
    setSheet(open);
    samples.push(snap());
    let still = 0;
    while (still < 3 && samples.length < 120) {
      await nextFrame();
      const sample = snap();
      still = sample.left === samples.at(-1).left ? still + 1 : 0;
      samples.push(sample);
    }
    return samples;
  };
  // Rests once no transition or animation is running and the sheet has held
  // still for three frames (the exit commits a frame after transitionend).
  window.settle = async () => {
    let still = 0;
    let last = null;
    while (still < 3) {
      await nextFrame();
      await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
      const left = document.querySelector('.pane-side-dock').getBoundingClientRect().left;
      still = left === last && !document.getAnimations().length ? still + 1 : 0;
      last = left;
    }
  };
`;

const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

// One bundle build and one Chrome for the file; each test gets its own page.
let shared = null;
function sharedBrowser() {
  shared ??= (async () => {
    const [styles, script] = await buildBundles();
    const browser = await puppeteer.launch({
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
      headless: true,
    });
    return { browser, css: styles.outputFiles[0].text, js: script.outputFiles[0].text };
  })();
  return shared;
}

after(async () => {
  if (shared) await (await shared).browser.close();
});

function buildBundles() {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  return Promise.all([
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents: '@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
      },
      outfile: 'mobile-dock-sheet-content.css',
      bundle: true,
      write: false,
      loader: {
        '.woff': 'dataurl',
        '.woff2': 'dataurl',
        '.ttf': 'dataurl',
        '.svg': 'dataurl',
        '.jpg': 'dataurl',
        '.png': 'dataurl',
      },
    }),
    build({
      stdin: { resolveDir, loader: 'tsx', contents: ENTRY },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'error',
      // The dock's import graph reaches skin media, `?raw` text and `?worker`
      // modules (Vite suffixes) the sheet never runs.
      loader: { '.svg': 'empty', '.png': 'empty', '.jpg': 'empty', '.webm': 'empty', '.css': 'empty' },
      plugins: [
        {
          name: 'vite-suffix-stub',
          setup(builder) {
            builder.onResolve({ filter: /\?(raw|worker)$/ }, (args) => ({ path: args.path, namespace: 'vite-suffix' }));
            builder.onLoad({ filter: /\?raw$/, namespace: 'vite-suffix' }, () => ({ contents: '', loader: 'text' }));
            builder.onLoad({ filter: /\?worker$/, namespace: 'vite-suffix' }, () => ({
              contents: 'export default class {}',
              loader: 'js',
            }));
          },
        },
      ],
    }),
  ]);
}

async function launch(t) {
  const { browser, css, js } = await sharedBrowser();
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setUserAgent(PHONE_UA);
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.setContent(
    '<!doctype html><html data-mixdog-mobile-tabs><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>'
  );
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: js });
  await page.addScriptTag({ content: PROBES });
  await page.evaluate(() => setSheet(false));
  await page.evaluate(() => settle());
  t.after(() => assert.deepEqual(errors, []));
  return page;
}

test('the sheet opens with its body on every frame of the slide', async (t) => {
  const page = await launch(t);
  const samples = await page.evaluate(() => changeAndSample(true));
  assert.ok(new Set(samples.map((sample) => sample.left)).size > 5, 'the open is animated over several frames');
  for (const [index, sample] of samples.entries()) {
    assert.equal(sample.body, true, `frame ${index}: the body is on the sheet`);
    assert.deepEqual([sample.hidden, sample.inert, sample.closing], [false, false, null], `frame ${index}: open`);
  }
  assert.equal(samples.at(-1).left, 0, 'the sheet comes to rest open');
});

test('a closing sheet keeps its body on every slide frame, closed semantically from the close commit', async (t) => {
  const page = await launch(t);
  await page.evaluate(async () => {
    setSheet(true);
    await settle();
  });
  const open = await page.evaluate(() => snap());
  assert.deepEqual([open.left, open.body, open.focused], [0, true, true]);

  const samples = await page.evaluate(() => changeAndSample(false));
  const lefts = samples.map((sample) => sample.left);
  assert.ok(new Set(lefts).size > 5 && Math.max(...lefts) > 300, 'the sheet actually slides off screen');
  const sliding = samples.filter((sample) => sample.closing === 'true');
  assert.ok(sliding.length > 5, 'the closing mark spans the slide');
  for (const [index, sample] of sliding.entries()) {
    assert.equal(sample.body, true, `frame ${index}: the body slides out with the sheet`);
    assert.deepEqual(
      [sample.hidden, sample.inert, sample.ariaHidden, sample.focused],
      [true, true, 'true', false],
      `frame ${index}: hidden, inert, aria-hidden and unfocusable from the close commit`
    );
  }
  assert.equal(samples[0].closing, 'true', 'the close commit already carries the body');
  await page.evaluate(() => settle());
  const rest = await page.evaluate(() => snap());
  assert.deepEqual(
    [rest.closing, rest.body, rest.hidden, rest.focused],
    [null, false, true, false],
    'after the slide the body is gone and the mark cleared'
  );
});

test('reopening mid-close keeps the body and the open state', async (t) => {
  const page = await launch(t);
  const result = await page.evaluate(async () => {
    setSheet(true);
    await settle();
    setSheet(false);
    for (let index = 0; index < 4; index += 1) await nextFrame();
    const midway = snap();
    setSheet(true);
    const afterReopen = snap();
    await settle();
    return { midway, afterReopen, rest: snap() };
  });
  assert.ok(result.midway.left > 0 && result.midway.left < 390, 'the reopen interrupts a slide in progress');
  assert.equal(result.midway.body, true);
  assert.deepEqual(
    [result.afterReopen.body, result.afterReopen.closing, result.afterReopen.hidden],
    [true, null, false]
  );
  assert.deepEqual([result.rest.left, result.rest.body, result.rest.inert], [0, true, false]);
});

test('reduced motion closes in the close commit, with no closing mark', async (t) => {
  const page = await launch(t);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluate(async () => {
    setSheet(true);
    await settle();
  });
  const sample = await page.evaluate(() => {
    setSheet(false);
    return snap();
  });
  assert.deepEqual([sample.body, sample.closing, sample.hidden], [false, null, true]);
});
