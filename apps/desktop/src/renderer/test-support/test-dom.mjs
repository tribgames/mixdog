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
 * A `sections` source that carries only the core's `toolModules` section (the built-in features' state). A test sets
 * what the core "pushes" with `publish(value)`: before the store has loaded it is part of the app snapshot, afterwards
 * a push. Install it as `window.mixdogDesktop.sections`.
 */
export function toolModulesSource() {
  // One source may feed several stores (the window's, and one per api object a panel is given).
  const listeners = new Set();
  let revision = 0;
  const latest = new Map();
  const publishSection = (section, value) => {
    const entry = { section, key: null, revision: ++revision, value };
    latest.set(section, entry);
    for (const listener of [...listeners]) listener({ kind: 'sections', changes: [{ section, key: null, entry }] });
  };
  return {
    sections: {
      // These hosts answer capabilities themselves: no core endpoint behind the window.
      core: async () => false,
      snapshot: async () => ({ status: 'ready', entries: [...latest.values()] }),
      subscribe: (next) => (listeners.add(next), () => void listeners.delete(next)),
    },
    publish: (value) => publishSection('toolModules', value),
    /** Any other section a test needs the core to hold (`projects`, ...). */
    publishSection,
  };
}

/**
 * The agent pool and the agent catalog reach the renderer as the `agentPool` and `agents` sections
 * (desktop-services.md §15 P6, P14). A test host that still describes them as `listAgentPool` (the first read),
 * `subscribeAgentPool` (pushes) and the `listAgents` capability is served as a `sections` source carrying those as
 * the sections, so the tests keep driving them the way they always did.
 */
function withSectionsForLegacyPool(host) {
  if (!host || typeof host !== 'object' || host.sections) return host;
  const has = (name) => typeof host[name] === 'function';
  if (!has('listAgentPool') && !has('subscribeAgentPool') && !has('invokeCapability')) return host;
  let revision = 0;
  const entry = (section, value) => ({ section, key: null, revision: ++revision, value });
  const sections = {
    core: async () => false,
    async snapshot() {
      const entries = [];
      const pool = has('listAgentPool') ? await host.listAgentPool() : null;
      if (pool) entries.push(entry('agentPool', pool));
      if (has('invokeCapability')) {
        const agents = await host.invokeCapability({ capability: 'listAgents', args: [] }).catch(() => null);
        if (Array.isArray(agents?.value)) entries.push(entry('agents', agents.value));
      }
      return { status: 'ready', entries };
    },
    subscribe(listener) {
      const stop = host.subscribeAgentPool?.((rows) =>
        listener({
          kind: 'sections',
          changes: [{ section: 'agentPool', key: null, entry: entry('agentPool', rows) }],
        })
      );
      return typeof stop === 'function' ? stop : () => {};
    },
  };
  // Not enumerable: tests that list a host's methods see only the ones they wrote.
  return Object.defineProperty(host, 'sections', { value: sections, configurable: true });
}

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
  // Frames still pending at restore are cancelled: one firing after it would
  // find requestAnimationFrame gone.
  const frames = new Set();
  // jsdom has no Web Animations: an element runs no animations (the
  // decorative loops lock their phase through getAnimations on mount).
  window.Element.prototype.getAnimations = () => [];
  window.Document.prototype.getAnimations = () => [];
  let desktopHost;
  Object.defineProperty(window, 'mixdogDesktop', {
    configurable: true,
    enumerable: true,
    get: () => desktopHost,
    set: (host) => {
      desktopHost = withSectionsForLegacyPool(host);
    },
  });
  const installed = {
    window,
    document: window.document,
    // Node has no animation frames and jsdom only has them when pretending to
    // be visible; renderer code that waits for "the next frame" (the markdown
    // parse allowance) needs one that fires.
    requestAnimationFrame: (callback) => {
      const handle = setTimeout(() => {
        frames.delete(handle);
        callback(performance.now());
      }, 16);
      frames.add(handle);
      return handle;
    },
    cancelAnimationFrame: (handle) => {
      frames.delete(handle);
      clearTimeout(handle);
    },
    // jsdom has no ResizeObserver, which every browser the renderer runs in
    // has (scroll-progress binds one on every scroller). jsdom renders no
    // boxes, and an observer only reports a box that is rendered with a
    // non-zero size, so this one never delivers. A suite that drives resizes
    // installs its own, before this call or through `globals`.
    ResizeObserver:
      globalThis.ResizeObserver ??
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
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
    for (const handle of frames) clearTimeout(handle);
    frames.clear();
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
