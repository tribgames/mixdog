import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';

import { visualizeFeedbackScript } from '../../shared/visualize-feedback.ts';
import { requiredVisualizeCaptureRect, requiredVisualizeGestureTarget } from '../ipc-validation.ts';
import { createVisualizeGestureTokens, VISUALIZE_GESTURE_TTL_MS, visualizeGestureTarget } from './gestures.ts';
import { createDesktopVisualize } from './host.ts';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-visualize-feedback-'));
  const cwd = join(root, 'project');
  mkdirSync(join(cwd, 'site'), { recursive: true });
  writeFileSync(join(cwd, 'site', 'index.html'), '<h1>hi</h1>');
  return { cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function fakeWindow() {
  const injected = [];
  const captures = [];
  const frame = (parent) => ({
    url: '',
    parent,
    isDestroyed: () => false,
    async executeJavaScript(script) {
      injected.push({ frame: this, script });
      return true;
    },
  });
  const mainFrame = { parent: null, url: 'app://index.html', isDestroyed: () => false, framesInSubtree: [] };
  const pane = frame(mainFrame);
  const nested = frame(pane);
  mainFrame.framesInSubtree = [mainFrame, pane, nested];
  const events = [];
  // The panel renderer the hit query runs in: a pane's iframe, with the
  // panel's own confirm bar and Comment layer drawn over it.
  const renderer = new JSDOM(
    `<section class="visualize-pane"><div data-visualize-body data-visualize-session="s1" data-visualize-tab="v1">
      <div class="visualize-pane-cell" data-visualize-pane="0"><div class="visualize-pane-content">
        <iframe title="page"></iframe>
        <div class="visualize-region-layer"></div>
        <div class="visualize-choice-confirm"><button>Choose</button><button>Cancel</button></div>
      </div></div>
    </div></section><textarea class="composer"></textarea>`,
    { runScripts: 'outside-only' }
  );
  /** What `elementFromPoint` returns: set per click. */
  const hit = { element: null, points: [] };
  renderer.window.document.elementFromPoint = (x, y) => {
    hit.points.push([x, y]);
    return hit.element;
  };
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    // The window's content area on screen (DIP).
    getContentBounds: () => ({ x: 100, y: 50, width: 1200, height: 800 }),
    webContents: Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      session: { webRequest: { onBeforeRequest() {}, onCompleted() {}, onErrorOccurred() {} } },
      focusedFrame: null,
      executeJavaScript: async (script) => renderer.window.eval(script),
      send(_channel, event) {
        events.push(event);
        const url = event.state?.tabs[0]?.panes[0]?.url;
        if (url) {
          // The pane's page, and a frame the page itself embeds, share the lease.
          pane.url = url;
          nested.url = `${url}#nested`;
        }
      },
      getZoomFactor: () => 1.5,
      async capturePage(rect) {
        captures.push(rect);
        return { isEmpty: () => false, toPNG: () => Buffer.from('PNG') };
      },
      mainFrame,
    }),
  };
  return { window, mainFrame, pane, nested, injected, captures, events, renderer: renderer.window.document, hit };
}

