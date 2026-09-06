import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useSessionDiffRefresh } from "./use-session-diff-refresh.ts";
import { createRendererClock } from "../../scripts/test-renderer-clock.mjs";

function Probe(props) {
  const state = useSessionDiffRefresh(props);
  props.onRender?.(state);
  return React.createElement("output", null, `${state.loading}|${state.result?.patch || ""}|${state.error}`);
}

function harness(t, invokeCapability) {
  const dom = new JSDOM("<!doctype html><main></main>", {
    url: "https://mixdog.test/", pretendToBeVisual: true,
  });
  const clock = createRendererClock();
  const saved = new Map(["window", "document", "IS_REACT_ACT_ENVIRONMENT"]
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let visibility = "visible";
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, get: () => visibility });
  dom.window.setInterval = clock.win.setInterval;
  dom.window.clearInterval = clock.win.clearInterval;
  dom.window.mixdogDesktop = { invokeCapability };
  const root = createRoot(dom.window.document.querySelector("main"));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const base = { sessionId: "session", active: true, busy: true, revision: "first" };
  return {
    clock,
    render: (props = {}) => act(async () => root.render(React.createElement(Probe, { ...base, ...props }))),
    empty: () => act(async () => root.render(null)),
    text: () => dom.window.document.querySelector("main").textContent,
    visibility: (value) => act(async () => {
      visibility = value;
      dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    }),
    advance: (ms) => act(async () => clock.advance(ms)),
    settle: (work) => act(async () => { work(); await clock.settle(); }),
  };
}

test("session diffs do no hidden polling or revision-triggered reads and refresh on return", async (t) => {
  let calls = 0;
  const view = harness(t, async () => {
    calls += 1;
    return { value: { supported: true, files: [], patch: `patch-${calls}` } };
  });
  await view.visibility("hidden");
  await view.render();
  await view.advance(20_000);
  assert.equal(calls, 0);
  assert.equal(view.clock.timers.size, 0);
  await view.visibility("visible");
  assert.equal(calls, 1);
  assert.match(view.text(), /patch-1/);
  await view.advance(4_000);
  assert.equal(calls, 2);
  await view.visibility("hidden");
  await view.render({ revision: "second" });
  await view.advance(20_000);
  assert.equal(calls, 2);
  await view.visibility("visible");
  assert.equal(calls, 3);
  await view.render({ active: false });
  await view.advance(20_000);
  assert.equal(calls, 3);
  assert.equal(view.clock.timers.size, 0);
});

test("late responses cannot update a closed diff pane and a reopened pane still refreshes", async (t) => {
  let resolve;
  let calls = 0;
  const gate = new Promise((done) => { resolve = done; });
  const view = harness(t, () => {
    calls += 1;
    return calls === 1 ? gate : Promise.resolve({
      value: { supported: true, files: [], patch: "fresh" },
    });
  });
  await view.render();
  await view.render({ active: false });
  const closed = view.text();
  await view.settle(() => resolve({ value: { supported: true, files: [], patch: "late" } }));
  assert.equal(view.text(), closed);
  await view.render();
  assert.equal(calls, 2);
  assert.match(view.text(), /fresh/);
});

test("repeated diff pane mounts leave no timer that can launch another backend read", async (t) => {
  let calls = 0;
  const view = harness(t, async () => {
    calls += 1;
    return { value: { supported: true, files: [], patch: "diff" } };
  });
  for (let index = 0; index < 200; index += 1) {
    await view.render();
    await view.empty();
    assert.equal(view.clock.timers.size, 0);
  }
  const settledCalls = calls;
  await view.advance(60_000);
  await view.visibility("hidden");
  await view.visibility("visible");
  assert.equal(calls, settledCalls);
});

test("a new session never presents the previous session's diff or an unconfirmed empty result", async (t) => {
  const requests = [];
  const view = harness(t, () => {
    const request = Promise.withResolvers();
    requests.push(request);
    return request.promise;
  });
  await view.render({ sessionId: "first-initial-diff" });
  await view.settle(() => requests[0].resolve({
    value: { supported: true, files: [], patch: "previous-session" },
  }));
  const frames = [];
  await view.render({
    sessionId: "second-initial-diff",
    onRender: ({ result, loading, error }) => frames.push({ result, loading, error }),
  });
  assert.ok(frames.length);
  for (const frame of frames) {
    assert.equal(frame.result, null);
    assert.equal(frame.loading, true);
    assert.equal(frame.error, "");
  }
  await view.settle(() => requests[1].resolve({
    value: { supported: true, files: [], patch: "next-session" },
  }));
  assert.match(view.text(), /next-session/);
});
