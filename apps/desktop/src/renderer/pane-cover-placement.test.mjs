import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

// The real PaneConversation, Conversation, transcript and composer dock on a
// phone. Only the stored-session read and the host callbacks are stubbed;
// animation frames and lane delivery are driven by the test.
async function phone(t, { strict = false } = {}) {
  const { dom, root } = installTestDom(t, {
    html: '<!doctype html><html data-mixdog-mobile-tabs><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'MutationObserver'],
    globals: {
      ResizeObserver: class {
        constructor(callback) {
          this.callback = callback;
        }
        observe(target) {
          const height = target.classList.contains('transcript')
            ? 800
            : target.classList.contains('transcript-virtual-row')
              ? 500
              : 0;
          const size = { inlineSize: 412, blockSize: height };
          this.callback(
            [{ target, contentRect: { width: 412, height }, borderBoxSize: [size], contentBoxSize: [size] }],
            this
          );
        }
        unobserve() {}
        disconnect() {}
      },
    },
    rootId: 'root',
  });
  Object.defineProperty(dom.window.navigator, 'userAgent', { configurable: true, get: () => PHONE_UA });
  const noop = () => {};
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const frames = new Map();
  const origins = new Map();
  const sampling = new Map();
  let nextFrame = 1;
  dom.window.requestAnimationFrame = (callback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    const stack = new Error().stack;
    origins.set(id, stack.includes('app-snapshot-views.tsx'));
    sampling.set(id, stack.includes('use-transcript-reveal.ts'));
    return id;
  };
  dom.window.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  // Code that calls the bare globals shares the same controlled frames.
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame;
  // Layout the way a 412x915 phone lays the pane out: the viewport is 800px
  // tall and every virtual row is 500px.
  const proto = dom.window.HTMLElement.prototype;
  const space = (element) => element.querySelector?.('.transcript-virtual-space');
  dom.window.ResizeObserver = globalThis.ResizeObserver;
  for (const [name, wide] of [
    ['offsetHeight', 800],
    ['offsetWidth', 412],
  ]) {
    Object.defineProperty(proto, name, {
      configurable: true,
      get() {
        return this.classList.contains('transcript') ? wide : 0;
      },
    });
  }
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get() {
      return this.classList.contains('transcript') ? 800 : 0;
    },
  });
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get() {
      return this.classList.contains('transcript') ? Number.parseFloat(space(this)?.style.height) || 0 : 0;
    },
  });
  proto.getBoundingClientRect = function getBoundingClientRect() {
    const height = this.classList.contains('transcript-virtual-row')
      ? 500
      : this.classList.contains('transcript')
        ? 800
        : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: 412, bottom: height, width: 412, height, toJSON() {} };
  };
  const { PaneConversation } = await import('./app-snapshot-views.tsx');
  const { defaultSessionLaneStore } = await import('./session-lane-store.ts');
  const { rememberTranscriptVirtualMeasurements } = await import('./transcript-virtual-cache.ts');
  defaultSessionLaneStore.clear();
  t.after(() => defaultSessionLaneStore.clear());
  const props = (sessionId) => ({
    focused: true,
    hidden: false,
    sessionId,
    invokeResult: async (action) => action(),
    errors: [],
    submit: async () => undefined,
    applySnapshot: noop,
    transitioning: false,
    composerFocusRequest: 0,
    onNewTask: noop,
    onClearProject: noop,
    onResumeSession: noop,
    onOpenSessions: noop,
    onOpenProjects: noop,
    onOpenSettings: noop,
    projects: [],
    showProjectSelector: false,
    activeProjectPath: '',
    activeProjectLabel: '',
    onSelectProject: noop,
    onOpenCommandSurface: noop,
    reconcileOnMount: false,
  });
  const element = (sessionId) => {
    const pane = React.createElement(PaneConversation, props(sessionId));
    return strict ? React.createElement(React.StrictMode, null, pane) : pane;
  };
  const doc = dom.window.document;
  const api = {
    dom,
    root,
    frames,
    // Queued frames requested by the pane itself (the list handoff).
    // Queued reveal sample frames: they read the list, so none may wait on an unmounted one.
    revealFrames: () => [...frames.keys()].filter((id) => sampling.get(id)).length,
    paneFrames: () => [...frames.keys()].filter((id) => origins.get(id)).length,
    show: (sessionId) => act(async () => root.render(element(sessionId))),
    // One animation frame: every callback queued before it, in order.
    frame: () =>
      act(async () => {
        const due = [...frames.values()];
        frames.clear();
        for (const callback of due) callback(0);
      }),
    deliver: (sessionId) =>
      act(async () => {
        defaultSessionLaneStore.apply({
          sessionId,
          snapshot: {
            sessionId,
            items: [
              { kind: 'user', id: 'u', text: `question ${sessionId}` },
              { kind: 'assistant', id: 'r', text: `answer ${sessionId}` },
            ],
          },
        });
      }),
    remember: rememberTranscriptVirtualMeasurements,
    // Frames until the loading cover is gone (the reveal bound runs on a clock the test advances).
    uncover: async (clock = 500) => {
      const now = performance.now.bind(performance);
      let skew = 0;
      performance.now = () => now() + skew;
      try {
        for (let step = 0; step < 40 && doc.querySelector('.pane-surface-cover'); step++) {
          skew += clock;
          await api.frame();
          await act(async () => new Promise((resolve) => dom.window.setTimeout(resolve, 5)));
        }
      } finally {
        performance.now = now;
      }
    },
    clearLanes: () => defaultSessionLaneStore.clear(),
    state: () => {
      const shell = doc.querySelector('.transcript-shell');
      const composer = doc.querySelector('.composer');
      const list = doc.querySelector('.transcript-virtual-space');
      const covers = doc.querySelectorAll('.pane-surface-cover');
      // The cover never uncovers a transcript with no list mounted.
      if (!list) assert.equal(covers.length, 1, 'an unmounted list is always behind the cover');
      assert.equal(doc.querySelectorAll('.composer').length, 1, 'exactly one real composer');
      assert.equal(doc.querySelector('.transcript-skeleton-composer'), null, 'no fake composer bar');
      return { shell, composer, list, covers };
    },
  };
  return api;
}

