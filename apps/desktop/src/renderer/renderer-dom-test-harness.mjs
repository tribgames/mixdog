import { register } from "node:module";
import { inspect } from "node:util";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { installBoundedAssertions } from "../../scripts/bounded-assert.mjs";
import { sharedTranscriptSnapshotDecorator } from "./snapshot-transcript-decoration";

// Installed by importing the harness, so every DOM suite is covered by the same
// import it already needs — no preload ordering to get wrong. node:assert would
// otherwise render a failed comparison against a DOM node by walking the whole
// document/window/React-fiber graph, synchronously, before throwing.
installBoundedAssertions();

register(new URL("./settings/test-css-loader.mjs", import.meta.url));
const { invalidateWorkflowOptionsCache } = await import("./model-controls.tsx");
// Process-wide singleton: it keeps one animation-frame handle for the whole
// renderer. A frame requested against a window that is then closed never fires,
// so the handle stays set and every later schedule() only queues work that is
// never flushed — the retained-job growth behind the multi-gigabyte runs.
// Teardown resets it, exactly like a page unload would.
const { layoutFrameCoordinator } = await import("./interaction-frame-scheduler.ts");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export let dom;
export let root;

// Every global the harness publishes for a test window. Cleanup restores the
// previous descriptor (usually: removes the key) so a finished test cannot
// retain its JSDOM window, document, or constructor prototypes through
// globalThis and keep the whole React tree alive for the rest of the file.
const DOM_GLOBAL_KEYS = [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "Event",
  "InputEvent",
  "KeyboardEvent",
  "MouseEvent",
  "Blob",
  "File",
  "FileReader",
  "MutationObserver",
  "ResizeObserver",
];

// Ownership record for the currently published globals:
//   saved     — descriptor that existed before publish (undefined = absent)
//   published — descriptor the harness itself installed
let globalOwnership = null;
// Single in-flight teardown shared by every concurrent/duplicate caller.
let cleanupInFlight = null;

const describeGlobal = (key) => Object.getOwnPropertyDescriptor(globalThis, key);

// node:assert renders a failed comparison with util.inspect. A JSDOM node is a
// gateway into its whole document, its window and every React fiber attached to
// it, so inspecting one element serializes hundreds of megabytes to gigabytes —
// synchronously, inside the failing assertion. Assertion *semantics* are
// untouched; only the diff text is summarised.
function summariseNode(node) {
  try {
    if (node.nodeType === 1) {
      const attributes = Array.from(node.attributes ?? []).slice(0, 4)
        .map((attribute) => ` ${attribute.name}="${String(attribute.value).slice(0, 60)}"`)
        .join("");
      const more = (node.attributes?.length ?? 0) > 4 ? " …" : "";
      return `<${node.tagName.toLowerCase()}${attributes}${more}>`;
    }
    if (node.nodeType === 3) return `#text ${JSON.stringify(String(node.data).slice(0, 80))}`;
    if (node.nodeType === 9) return "#document";
    if (node.nodeType === 11) return "#document-fragment";
    return `#node(${node.nodeName})`;
  } catch {
    return "#node";
  }
}

function installInspectSummaries(window) {
  Object.defineProperty(window.Node.prototype, inspect.custom, {
    value() { return summariseNode(this); },
    configurable: true,
  });
  Object.defineProperty(window, inspect.custom, {
    value() { return "[jsdom Window]"; },
    configurable: true,
  });
}

function sameDescriptor(a, b) {
  if (!a || !b) return a === b;
  if ("value" in a || "value" in b) {
    return Object.is(a.value, b.value)
      && a.writable === b.writable
      && a.enumerable === b.enumerable
      && a.configurable === b.configurable;
  }
  return a.get === b.get
    && a.set === b.set
    && a.enumerable === b.enumerable
    && a.configurable === b.configurable;
}

function publishGlobals(window) {
  const saved = new Map();
  for (const key of DOM_GLOBAL_KEYS) saved.set(key, describeGlobal(key));
  for (const key of DOM_GLOBAL_KEYS) {
    globalThis[key] = key === "window" ? window : window[key];
  }
  const published = new Map();
  for (const key of DOM_GLOBAL_KEYS) published.set(key, describeGlobal(key));
  globalOwnership = { saved, published };
}

function restoreGlobals() {
  if (!globalOwnership) return;
  const { saved, published } = globalOwnership;
  globalOwnership = null;
  for (const key of DOM_GLOBAL_KEYS) {
    // Ownership check: revert only the bindings the harness still owns. Any
    // value installed after publish (a test's fake ResizeObserver, a patched
    // constructor) belongs to whoever wrote it and is left untouched.
    if (!sameDescriptor(describeGlobal(key), published.get(key))) continue;
    const previous = saved.get(key);
    if (previous) Object.defineProperty(globalThis, key, previous);
    else delete globalThis[key];
  }
}