test('the desktop runs the feedback script in the panel’s own HTML frames and crops window areas', async () => {
  const { cwd, cleanup } = workspace();
  const fake = fakeWindow();
  const service = createDesktopVisualize({
    window: () => fake.window,
    invokeDesktopOperation: async () => {
      throw new Error('unused');
    },
    browserAvailable: () => true,
  });
  try {
    await service.execute({
      sessionId: 's1',
      cwd,
      action: 'open',
      input: { targets: [join(cwd, 'site', 'index.html')] },
    });
    // Feedback names the file project-relative even when the agent passed a host path.
    const pane = fake.events.at(-1).state.tabs[0].panes[0];
    assert.equal(pane.file, 'site/index.html');
    assert.equal(service.tabView('s1', 'v1').panes[0].file, 'site/index.html');
    assert.equal(service.tabView('s1', 'nope'), null);

    await service.attachFeedback('s1', 'v1');
    assert.deepEqual(
      fake.injected.map((entry) => [entry.frame === fake.pane, entry.script]),
      [[true, visualizeFeedbackScript()]],
      'only the pane frame, never a frame nested inside the page'
    );
    // Unknown tabs inject nothing.
    await service.attachFeedback('s1', 'v9');
    assert.equal(fake.injected.length, 1);

    assert.equal(
      await service.captureRect({ x: 10, y: 20, width: 30, height: 40 }),
      Buffer.from('PNG').toString('base64')
    );
    assert.deepEqual(fake.captures, [{ x: 15, y: 30, width: 45, height: 60 }], 'CSS px scale with the zoom factor');

    // One crop at a time: a second request while one runs is refused.
    let release;
    fake.window.webContents.capturePage = () =>
      new Promise((resolve) => {
        release = () => resolve({ isEmpty: () => false, toPNG: () => Buffer.from('PNG') });
      });
    const running = service.captureRect({ x: 0, y: 0, width: 1, height: 1 });
    await assert.rejects(service.captureRect({ x: 0, y: 0, width: 1, height: 1 }), /already being captured/);
    release();
    await running;
    fake.window.webContents.capturePage = async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('PNG') });
    assert.equal(await service.captureRect({ x: 0, y: 0, width: 1, height: 1 }), Buffer.from('PNG').toString('base64'));
  } finally {
    service.dispose();
    cleanup();
  }
});

test('gesture tokens: one per real gesture, per pane, short-lived, after any pending lookup', async () => {
  let clock = 1_000;
  const tokens = createVisualizeGestureTokens(() => clock);
  const pane = { sessionId: 's1', tabId: 'v1', pane: 0 };
  assert.equal(await tokens.consume(pane), false, 'no gesture, no token');
  tokens.mint(pane);
  assert.equal(await tokens.consume({ ...pane, pane: 1 }), false, 'another pane cannot spend it');
  assert.equal(await tokens.consume({ ...pane, tabId: 'v2' }), false);
  assert.equal(await tokens.consume(pane), true);
  assert.equal(await tokens.consume(pane), false, 'one gesture, one choice');
  tokens.mint(pane);
  clock += VISUALIZE_GESTURE_TTL_MS + 1;
  assert.equal(await tokens.consume(pane), false, 'stale gestures expire');
  // A gesture still being located is waited for.
  let resolve;
  tokens.track(
    new Promise((done) => {
      resolve = done;
    }).then(() => tokens.mint(pane))
  );
  const consuming = tokens.consume(pane);
  resolve();
  assert.equal(await consuming, true);

  assert.deepEqual(visualizeGestureTarget({ sessionId: 's1', tabId: 'v1', pane: 1 }), {
    sessionId: 's1',
    tabId: 'v1',
    pane: 1,
  });
  for (const bad of [
    null,
    'x',
    { sessionId: '', tabId: 'v1', pane: 0 },
    { sessionId: 's1', tabId: 'v1', pane: Number.NaN },
  ]) {
    assert.equal(visualizeGestureTarget(bad), null);
  }
});

