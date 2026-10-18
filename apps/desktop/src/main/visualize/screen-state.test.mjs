// How far the user can see a displayed tab: the desktop window's state
// (visible / background / covered / hidden), what each state tells the agent
// when it opens a tab, and a paired remote device overriding the desktop's
// non-visible states. The panel renderer is a real DOM answering the real
// queries; only its layout (jsdom has none) and the overlay hit are stubbed.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { JSDOM } from 'jsdom';

import { desktopScreenState } from './host-frames.ts';
import { createDesktopVisualize } from './host.ts';
import { createVisualizeService } from './service.ts';

const TAB = { id: 'v1' };

/** A main window whose panel renderer is a jsdom document; `state` steers it. */
function fakeWindow() {
  const state = { minimized: false, shown: true, focused: true, covered: false, bodyAbsent: false, queries: [] };
  const renderer = new JSDOM(
    `<div data-visualize-body data-visualize-session="s1" data-visualize-tab="v1"><iframe></iframe></div>
     <div id="overlay"></div>`,
    { runScripts: 'outside-only' }
  );
  const { document } = renderer.window;
  const body = document.querySelector('[data-visualize-body]');
  body.getBoundingClientRect = () => ({ left: 10, top: 10, width: 400, height: 300 });
  document.elementFromPoint = () => (state.covered ? document.getElementById('overlay') : body.firstElementChild);
  const events = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => state.minimized,
    isVisible: () => state.shown,
    isFocused: () => state.focused,
    webContents: Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      session: { webRequest: { onBeforeRequest() {}, onCompleted() {}, onErrorOccurred() {} } },
      executeJavaScript: async (script) => {
        state.queries.push(script.includes('elementFromPoint') ? 'hit' : 'rect');
        // The body went away right after the rect was read (no retry wait, unlike an absent body).
        if (state.vanishes && script.includes('elementFromPoint')) return null;
        body.hidden = state.bodyAbsent;
        return renderer.window.eval(script);
      },
      send: (_channel, event) => events.push(event),
      getZoomFactor: () => 1,
      capturePage: async () => ({ isEmpty: () => true }),
      mainFrame: { parent: null, url: 'app://index.html', isDestroyed: () => false, framesInSubtree: [] },
    }),
  };
  return { window, state };
}

test('desktopScreenState tells focused from unfocused, covered, and hidden windows or tabs', async () => {
  const { window, state } = fakeWindow();
  const screen = () => desktopScreenState(window, 's1', TAB);

  assert.equal(await screen(), 'visible', 'in front with the body uncovered');
  assert.deepEqual(state.queries, ['rect', 'hit'], 'the hit-test is its own query after the rect');

  state.focused = false;
  assert.equal(await screen(), 'background', 'drawn uncovered, but another app has the focus');

  state.covered = true;
  assert.equal(await screen(), 'covered', 'an overlay is the topmost element over the body');
  state.focused = true;
  assert.equal(await screen(), 'covered', 'covered whether or not the window is focused');
  state.covered = false;

  state.minimized = true;
  assert.equal(await screen(), 'hidden', 'minimized');
  state.minimized = false;
  state.shown = false;
  assert.equal(await screen(), 'hidden', 'hidden');
  state.shown = true;
  assert.equal(await screen(), 'visible');

  // The body is not drawn at all (panel closed / session not shown): the rect query finds nothing.
  state.bodyAbsent = true;
  state.queries.length = 0;
  assert.equal(await screen(), 'hidden');
  assert.ok(!state.queries.includes('hit'), 'no hit-test for a body that is not there');

  // The body went away between the rect and the hit-test.
  state.bodyAbsent = false;
  state.vanishes = true;
  assert.equal(await screen(), 'hidden');
});

test('open names what stands between the tab and the user, per screen state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-visualize-screen-'));
  const cwd = join(root, 'project');
  mkdirSync(join(cwd, 'site'), { recursive: true });
  writeFileSync(join(cwd, 'site', 'index.html'), '<h1>hi</h1>');
  let screen = 'visible';
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => true,
    preparePane: async (target) => `fake://${target.kind}/${target.label}`,
    publish() {},
    watch: () => () => {},
    capture: async () => Buffer.from('PNG'),
    delay: async () => {},
    reloadDebounceMs: 5,
    onScreen: async () => screen,
  });
  const open = async () =>
    (await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } })).text;
  try {
    assert.match(await open(), /^Showing site\/index\.html \(html\) in the side panel as tab v1\./);
    screen = 'background';
    const background = await open();
    assert.match(
      background,
      /^Opened site\/index\.html \(html\) in the side panel as tab v1, but the Mixdog window is in the background/
    );
    assert.match(background, /another app has the focus/);
    screen = 'covered';
    const covered = await open();
    assert.match(
      covered,
      /^Opened site\/index\.html \(html\) in the side panel as tab v1, but something in the Mixdog window covers the panel/
    );
    assert.match(covered, /a dialog, Settings or another overlay/);
    screen = 'hidden';
    const hidden = await open();
    assert.match(hidden, /^Opened site\/index\.html \(html\) as tab v1, but it is not on screen/);
    assert.match(hidden, /minimized or hidden, or the session is not shown/);
    for (const text of [background, covered, hidden]) assert.doesNotMatch(text, /Showing/);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a paired remote device viewing the session makes every non-visible desktop state visible', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-visualize-screen-'));
  const cwd = join(root, 'project');
  mkdirSync(join(cwd, 'site'), { recursive: true });
  writeFileSync(join(cwd, 'site', 'index.html'), '<h1>hi</h1>');
  const { window, state } = fakeWindow();
  let remote = false;
  const service = createDesktopVisualize({
    window: () => window,
    invokeDesktopOperation: async () => {
      throw new Error('unused');
    },
    browserAvailable: () => true,
    remoteViewing: async (sessionId) => remote && sessionId === 's1',
  });
  const open = async () =>
    (await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } })).text;
  const desktopStates = {
    background: () => {
      state.focused = false;
    },
    covered: () => {
      state.covered = true;
    },
    minimized: () => {
      state.minimized = true;
    },
    hidden: () => {
      state.shown = false;
    },
    'missing body': () => {
      state.vanishes = true;
    },
  };
  const reset = () =>
    Object.assign(state, { minimized: false, shown: true, focused: true, covered: false, vanishes: false });
  try {
    assert.match(await open(), /^Showing /, 'the desktop alone, in front');
    for (const [name, apply] of Object.entries(desktopStates)) {
      reset();
      apply();
      remote = false;
      assert.doesNotMatch(await open(), /^Showing /, `${name}: the desktop alone cannot be seen`);
      remote = true;
      assert.match(await open(), /^Showing /, `${name}: the remote device sees it`);
    }
    // Another session's remote viewer does not count.
    reset();
    state.covered = true;
    remote = true;
    const other = await service.execute({
      sessionId: 's2',
      cwd,
      action: 'open',
      input: { targets: ['site/index.html'] },
    });
    assert.doesNotMatch(other.text, /^Showing /);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
