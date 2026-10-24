// Shared jsdom installer for renderer tests: saves the globals it touches,
// installs a JSDOM window, and restores everything (and closes the window) via
// t.after (unmounting `root` first) — or via the returned sync `restore()` when
// no test context is given.
import { createRequire } from 'node:module';
import { act } from 'react';
import { JSDOM } from 'jsdom';

// react-dom decides at load time whether a DOM exists (input-event polyfill,
// canUseDOM), so it must never load before a test installs its window: the
// helper requires it lazily, only when a root is requested.
const require = createRequire(import.meta.url);

const BASE_GLOBALS = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];

/**
 * @param {import('node:test').TestContext | null} t  registers restore via t.after when given
 * @param {object} [options]
 * @param {string} [options.html]            document markup
 * @param {object} [options.jsdom]           extra JSDOM options (url defaults to https://mixdog.test/)
 * @param {string[]} [options.expose]        window properties also installed as globals (HTMLElement, Node, ...)
 * @param {Record<string, unknown>} [options.globals]  arbitrary extra globals (e.g. navigator override)
 * @param {boolean} [options.actEnvironment] set IS_REACT_ACT_ENVIRONMENT (default true)
 * @param {string|false} [options.rootId]    when set, createRoot on that element and unmount on restore ('root' default with default html)
 */
export function installTestDom(t, options = {}) {
  const {
    html = '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom = {},
    expose = [],
    globals = {},
    actEnvironment = true,
    rootId = false,
  } = options;
  const dom = new JSDOM(html, { url: 'https://mixdog.test/', ...jsdom });
  const { window } = dom;
  // jsdom has no Web Animations: an element runs no animations (the
  // decorative loops lock their phase through getAnimations on mount).
  window.Element.prototype.getAnimations = () => [];
  const installed = {
    window,
    document: window.document,
    // Node has no animation frames and jsdom only has them when pretending to
    // be visible; renderer code that waits for "the next frame" (the markdown
    // parse allowance) needs one that fires.
    requestAnimationFrame: (callback) => setTimeout(() => callback(performance.now()), 16),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    ...Object.fromEntries(expose.map((key) => [key, window[key]])),
    ...globals,
  };
  if (actEnvironment) installed.IS_REACT_ACT_ENVIRONMENT = true;
  const keys = [...new Set([...BASE_GLOBALS, ...Object.keys(installed)])];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(installed)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = rootId ? require('react-dom/client').createRoot(window.document.getElementById(rootId)) : null;
  const restore = () => {
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
  if (t) {
    t.after(async () => {
      if (root) await act(async () => root.unmount());
      restore();
    });
  }
  return { dom, window, document: window.document, root, restore };
}