export function installDom({ windowShown = true, sidebarOpen = true } = {}) {
  if (cleanupInFlight) {
    // The previous DOM is still unmounting; installing now would race the
    // teardown for the same globals.
    throw new Error(
      "installDom() called while cleanupDom() is still running; await cleanupDom() before installing another DOM.",
    );
  }
  if (dom || root) {
    // Silently replacing a live DOM orphans its window (timers keep running,
    // the React root is never unmounted) which is exactly how this suite grew
    // to multi-gigabyte RSS. Fail loudly instead.
    throw new Error(
      "installDom() called while a DOM is still installed; await cleanupDom() (register `afterEach(cleanupDom)` before the first test) before installing another DOM.",
    );
  }
  invalidateWorkflowOptionsCache();
  // The shared transcript decorator is process-wide by design (one identity
  // baseline per session across snapshot sources); between DOM suites that
  // persistence would be cross-test pollution, so every fresh DOM starts clean.
  sharedTranscriptSnapshotDecorator.clear();
  dom = new JSDOM(
    '<!doctype html><html><body><button id="before">Before</button><div class="app-shell"><div id="root"></div></div></body></html>',
    { url: "http://localhost" },
  );
  publishGlobals(dom.window);
  installInspectSummaries(dom.window);
  dom.window.__mixdogWindowShown = windowShown;
  try {
    dom.window.localStorage.setItem(
      "mixdog.desktop-sidebar-open.v1",
      String(sidebarOpen),
    );
  } catch {}
  try {
    dom.window.localStorage.setItem("mixdog.desktop.pane-layout.v1", JSON.stringify({
      layout: { type: "leaf", id: "boot_pane", tabs: [{ kind: "new" }], activeKey: "new:default" },
      focusedLeafId: "boot_pane",
    }));
  } catch {}
  for (const method of ["scrollTo", "scrollIntoView"]) {
    Object.defineProperty(dom.window.HTMLElement.prototype, method, {
      value() {},
      configurable: true,
    });
  }
  Object.defineProperties(dom.window, {
    requestAnimationFrame: {
      value(callback) { return dom.window.setTimeout(() => callback(dom.window.performance.now()), 0); },
      configurable: true,
    },
    cancelAnimationFrame: {
      value(handle) { dom.window.clearTimeout(handle); },
      configurable: true,
    },
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { value() {}, configurable: true },
    detachEvent: { value() {}, configurable: true },
  });
  // jsdom implements no layout, so every element reports a 0x0 box. The
  // transcript is virtualized: a viewport without a measurable height resolves
  // no window of rows at all. Give it the 800px height the renderer assumes as
  // its initial rect and leave every width at 0 (a faked offsetWidth would
  // read as an 800px scrollbar gutter). Suites that need their own geometry
  // keep overriding offsetHeight on the element or on this prototype.
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    get() { return this.classList?.contains("transcript") ? 800 : 0; },
    configurable: true,
  });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
    value() {
      return {
        font: "",
        measureText(text) {
          return { width: String(text).length * 7 };
        },
      };
    },
    configurable: true,
  });
  const background = document.querySelector(".app-shell");
  Object.defineProperty(background, "inert", { value: false, writable: true, configurable: true });
  root = createRoot(document.getElementById("root"));
  return background;
}

export function cleanupDom() {
  // Duplicate and concurrent callers observe the same teardown; a second call
  // never starts a second unmount and never reaches a later install.
  if (cleanupInFlight) return cleanupInFlight;
  if (!dom && !root) return Promise.resolve();
  const retiringDom = dom;
  const retiringRoot = root;
  const teardown = (async () => {
    if (retiringRoot) {
      try {
        await act(async () => retiringRoot.unmount());
      } catch {}
    }
    try {
      // Runs while the retiring window is still published so the pending frame
      // is cancelled on the window that scheduled it.
      layoutFrameCoordinator.cancelAll();
    } catch {}
    restoreGlobals();
    try {
      invalidateWorkflowOptionsCache();
    } catch {}
    try {
      // Closes the window, clears its timers/observers and detaches the
      // document so nothing schedules work into a retired tree.
      retiringDom?.window.close();
    } catch {}
    // `dom`/`root` stay published for the whole teardown: installDom() is
    // blocked until this promise settles, so the bindings released here are
    // always the ones this call retired.
    if (dom === retiringDom) dom = undefined;
    if (root === retiringRoot) root = undefined;
  })();
  const settled = teardown.finally(() => {
    if (cleanupInFlight === settled) cleanupInFlight = null;
  });
  cleanupInFlight = settled;
  return settled;
}
