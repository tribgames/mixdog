import assert from "node:assert/strict";
import test from "node:test";

import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://mixdog.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);

const model = {
  provider: "openai",
  model: "gpt-fast-handoff-test",
  display: "Fast handoff test",
  effortOptions: [{ value: "high", label: "High" }],
  fastCapable: true,
  fastEfforts: ["high"],
  fastPreferred: false,
  modelParameterOptions: [],
  parameterVariants: [],
  defaultModelParameters: {},
  savedModelParameters: {},
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function option(label) {
  return [...document.querySelectorAll('[role="menuitemradio"]')]
    .find((button) => button.textContent.includes(label));
}

const requests = [];
window.mixdogDesktop = {
  rendererDiagnostic() {},
  listProviderModels: async () => [model],
  invokeCapability: async ({ capability }) => {
    assert.equal(capability, "getProviderSetup");
    return {
      value: { api: [{ id: "openai", authenticated: true }] },
      snapshot: null,
    };
  },
  setFast(enabled) {
    const request = deferred();
    requests.push({ enabled, request });
    return request.promise;
  },
};

const { ModelSelector } = await import("./model-controls.tsx");

test("fast mode stays optimistic until the authoritative snapshot paints", async () => {
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  let applyAuthoritativeFast;
  let pendingSnapshot = null;

  function Harness() {
    const [fast, setFast] = useState(false);
    applyAuthoritativeFast = () => setFast(pendingSnapshot.fast);
    return React.createElement(ModelSelector, {
      provider: model.provider,
      model: model.model,
      effort: "high",
      fast,
      fastCapable: true,
      modelParameters: {},
      contextPercent: 100,
      modelDisabled: false,
      tuningDisabled: false,
      sessionId: "session-fast-handoff",
      invokeResult: async (action) => {
        try {
          return await action();
        } catch {
          return undefined;
        }
      },
      applySnapshot: (snapshot) => {
        pendingSnapshot = snapshot;
      },
      onOpenSettings() {},
      onRoutePreferenceApplied() {},
    });
  }

  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => document.querySelector(".model-trigger").click());
    const speedRow = [...document.querySelectorAll(".route-sheet-row")]
      .find((button) => button.textContent.includes("Speed"));
    assert.ok(speedRow);
    await act(async () => speedRow.click());

    await act(async () => option("Fast").click());
    assert.equal(requests[0].enabled, true);
    assert.equal(option("Fast").getAttribute("aria-checked"), "true");

    await act(async () => requests[0].request.resolve({
      provider: model.provider,
      model: model.model,
      effort: "high",
      fast: true,
    }));
    assert.equal(option("Fast").getAttribute("aria-checked"), "true",
      "IPC completion must not expose the stale false prop before snapshot paint");

    await act(async () => applyAuthoritativeFast());
    assert.equal(option("Fast").getAttribute("aria-checked"), "true");

    await act(async () => option("Standard").click());
    assert.equal(requests[1].enabled, false);
    assert.equal(option("Standard").getAttribute("aria-checked"), "true");

    await act(async () => requests[1].request.reject(new Error("setFast failed")));
    assert.equal(option("Fast").getAttribute("aria-checked"), "true",
      "a failed request must roll back to the authoritative value");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
