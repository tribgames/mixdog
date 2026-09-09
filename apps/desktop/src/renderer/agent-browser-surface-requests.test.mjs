import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://mixdog.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { useAgentBrowserSurfaceRequests } = await import("./use-agent-browser-surface-requests.ts");
const { useSessionPaneSurfaces } = await import("./use-session-pane-surfaces.ts");
const { sessionSideDockEntryForSession } = await import("./session-side-surface-policy.ts");

test("agent hide folds only its browser, retains pages, and cancels deferred reveal", async () => {
  let receive;
  window.mixdogDesktop = {
    onBrowserOpenRequested(listener) {
      receive = listener;
      return () => { receive = null; };
    },
  };
  const createdPages = new Set();
  const selections = [];
  let prefetches = 0;
  let surfaces;
  const browserSurfaces = {
    ensure(sessionId) { createdPages.add(sessionId); },
    release() { assert.fail("visibility must not release a page"); },
  };
  const select = (leafId, surface) => selections.push([leafId, surface]);
  const prefetch = async () => { prefetches += 1; };
  const owner = (sessionId, leafId = sessionId) => ({ sessionId, leafId });
  function Harness({ owners }) {
    surfaces = useSessionPaneSurfaces();
    useAgentBrowserSurfaceRequests({
      owners,
      focusedLeafId: "alpha",
      surfaces: { ...surfaces, browserSurfaces },
      select,
      prefetch,
    });
    return null;
  }
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  const render = async (owners) => {
    await act(async () => root.render(React.createElement(Harness, { owners })));
  };
  const send = async (request) => {
    await act(async () => receive(request));
  };
  try {
    await render([owner("alpha"), owner("beta"), owner("alpha", "alpha-copy")]);
    await send({ sessionId: "missing", hide: true });
    assert.equal(prefetches, 0);
    assert.equal(createdPages.size, 0);

    await send({ sessionId: "alpha" });
    await send({ sessionId: "beta" });
    assert.deepEqual(selections, [["alpha", "browser"], ["beta", "browser"]]);
    assert.equal(surfaces.sessionSideSurfaces.get("alpha"), "browser");
    await send({ sessionId: "alpha", hide: true, reveal: true });
    assert.equal(prefetches, 2);
    assert.deepEqual([...createdPages], ["alpha", "beta"]);
    assert.equal(surfaces.sessionSideSurfaces.has("alpha"), false);
    assert.equal(surfaces.sessionSideSurfaces.get("beta"), "browser");
    const folded = sessionSideDockEntryForSession({
      open: true, view: "sourceControl", surface: "browser", diff: null,
    }, "alpha", surfaces.sessionSideSurfaces.get("alpha") ?? null);
    assert.equal(folded.open, false);
    assert.equal(folded.surface, "");

    await send({ sessionId: "alpha" });
    assert.equal(surfaces.sessionSideSurfaces.get("alpha"), "browser");
    await act(async () => surfaces.setSessionSideSurface("alpha", "terminal"));
    await send({ sessionId: "alpha", hide: true });
    assert.equal(surfaces.sessionSideSurfaces.get("alpha"), "terminal");

    // Ordered IPC messages can arrive in the same React batch.
    await act(async () => {
      receive({ sessionId: "alpha" });
      receive({ sessionId: "alpha", hide: true });
    });
    assert.equal(surfaces.sessionSideSurfaces.has("alpha"), false);

    await send({ sessionId: "parked", reveal: false });
    assert.equal(createdPages.has("parked"), true);
    assert.equal(surfaces.sessionSideSurfaces.has("parked"), false);
    await send({ sessionId: "hidden" });
    assert.equal(surfaces.pendingBrowserAutoReveal.current.has("hidden"), true);
    await send({ sessionId: "hidden", hide: true });
    assert.equal(surfaces.pendingBrowserAutoReveal.current.has("hidden"), false);
    const selectionCount = selections.length;
    await render([owner("hidden")]);
    assert.equal(selections.length, selectionCount);
    assert.equal(surfaces.sessionSideSurfaces.has("hidden"), false);
    await send({ sessionId: "hidden" });
    assert.deepEqual(selections.at(-1), ["hidden", "browser"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("runtime unload keeps the remembered browser dock while deletion forgets it", async () => {
  let receiveRelease;
  window.mixdogDesktop = {
    onBrowserSessionReleased(listener) {
      receiveRelease = listener;
      return () => { receiveRelease = null; };
    },
  };
  let surfaces;
  function Harness() {
    surfaces = useSessionPaneSurfaces();
    return null;
  }
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => surfaces.setSessionSideSurface("alpha", "browser"));
    await act(async () => receiveRelease("alpha", "unloaded"));
    assert.equal(surfaces.sessionSideSurfaces.get("alpha"), "browser");
    await act(async () => receiveRelease("alpha", "gone"));
    assert.equal(surfaces.sessionSideSurfaces.has("alpha"), false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
