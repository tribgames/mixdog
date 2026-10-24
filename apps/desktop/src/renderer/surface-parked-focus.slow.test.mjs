import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// The session terminal and browser live in parking hosts outside the dock's
// sheet, so the sheet's own inert never covers them. Each controller makes its
// surface's container inert itself whenever it is not shown over an open slot
// (parked, or kept on a closing sheet for its pixels), so the keyboard's Tab
// order never reaches it; a genuine reopen restores it. Real Chrome walks the
// Tab order here (jsdom has no sequential focus navigation or inert).

const ENTRY = `
  import React from 'react';
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import { SessionTerminalParkingHost, SessionTerminalSlot, useSessionTerminalSurfaces } from './session-terminal-surfaces.tsx';
  import { SessionBrowserParkingHost, SessionBrowserSlot, useSessionBrowserSurfaces } from './session-browser-surfaces.tsx';
  const body = (name) => () => React.createElement('button', { id: name + '-inside', type: 'button' }, name);
  const renderTerminal = body('terminal');
  const renderBrowser = body('browser');
  const noDispose = () => {};
  function Harness({ state }) {
    const terminals = useSessionTerminalSurfaces(renderTerminal, noDispose);
    const browsers = useSessionBrowserSurfaces(renderBrowser);
    const active = state !== 'closed';
    const exiting = state === 'exiting';
    return React.createElement(React.Fragment, null,
      React.createElement('button', { id: 'before', type: 'button' }, 'before'),
      React.createElement(SessionTerminalParkingHost, { controller: terminals }),
      React.createElement(SessionBrowserParkingHost, { controller: browsers }),
      React.createElement(SessionTerminalSlot, { controller: terminals, sessionId: 's1', active, foreground: active, cwd: null, exiting }),
      React.createElement(SessionBrowserSlot, { controller: browsers, sessionId: 's1', active, foreground: active, exiting }),
      React.createElement('button', { id: 'after', type: 'button' }, 'after'));
  }
  const root = createRoot(document.getElementById('root'));
  window.setDock = (state) => flushSync(() => root.render(React.createElement(Harness, { state })));
`;

const PROBES = `
  window.nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
`;

async function launch(t) {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const script = await build({
    stdin: { resolveDir, loader: 'tsx', contents: ENTRY },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
    // The default terminal/browser bodies reach skin media, styles and Vite
    // `?raw`/`?worker` modules that the fixture bodies never run.
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
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1000, height: 700 });
  await page.setContent(
    `<!doctype html><html><head><style>
      .session-terminal-slot, .session-browser-slot { display: block; width: 320px; height: 200px; }
      .session-terminal-surface-container, .session-browser-surface-container { position: fixed; }
    </style></head><body><div id="root"></div></body></html>`
  );
  await page.addScriptTag({ content: script.outputFiles[0].text });
  await page.addScriptTag({ content: PROBES });
  t.after(() => assert.deepEqual(errors, []));
  return page;
}

/** Puts the dock in `state`, then walks the Tab order from #before to #after. */
async function tabWalk(page, state) {
  await page.evaluate(async (next) => {
    setDock(next);
    await nextFrame();
    await nextFrame();
    document.getElementById('before').focus();
  }, state);
  const reached = [];
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
    reached.push(id);
    if (id === 'after') break;
  }
  return reached;
}

test('Tab never reaches a parked or closing terminal or browser; a reopen restores both', async (t) => {
  const page = await launch(t);
  const shown = await tabWalk(page, 'open');
  assert.ok(shown.includes('terminal-inside'), `open: the terminal is in the Tab order (${shown})`);
  assert.ok(shown.includes('browser-inside'), `open: the browser is in the Tab order (${shown})`);

  assert.deepEqual(await tabWalk(page, 'exiting'), ['after'], 'closing: pixels only, skipped by Tab');
  assert.deepEqual(await tabWalk(page, 'closed'), ['after'], 'parked after the exit: still skipped');

  const reopened = await tabWalk(page, 'open');
  assert.ok(
    reopened.includes('terminal-inside') && reopened.includes('browser-inside'),
    `reopened: both are reachable again (${reopened})`
  );
  assert.deepEqual(await tabWalk(page, 'closed'), ['after'], 'closed without an exit: skipped');
});
