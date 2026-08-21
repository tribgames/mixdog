import assert from "node:assert/strict";
import test from "node:test";

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><main></main></body></html>", {
  url: "https://mixdog.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const {
  clearRemoteConnectionState,
  currentRemoteConnectionState,
  setRemoteConnectionState,
  shouldRunRemoteHeartbeat,
  subscribeRemoteConnectionState,
} = await import("./remote-connection-state.ts");
const { RemoteConnectionBanner } = await import("./RemoteConnectionBanner.tsx");

test("the mobile heartbeat runs only while the page is foregrounded", () => {
  assert.equal(shouldRunRemoteHeartbeat("visible"), true);
  assert.equal(shouldRunRemoteHeartbeat("hidden"), false);
  assert.equal(shouldRunRemoteHeartbeat("prerender"), false);
});

test("remote connection state publishes every lifecycle transition", () => {
  const states = [];
  const unsubscribe = subscribeRemoteConnectionState(() => {
    states.push(currentRemoteConnectionState());
  });
  try {
    setRemoteConnectionState("connecting");
    setRemoteConnectionState("connected");
    setRemoteConnectionState("reconnecting");
    clearRemoteConnectionState();
  } finally {
    unsubscribe();
  }
  assert.deepEqual(states, ["connecting", "connected", "reconnecting", null]);
});

test("only a reconnect past the threshold blocks the surface, and it says nothing", async () => {
  clearRemoteConnectionState();
  const mount = document.querySelector("main");
  const root = createRoot(mount);
  // The threshold timer is the whole contract here, so it is driven by hand
  // instead of waiting out ten real seconds.
  const TIMER_ID = 987654;
  const realSetTimeout = window.setTimeout;
  const realClearTimeout = window.clearTimeout;
  let pendingDisconnect = null;
  window.setTimeout = (fn, ms) => {
    if (ms === 10_000) {
      pendingDisconnect = fn;
      return TIMER_ID;
    }
    return realSetTimeout(fn, ms);
  };
  window.clearTimeout = (id) => {
    if (id === TIMER_ID) {
      pendingDisconnect = null;
      return;
    }
    realClearTimeout(id);
  };
  try {
    await act(async () => {
      root.render(React.createElement(RemoteConnectionBanner));
    });
    assert.equal(document.querySelector(".remote-connection-overlay"), null);

    // A short gap — every background return costs one — stays invisible.
    await act(async () => {
      setRemoteConnectionState("reconnecting");
    });
    assert.equal(document.querySelector(".remote-connection-overlay"), null);
    assert.ok(pendingDisconnect);

    // Recovering inside the window cancels the countdown instead of banking it.
    await act(async () => {
      setRemoteConnectionState("connected");
    });
    assert.equal(pendingDisconnect, null);
    assert.equal(document.querySelector(".remote-connection-overlay"), null);

    await act(async () => {
      setRemoteConnectionState("reconnecting");
    });
    await act(async () => {
      pendingDisconnect?.();
    });
    const overlay = document.querySelector(".remote-connection-overlay");
    assert.ok(overlay);
    assert.equal(overlay.textContent, "");

    await act(async () => {
      setRemoteConnectionState("connected");
    });
    assert.equal(document.querySelector(".remote-connection-overlay"), null);
  } finally {
    window.setTimeout = realSetTimeout;
    window.clearTimeout = realClearTimeout;
    await act(async () => root.unmount());
    clearRemoteConnectionState();
  }
});
