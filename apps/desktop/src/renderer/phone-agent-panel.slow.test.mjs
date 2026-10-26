import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// The phone's agent panel in headless Chrome: the real PaneSideDock around the
// real AgentPanel (profile form + routines list over stubbed capabilities),
// with the app's own styles bundled the way the renderer imports them
// (bootstrap-styles.ts plus every component's CSS import: tab-strip.css,
// pane-layout.css, routines.css, settings.css …).
// (a) The dock's title row drops the repeated "Profile" but keeps its close
//     control, at the same height and right edge as any other view's row; the
//     panel's own tabs stay; the desktop keeps the title.
// (b) The sheet's opposite swipe (rightward, back toward the edge it slid in
//     from) follows the finger and closes it, also when it starts over the
//     panel's tabs or its routine list; a vertical drag, a short slow drag or
//     an aborted one leaves it open; a swipe that starts in a profile input
//     stays the input's (the edge swipe's long-standing exclusion).
// PHONE_AGENT_PANEL_SHOT=<file.png> keeps a picture of the open phone sheet.

const ENTRY = `
  import React from 'react';
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import './bootstrap-styles.ts';
  import { PaneSideDock } from './pane-side-dock.tsx';
  import { AgentPanel } from './RoutinesPane.tsx';
  import { useEdgeSwipeDrawers } from './use-edge-swipe-drawers.ts';
  import { SET_DOCK_OPEN_EVENT } from './open-dock-tab-event.ts';
  const noop = () => {};
  const icon = () => null;
  const SESSION = 'sess_home_writer';
  const descriptors = new Map([
    ['routines', { id: 'routines', label: 'Profile', tooltip: 'Profile', icon }],
    ['source-control', { id: 'source-control', label: 'Source Control', icon }],
  ]);
  const values = {
    getChannelSetup: {
      schedules: Array.from({ length: 12 }, (_, i) => ({
        name: 'routine-' + i, owner: 'writer', enabled: true, whenCron: '0 9 * * *',
      })),
      webhooks: [],
    },
    getAgentDefinition: {
      name: 'Writer', description: 'Drafts posts', persona: 'Calm', body: 'Write.', route: {}, revision: 'r1',
    },
  };
  window.mixdogDesktop = new Proxy({
    invokeCapability: async ({ capability }) => ({ value: values[capability] ?? [] }),
  }, {
    get: (target, name) => name in target ? target[name]
      : String(name).startsWith('subscribe') ? () => () => {} : async () => undefined,
  });
  const root = createRoot(document.getElementById('root'));
  window.closeCalls = 0;
  const Swipe = () => {
    useEdgeSwipeDrawers({ sidebarOpen: false, openSidebar: noop, applySidebarOpen: noop });
    return null;
  };
  window.setSheet = (open, view = 'routines') =>
    flushSync(() =>
      root.render(
        React.createElement(React.Fragment, null,
          React.createElement(Swipe),
          React.createElement(PaneSideDock, {
            leafId: 'pane-1',
            entry: { open, view, surface: '', diff: null },
            groups: [['routines'], ['source-control']],
            descriptors,
            focused: false,
            onSelect: noop,
            onClose: () => { window.closeCalls += 1; },
            onCloseDiff: noop,
            onMoveGroup: noop,
            onMoveView: noop,
            onFocusPane: noop,
            openFileTab: noop,
            renderView: (id, active) =>
              id === 'routines'
                ? React.createElement(AgentPanel, { sessionId: SESSION, active, leafId: 'pane-1' })
                : React.createElement('div', { hidden: !active || undefined }, 'Source'),
          })
        )
      )
    );
  window.addEventListener(SET_DOCK_OPEN_EVENT, (event) => setSheet(event.detail.open));
`;

