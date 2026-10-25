// Shared harness for tests that mount the real PaneConversation: a jsdom
// laid out the way a 412x915 phone lays the pane out (viewport 800px tall,
// every virtual row 500px) with animation frames driven by the test.
import React from 'react';
import { installTestDom } from './test-dom.mjs';

export const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

export const laneSnapshot = (sessionId) => ({
  sessionId,
  snapshot: {
    sessionId,
    items: [
      { kind: 'user', id: 'u', text: `question ${sessionId}` },
      { kind: 'assistant', id: 'r', text: `answer ${sessionId}` },
    ],
  },
});

// The observer and the bounding rect keep opposite precedence for an element
// carrying both classes, as the harness always had them.
function observedHeight(target) {
  if (target.classList.contains('transcript')) return 800;
  if (target.classList.contains('transcript-virtual-row')) return 500;
  return 0;
}

function rectHeight(target) {
  if (target.classList.contains('transcript-virtual-row')) return 500;
  if (target.classList.contains('transcript')) return 800;
  return 0;
}

class PaneResizeObserver {
  constructor(callback) {
    this.callback = callback;
  }
  observe(target) {
    const height = observedHeight(target);
    const size = { inlineSize: 412, blockSize: height };
    this.callback(
      [{ target, contentRect: { width: 412, height }, borderBoxSize: [size], contentBoxSize: [size] }],
      this
    );
  }
  unobserve() {}
  disconnect() {}
}

export async function installPhonePaneDom(t, { mobile = true } = {}) {
  const { dom, root } = installTestDom(t, {
    html: mobile
      ? '<!doctype html><html data-mixdog-mobile-tabs><body><main id="root"></main></body></html>'
      : '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'MutationObserver'],
    globals: { ResizeObserver: PaneResizeObserver },
    rootId: 'root',
  });
  if (mobile) Object.defineProperty(dom.window.navigator, 'userAgent', { configurable: true, get: () => PHONE_UA });
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
    const height = rectHeight(this);
    return { x: 0, y: 0, top: 0, left: 0, right: 412, bottom: height, width: 412, height, toJSON() {} };
  };
  const { PaneConversation } = await import('../app-snapshot-views.tsx');
  const { defaultSessionLaneStore } = await import('../session-lane-store.ts');
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
  const element = (sessionId, strict = false) => {
    const pane = React.createElement(PaneConversation, props(sessionId));
    return strict ? React.createElement(React.StrictMode, null, pane) : pane;
  };
  return { dom, root, props, element, PaneConversation, defaultSessionLaneStore, frames, origins, sampling };
}
