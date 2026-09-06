import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { SHELL_RELOAD_IDLE_MS, shellReloadDelay, useShellUpdateReload } from "./use-shell-update-reload";
import { installShellUpdateState, SHELL_UPDATE_MESSAGE } from "./shell-update-state";

const idle = {
  pending: true,
  busy: false,
  hidden: false,
  editing: false,
  idleFor: SHELL_RELOAD_IDLE_MS,
};

test("no pending deploy schedules nothing", () => {
  assert.equal(shellReloadDelay({ ...idle, pending: false }), null);
});

test("an app left alone adopts the deploy", () => {
  assert.equal(shellReloadDelay(idle), 0);
});

test("an app that is off screen adopts it without waiting for a pause", () => {
  assert.equal(shellReloadDelay({ ...idle, hidden: true, idleFor: 0 }), 0);
});

test("a running turn and unsent text both hold the reload back", () => {
  assert.equal(shellReloadDelay({ ...idle, busy: true }), null);
  assert.equal(shellReloadDelay({ ...idle, editing: true }), null);
  // Not even an app that is off screen may discard those.
  assert.equal(shellReloadDelay({ ...idle, hidden: true, busy: true }), null);
  assert.equal(shellReloadDelay({ ...idle, hidden: true, editing: true }), null);
});

test("an app in use re-decides after the remaining pause", () => {
  assert.equal(shellReloadDelay({ ...idle, idleFor: 500 }), SHELL_RELOAD_IDLE_MS - 500);
});

test("a release received before React mounts is retained and waits for work to finish", async () => {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { url: "https://relay.test/" });
  const saved = new Map();
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const worker = new dom.window.EventTarget();
  let queries = 0;
  worker.controller = { postMessage: () => { queries += 1; } };
  Object.defineProperty(navigator, "serviceWorker", { value: worker });
  let reloads = 0;
  const root = createRoot(document.querySelector("main"));
  function Probe({ busy }) {
    useShellUpdateReload({ busy, reload: () => { reloads += 1; } });
    return null;
  }
  try {
    installShellUpdateState();
    worker.dispatchEvent(new dom.window.MessageEvent("message", {
      data: { type: SHELL_UPDATE_MESSAGE, version: "new" },
    }));
    await act(async () => root.render(React.createElement(Probe, { busy: true })));
    assert.equal(reloads, 0);
    assert.ok(queries > 0);
    await act(async () => root.render(React.createElement(Probe, { busy: false })));
    assert.equal(reloads, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