const PROBES = `
  window.settle = () => new Promise((resolve) => setTimeout(resolve, 700));
  window.waitFor = async (selector) => {
    for (let i = 0; i < 80 && !document.querySelector(selector); i++) await new Promise((r) => setTimeout(r, 50));
    return Boolean(document.querySelector(selector));
  };
  window.dock = () => document.querySelector('.pane-side-dock');
  window.header = () => {
    const row = document.querySelector('.pane-side-dock-chrome');
    const close = row?.querySelector('button[aria-label="Close panel"]');
    const box = (node) => { const b = node.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, height: b.height }; };
    return {
      row: Boolean(row),
      title: row?.querySelector('.dock-header-title')?.textContent ?? null,
      label: row?.getAttribute('aria-label') ?? null,
      rowBox: row ? box(row) : null,
      closeBox: close ? box(close) : null,
      tabs: [...document.querySelectorAll('.agent-panel-tabs [role="tab"]')]
        .filter((tab) => tab.getBoundingClientRect().height > 0).map((tab) => tab.textContent),
    };
  };
  window.state = () => {
    const dock = window.dock();
    return { open: dock.dataset.open, left: Math.round(dock.getBoundingClientRect().left), inline: dock.getAttribute('style') ?? '' };
  };
  window.centerOf = (selector) => {
    const b = document.querySelector(selector).getBoundingClientRect();
    return [Math.round(b.left + 24), Math.round(b.top + b.height / 2)];
  };
  window.openRoutinesTab = () => {
    [...document.querySelectorAll('.agent-panel-tabs [role="tab"]')].find((tab) => tab.textContent === 'Routines').click();
  };
`;

const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

let bundled;
async function bundle() {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  bundled ??= build({
    stdin: { resolveDir, loader: 'tsx', contents: ENTRY },
    outdir: 'phone-agent-panel-out',
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"file:///renderer/bundle.mjs"' },
    logLevel: 'error',
    loader: {
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.svg': 'dataurl',
      '.jpg': 'dataurl',
      '.png': 'dataurl',
      '.webm': 'empty',
    },
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
  const result = await bundled;
  const text = (ext) => result.outputFiles.find((file) => file.path.endsWith(ext)).text;
  return { script: text('.js'), styles: text('.css') };
}

async function launch(t, { phone }) {
  const { script, styles } = await bundle();
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  if (phone) {
    await page.setUserAgent(PHONE_UA);
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  } else {
    await page.setViewport({ width: 1400, height: 900 });
  }
  await page.setContent(
    `<!doctype html><html${phone ? ' data-mixdog-mobile-tabs' : ''}><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>`
  );
  await page.addStyleTag({ content: styles });
  // A bundled dependency reads Node's `process` (the renderer build defines it).
  await page.addScriptTag({ content: 'window.process = { env: {}, platform: "win32", version: "v20.0.0", versions: {}, cwd: () => "/", argv: [] };' });
  await page.addScriptTag({ content: script });
  await page.addScriptTag({ content: PROBES });
  assert.deepEqual(errors, [], 'the bundle loaded');
  await page.evaluate(() => setSheet(true));
  assert.ok(await page.evaluate(() => waitFor('.agent-profile-form')), 'the real profile form rendered');
  await page.evaluate(() => settle());
  t.after(() => assert.deepEqual(errors, []));
  return page;
}

/** One finger by CDP: down at `from`, moves in `steps` equal steps `ms` apart. */
async function touch(cdp, from, to, steps, ms, { release = true } = {}) {
  const point = (p) => [{ x: p[0], y: p[1], id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from) });
  for (let step = 1; step <= steps; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    const at = [from[0] + ((to[0] - from[0]) * step) / steps, from[1] + ((to[1] - from[1]) * step) / steps];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(at) });
  }
  if (release) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('the phone agent panel drops the repeated Profile title but keeps its close control and tabs', async (t) => {
  const page = await launch(t, { phone: true });
  const agent = await page.evaluate(() => header());
  if (process.env.PHONE_AGENT_PANEL_SHOT) await page.screenshot({ path: process.env.PHONE_AGENT_PANEL_SHOT });
  assert.equal(agent.title, null, 'no repeated title');
  assert.equal(agent.label, 'Profile');
  assert.deepEqual(agent.tabs, ['Profile', 'Routines'], "the panel's own tabs stay");
  assert.ok(agent.closeBox && agent.closeBox.right <= agent.rowBox.right + 0.5, 'the close control is in the row');
  assert.ok(agent.rowBox.right - agent.closeBox.right < 24, 'the close control stays at the right edge');
  await page.evaluate(() => setSheet(true, 'source-control'));
  const other = await page.evaluate(() => header());
  assert.equal(other.title, 'Source Control', 'other views keep their title row');
  assert.equal(agent.rowBox.height, other.rowBox.height, 'same row height as another dock header');
  assert.equal(agent.rowBox.top, other.rowBox.top);
  assert.ok(Math.abs(agent.closeBox.right - other.closeBox.right) <= 0.5, 'close control at the same right edge');
  await page.evaluate(() => setSheet(true));
  await page.click('.pane-side-dock-chrome button[aria-label="Close panel"]');
  assert.equal(await page.evaluate(() => closeCalls), 1, 'the control still closes the panel');
});