test('the loading cover sits in the transcript shell, beside a real composer that survives a session switch', async (t) => {
  const p = await phone(t);
  await p.show('a');
  const entry = p.state();
  assert.ok(entry.shell, 'the transcript shell mounts');
  assert.ok(entry.composer, 'the real composer is mounted while the session loads');
  assert.equal(entry.covers.length, 1, 'the loading cover is up');
  assert.ok(entry.shell.contains(entry.covers[0]), 'the cover is inside the transcript shell');
  assert.equal(entry.shell.contains(entry.composer), false, 'the composer is outside the shell');
  assert.equal(entry.composer.closest('.conversation'), entry.shell.closest('.conversation'), 'sibling regions');

  await p.show('b');
  const next = p.state();
  assert.equal(next.composer, entry.composer, 'the composer keeps its DOM node across the session switch');
  assert.ok(entry.composer.isConnected);
  assert.ok(next.shell.contains(next.covers[0]), 'the switch cover is in the transcript shell too');
  assert.equal(next.shell.contains(next.composer), false);
  await act(async () => p.root.render(null));
});

test('a cold entry mounts the composer and cover in the tap commit and the list one frame later', async (t) => {
  const p = await phone(t);
  await p.show('a');
  const tap = p.state();
  assert.ok(tap.composer, 'the real composer is in the tap commit');
  assert.equal(tap.list, null, 'no transcript list in the tap commit');
  // The lane lands before the frame: the list still waits for it.
  await p.deliver('a');
  assert.equal(p.state().list, null, 'a lane arriving before the frame does not mount the list early');
  await p.frame();
  const next = p.state();
  assert.ok(next.list, 'the next frame mounts the list');
  assert.equal(next.composer, tap.composer, 'the composer is the same node');
  for (const cover of next.covers) assert.ok(next.shell.contains(cover), 'any cover left is in the shell');
});