test('main mints choice gestures only from real input that lands in a pane', async () => {
  const { cwd, cleanup } = workspace();
  const fake = fakeWindow();
  const service = createDesktopVisualize({
    window: () => fake.window,
    invokeDesktopOperation: async () => {
      throw new Error('unused');
    },
    browserAvailable: () => true,
  });
  const contents = fake.window.webContents;
  const target = { sessionId: 's1', tabId: 'v1', pane: 0 };
  const mouse = (type, globalX, globalY) =>
    contents.emit('before-mouse-event', {}, { type, globalX, globalY, x: 0, y: 0 });
  const key = (key, extra = {}) => contents.emit('before-input-event', {}, { type: 'keyDown', key, ...extra });
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } });
    await service.attachFeedback('s1', 'v1');
    // Zoom 1.5, content at (100, 50): screen point → window CSS px.
    const screen = (x, y) => [100 + x * 1.5, 50 + y * 1.5];
    const doc = fake.renderer;
    const frameElement = doc.querySelector('iframe');

    fake.hit.element = frameElement;
    mouse('mouseUp', ...screen(250, 150));
    assert.equal(await service.consumeChoiceGesture(target), true, 'a click on the pane’s own frame');
    assert.deepEqual(fake.hit.points.at(-1), [250, 150], 'hit-tested at the click point');
    assert.equal(await service.consumeChoiceGesture(target), false, 'spent');

    // Panel UI over the frame is hit instead: the confirm bar's buttons, the
    // Comment layer, the bar itself, the composer. None is a page gesture.
    for (const element of [
      ...doc.querySelectorAll('.visualize-choice-confirm button'),
      doc.querySelector('.visualize-choice-confirm'),
      doc.querySelector('.visualize-region-layer'),
      doc.querySelector('.composer'),
      null,
    ]) {
      fake.hit.element = element;
      mouse('mouseUp', ...screen(250, 150));
      assert.equal(
        await service.consumeChoiceGesture(target),
        false,
        `no token from ${element?.className || element?.textContent || 'nothing'}`
      );
    }
    // An iframe outside a visualize pane, or one in a hidden body, mints nothing.
    const stray = doc.createElement('iframe');
    doc.body.append(stray);
    fake.hit.element = stray;
    mouse('mouseUp', ...screen(250, 150));
    assert.equal(await service.consumeChoiceGesture(target), false);
    doc.querySelector('section').setAttribute('hidden', '');
    fake.hit.element = frameElement;
    mouse('mouseUp', ...screen(250, 150));
    assert.equal(await service.consumeChoiceGesture(target), false);
    doc.querySelector('section').removeAttribute('hidden');

    // Presses, moves and positionless events mint nothing.
    mouse('mouseDown', ...screen(250, 150));
    mouse('mouseMove', ...screen(250, 150));
    mouse('mouseUp', undefined, undefined);
    assert.equal(await service.consumeChoiceGesture(target), false);
    assert.equal(await service.consumeChoiceGesture({ ...target, pane: 1 }), false);

    // Keys count only with focus inside the pane's frame (or a frame it embeds).
    key('Enter');
    contents.focusedFrame = fake.mainFrame;
    key('Enter');
    assert.equal(await service.consumeChoiceGesture(target), false, 'focus in the panel UI');
    contents.focusedFrame = fake.nested;
    key('a');
    key(' ', { isAutoRepeat: true });
    contents.emit('before-input-event', {}, { type: 'keyUp', key: 'Enter' });
    assert.equal(await service.consumeChoiceGesture(target), false);
    key(' ');
    assert.equal(await service.consumeChoiceGesture(target), true, 'Space with focus inside the pane');
    contents.focusedFrame = fake.pane;
    key('Enter');
    assert.equal(await service.consumeChoiceGesture(target), true);
    assert.equal(await service.consumeChoiceGesture(target), false);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('gesture targets from the renderer are validated', () => {
  assert.deepEqual(requiredVisualizeGestureTarget({ sessionId: 's1', tabId: 'v1', pane: 2 }), {
    sessionId: 's1',
    tabId: 'v1',
    pane: 2,
  });
  for (const bad of [
    null,
    { sessionId: 's1', tabId: 'v1', pane: -1 },
    { sessionId: 's1', tabId: 'v1', pane: 1.5 },
    { sessionId: 's1', pane: 0 },
  ]) {
    assert.throws(() => requiredVisualizeGestureTarget(bad), TypeError);
  }
});

test('capture areas from the renderer are validated', () => {
  assert.deepEqual(requiredVisualizeCaptureRect({ x: 0, y: 1.5, width: 2, height: 3 }), {
    x: 0,
    y: 1.5,
    width: 2,
    height: 3,
  });
  for (const bad of [
    null,
    { x: -1, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0, y: 0, width: 1, height: Infinity },
    { x: '1', y: 0, width: 1, height: 1 },
  ]) {
    assert.throws(() => requiredVisualizeCaptureRect(bad), TypeError);
  }
});