test('the desktop keeps the Profile title over the agent panel', async (t) => {
  const page = await launch(t, { phone: false });
  const agent = await page.evaluate(() => header());
  assert.equal(agent.title, 'Profile');
  assert.ok(agent.closeBox);
  assert.deepEqual(agent.tabs, ['Profile', 'Routines']);
});

test('the opposite swipe follows the finger and closes the phone agent panel', async (t) => {
  const page = await launch(t, { phone: true });
  const cdp = await page.createCDPSession();
  const tabs = await page.evaluate(() => centerOf('.agent-panel-tabs'));
  await touch(cdp, tabs, [tabs[0] + 220, tabs[1]], 6, 15, { release: false });
  const mid = await page.evaluate(() => state());
  assert.ok(mid.left > 50 && mid.left < 300, `the sheet follows the finger (left ${mid.left})`);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.evaluate(() => settle());
  assert.equal((await page.evaluate(() => state())).open, 'false', 'released past the fling speed: closed');
});

test('the swipe closes the panel from its tabs and from its routine list', async (t) => {
  const page = await launch(t, { phone: true });
  const cdp = await page.createCDPSession();
  const tabs = await page.evaluate(() => centerOf('.agent-panel-tabs'));
  await touch(cdp, tabs, [tabs[0] + 300, tabs[1]], 6, 15);
  await page.evaluate(() => settle());
  assert.equal((await page.evaluate(() => state())).open, 'false', 'started over the tabs');

  await page.evaluate(() => setSheet(true));
  await page.evaluate(() => settle());
  await page.evaluate(() => openRoutinesTab());
  assert.ok(await page.evaluate(() => waitFor('.routines-pane .conn-list')), 'the routine list rendered');
  const row = await page.evaluate(() => centerOf('.routines-pane .conn-list > *'));
  await touch(cdp, row, [row[0] + 300, row[1]], 6, 15);
  await page.evaluate(() => settle());
  assert.equal((await page.evaluate(() => state())).open, 'false', 'started over the routine list');
});

test('a swipe that starts in a profile input stays the input\'s and does not close', async (t) => {
  const page = await launch(t, { phone: true });
  const cdp = await page.createCDPSession();
  const input = await page.evaluate(() => centerOf('input[name="agent-name"]'));
  await touch(cdp, input, [input[0] + 300, input[1]], 6, 15);
  await page.evaluate(() => settle());
  const after = await page.evaluate(() => state());
  assert.deepEqual([after.open, after.left], ['true', 0]);
});

test('a slow drag past half the width closes, a short or aborted one snaps back open', async (t) => {
  const page = await launch(t, { phone: true });
  const cdp = await page.createCDPSession();
  const tabs = await page.evaluate(() => centerOf('.agent-panel-tabs'));
  await touch(cdp, tabs, [tabs[0] + 60, tabs[1]], 4, 100);
  await page.evaluate(() => settle());
  const short = await page.evaluate(() => state());
  assert.deepEqual([short.open, short.left, short.inline], ['true', 0, '']);
  await touch(cdp, tabs, [tabs[0] + 200, tabs[1]], 4, 100, { release: false });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await page.evaluate(() => settle());
  const aborted = await page.evaluate(() => state());
  assert.deepEqual([aborted.open, aborted.left], ['true', 0]);
  await touch(cdp, [tabs[0], tabs[1]], [tabs[0] + 340, tabs[1]], 4, 100);
  await page.evaluate(() => settle());
  assert.equal((await page.evaluate(() => state())).open, 'false', 'a slow drag past half closes');
});

test('a vertical drag inside the panel scrolls it and never closes it', async (t) => {
  const page = await launch(t, { phone: true });
  const cdp = await page.createCDPSession();
  await page.evaluate(() => openRoutinesTab());
  await page.evaluate(() => waitFor('.routines-pane .conn-list'));
  const row = await page.evaluate(() => centerOf('.routines-pane .conn-list > *'));
  await touch(cdp, row, [row[0] + 15, row[1] - 300], 8, 15);
  await page.evaluate(() => settle());
  const after = await page.evaluate(() => state());
  assert.deepEqual([after.open, after.left], ['true', 0]);
});