test('a lane arriving after the frame mounts the list as it lands', async (t) => {
  const p = await phone(t);
  await p.show('a');
  await p.frame();
  p.state();
  await p.deliver('a');
  assert.ok(p.state().list, 'the list mounts with the lane');
});

test('a warm lane mounts its list in the tap commit, with no extra frame', async (t) => {
  const p = await phone(t);
  await p.deliver('a');
  await p.show('a');
  assert.ok(p.state().list);
});

test('rapid A to B to A switches follow the incoming session and never open a stale gate', async (t) => {
  const p = await phone(t);
  await p.show('a');
  const composer = p.state().composer;
  await p.show('b');
  await p.show('a');
  assert.equal(p.state().list, null, 'A re-enters cold, so its list is held again');
  await p.deliver('a');
  assert.equal(p.state().list, null, 'its lane landing mid-switch does not open the gate early');
  await p.frame();
  const settled = p.state();
  assert.ok(settled.list, 'the frame opens the gate for A');
  assert.equal(settled.composer, composer, 'one composer node through the whole sequence');
  // B is cold and A is warm: A -> B holds the list, B -> A (warm) does not.
  await p.show('b');
  assert.equal(p.state().covers.length, 1, 'cold B is covered while A stays painted');
  await p.show('a');
  assert.ok(p.state().list, 'warm A mounts at once');
});

test('unmounting cancels the pending frame', async (t) => {
  const p = await phone(t);
  await p.show('a');
  assert.equal(p.paneFrames(), 1, 'the handoff frame is queued');
  await act(async () => p.root.render(null));
  assert.equal(p.paneFrames(), 0, 'the pane cancelled its handoff frame');
  await p.frame();
});

test('StrictMode keeps one composer and still hands the list over a frame later', async (t) => {
  const p = await phone(t, { strict: true });
  await p.show('a');
  assert.equal(p.state().list, null);
  await p.deliver('a');
  await p.frame();
  assert.ok(p.state().list);
});

test('data arriving while the list is held still uncovers once the list has mounted', async (t) => {
  const p = await phone(t);
  await p.show('a');
  await p.deliver('a');
  assert.equal(p.revealFrames(), 0, 'the reveal does not sample a list that is not mounted');
  // The sample frame the reveal would take runs before the deferred mount.
  await p.frame();
  assert.ok(p.state().list, 'the deferred list is mounted');
  // No clock help: the reveal must start by itself once the list exists.
  for (let step = 0; step < 6; step++) await p.frame();
  const log = p.dom.window.document.querySelector('.transcript');
  assert.equal(log.style.visibility, '', 'the transcript is revealed without waiting out the bound');
  await p.uncover();
  const done = p.state();
  assert.equal(done.covers.length, 0, 'the cover leaves');
  assert.ok(done.list, 'over a mounted list');
});

test('a lane landing after the frame also uncovers', async (t) => {
  const p = await phone(t);
  await p.show('a');
  await p.frame();
  await p.deliver('a');
  await p.uncover();
  assert.equal(p.state().covers.length, 0);
});
test('the deferred mount lands where an immediate one does: the remembered end of a followed session', async (t) => {
  const p = await phone(t);
  const log = () => p.dom.window.document.querySelector('.transcript');
  await p.deliver('w');
  await p.show('w');
  await p.uncover();
  const settled = log().scrollTop;
  assert.ok(settled > 0, 'an immediate mount rests at the end of its rows');
  assert.equal(settled, log().scrollHeight - log().clientHeight);
  await act(async () => p.root.render(null));

  p.clearLanes();
  await p.show('w');
  await p.deliver('w');
  assert.equal(p.state().list, null);
  await p.frame();
  await p.uncover();
  assert.equal(log().scrollTop, settled, 'the deferred mount restores the same end position');
  assert.equal(p.state().covers.length, 0);
});
