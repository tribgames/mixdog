// Contract tests for the DOM harness lifecycle. These cover the failure modes
// that let renderer.dom.test.mjs retain JSDOM windows across tests: a silent
// re-install, a cleanup that races a later install, global bindings that
// survive teardown, and a layout frame queued against a closed window.
//
// The harness imports .tsx/.ts renderer modules, so this file only runs under
// the tsx loader. Exact wired command (package.json "test:renderer", second
// leg):
//   node --import ./scripts/test-env.mjs --import tsx \
//     --test --test-concurrency=1 src/renderer/renderer-dom-test-harness.test.mjs
// Running it without `--import tsx` fails on the first .tsx import; that is a
// command error, not a harness failure.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { inspect } from "node:util";

import { nextEditorLayoutDimension } from "./editor-layout.ts";
import {
  cleanupDom,
  dom,
  installDom,
  root,
} from "./renderer-dom-test-harness.mjs";

afterEach(cleanupDom);

test("editor layout ignores duplicate host sizes and always returns explicit dimensions", () => {
  const host = { clientWidth: 631, clientHeight: 921 };
  const first = nextEditorLayoutDimension(null, host);
  assert.deepEqual(first, { width: 631, height: 921 });
  assert.equal(nextEditorLayoutDimension(first, host), null,
    "Monaco writes must not re-enter layout while its host dimensions are unchanged");

  host.clientWidth = 640;
  assert.deepEqual(nextEditorLayoutDimension(first, host), { width: 640, height: 921 });
  assert.equal(nextEditorLayoutDimension(null, { clientWidth: 0, clientHeight: 921 }), null,
    "hidden editor hosts must not receive a zero-width layout");
});

test("editor tabs leave both scrollbar axes exclusively to Monaco", async () => {
  const css = await readFile(new URL("./desktop.css", import.meta.url), "utf8");
  assert.match(css,
    /\.editor-tab-pane\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(css,
    /\.editor-tab-pane\s*>\s*\.pane-surface-gate\s*>\s*\.pane-surface-gate-content\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(css,
    /\.editor-pane-body\s*>\s*section,[^{]*\.editor-pane-body\s*>\s*section\s*>\s*div\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s);
});

// jsdom does not implement `window.closed`; a closed window drops its document
// instead, which is exactly the retention we care about.
const isOpen = (window) => Boolean(window.document);

test("installDom refuses to overwrite a live or retiring DOM", async () => {
  installDom();
  const live = dom.window;
  assert.throws(() => installDom(), /still installed/);
  assert.equal(dom.window, live, "the live DOM must survive a rejected install");

  const pending = cleanupDom();
  assert.throws(() => installDom(), /still running/);
  assert.equal(dom?.window, live, "the retiring DOM stays published until teardown completes");
  await pending;
  assert.equal(dom, undefined);
  assert.equal(root, undefined);
  assert.equal(isOpen(live), false, "the retired window must be closed");

  installDom();
  assert.notEqual(dom, undefined, "installing after an awaited cleanup succeeds");
  assert.notEqual(dom.window, live, "the new DOM is independent of the retired one");
  assert.notEqual(root, undefined, "a fresh React root is created for the new DOM");
});

test("duplicate cleanups share one teardown and cannot clobber a later install", async () => {
  installDom();
  const first = cleanupDom();
  const second = cleanupDom();
  assert.equal(first, second, "concurrent callers must observe the same promise");
  await Promise.all([first, second]);
  assert.equal(dom, undefined);

  installDom();
  const live = dom.window;
  // A stale handle awaited after a later install must not retire the new DOM.
  await first;
  await first;
  assert.equal(dom.window, live, "the later install must still be published");
  assert.equal(isOpen(live), true);
  assert.equal(globalThis.window, live);
  assert.equal(globalThis.document, live.document);
});

test("cleanup restores the globals it owns and leaves foreign bindings alone", async () => {
  const originalEvent = globalThis.Event;
  assert.equal(typeof originalEvent, "function", "node provides a baseline Event global");
  installDom();
  assert.equal(typeof globalThis.window, "object");
  assert.notEqual(globalThis.Event, originalEvent, "install publishes the window's constructor");

  // Written after publish: these belong to the test, not to the harness.
  class TestResizeObserver {
    observe() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver;
  const externalDocument = { external: true };
  globalThis.document = externalDocument;

  await cleanupDom();
  for (const key of ["window", "HTMLElement", "MutationObserver"]) {
    assert.equal(key in globalThis, false, `${key} must not survive cleanup`);
  }
  assert.equal(globalThis.Event, originalEvent, "a pre-existing global is restored, not deleted");
  assert.equal(globalThis.ResizeObserver, TestResizeObserver, "a test-owned binding is left to its owner");
  assert.equal(globalThis.document, externalDocument, "cleanup must not clobber a binding it no longer owns");
  delete globalThis.ResizeObserver;
  delete globalThis.document;
});

test("cleanup releases the shared layout frame queue a retired window would stall", async () => {
  const { scheduleLayoutFrame } = await import("./interaction-frame-scheduler.ts");
  installDom();
  let retiredWork = 0;
  // Scheduled against the window that is about to be closed: the frame this
  // requests can never fire.
  scheduleLayoutFrame({}, () => { retiredWork += 1; });
  await cleanupDom();

  installDom();
  let freshWork = 0;
  scheduleLayoutFrame({}, () => { freshWork += 1; });
  await new Promise((resolve) => dom.window.setTimeout(resolve, 50));
  assert.equal(freshWork, 1,
    "a new DOM must receive its own animation frame instead of queueing behind a dead one");
  assert.equal(retiredWork, 0, "work queued for the retired window must not run later");
});

test("a failed DOM comparison is summarised instead of serializing the document graph", async () => {
  installDom();
  const element = document.querySelector("#root");
  assert.match(inspect(element), /^<div id="root">$/);
  assert.equal(inspect(document), "#document");
  assert.equal(inspect(window), "[jsdom Window]");

  // The failure path is what used to allocate gigabytes: assert.equal builds a
  // diff with util.inspect before it throws.
  let error = null;
  try {
    assert.equal(element, null);
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, "the comparison must still fail");
  assert.ok(error.message.length < 1000,
    `assertion diffs must stay bounded, received ${error.message.length} characters`);
  assert.match(error.message, /<div id="root">/);
});
