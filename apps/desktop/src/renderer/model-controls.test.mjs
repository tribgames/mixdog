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
globalThis.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.HTMLElement.prototype.attachEvent = () => {};
globalThis.HTMLElement.prototype.detachEvent = () => {};
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
  effortOptions: [{ value: "high", label: "High" }, { value: "low", label: "Low" }],
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
let availableModels = [model];
let providerSetup = { api: [{ id: "openai", authenticated: true }] };
window.mixdogDesktop = {
  rendererDiagnostic() {},
  listProviderModels: async () => availableModels,
  invokeCapability: async ({ capability }) => {
    assert.equal(capability, "getProviderSetup");
    return {
      value: providerSetup,
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
const { invalidateSharedModelCatalogRequest } = await import("./model-catalog-cache.ts");

test.beforeEach(() => {
  requests.length = 0;
  availableModels = [model];
  providerSetup = { api: [{ id: "openai", authenticated: true }] };
  window.localStorage.clear();
  invalidateSharedModelCatalogRequest();
});

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

test("an installed Local Provider model appears without remounting the picker", async () => {
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  const localModel = {
    provider: "mixdog-local",
    model: "qwen3.8-27b-q4-k-m",
    display: "Qwen3.8 27B Q4_K_M",
    effortOptions: [],
    fastCapable: false,
    modelParameterOptions: [],
    parameterVariants: [],
    defaultModelParameters: {},
    savedModelParameters: {},
  };

  try {
    await act(async () => root.render(React.createElement(ModelSelector, {
      provider: model.provider,
      model: model.model,
      effort: "high",
      fast: false,
      fastCapable: true,
      modelParameters: {},
      contextPercent: 100,
      modelDisabled: false,
      tuningDisabled: false,
      sessionId: "session-local-provider-refresh",
      invokeResult: async (action) => await action(),
      applySnapshot() {},
      onOpenSettings() {},
      onRoutePreferenceApplied() {},
    })));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    availableModels = [model, localModel];
    providerSetup = {
      api: [{ id: "openai", authenticated: true }],
      local: [{ id: "mixdog-local", detected: true, enabled: true }],
    };
    await act(async () => {
      invalidateSharedModelCatalogRequest();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => document.querySelector(".model-trigger").click());
    const modelRow = [...document.querySelectorAll(".route-sheet-row")]
      .find((button) => button.textContent.includes("Model"));
    assert.ok(modelRow);
    await act(async () => modelRow.click());
    const localOption = [...document.querySelectorAll('[role="option"]')]
      .find((button) => button.textContent.includes("Qwen3.8 27B"));
    assert.ok(localOption);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

for (const field of ["model", "effort"]) {
  test(`${field} selection survives busy snapshots and delayed acknowledgement, but rolls back on failure`, async () => {
    const secondModel = { ...model, model: "gpt-second-handoff-test", display: "Second handoff test" };
    availableModels = [model, secondModel];
    const host = document.createElement("main");
    document.body.append(host);
    const root = createRoot(host);
    const oldInvoke = window.mixdogDesktop.invokeCapability;
    const oldSetRoute = window.mixdogDesktop.setModelRoute;
    let request;
    let requestedSelection;
    let pendingSnapshot;
    let paint;
    const initial = {
      provider: model.provider, model: model.model, effort: "high", fast: false,
      modelParameters: {}, contextPercent: 100,
    };
    window.mixdogDesktop.setModelRoute = (selection) => {
      requestedSelection = selection;
      request = deferred();
      return request.promise;
    };
    window.mixdogDesktop.invokeCapability = (input) => {
      if (input.capability !== "setEffort") return oldInvoke(input);
      requestedSelection = { effort: input.args[0] };
      request = deferred();
      return request.promise;
    };
    function Harness() {
      const [snapshot, setSnapshot] = useState(initial);
      paint = setSnapshot;
      return React.createElement(ModelSelector, {
        ...snapshot, fastCapable: true,
        sessionId: "session-busy-selection", modelDisabled: false, tuningDisabled: false,
        invokeResult: async (action) => {
          try { return await action(); } catch { return undefined; }
        },
        applySnapshot: (next) => { pendingSnapshot = next; },
        onOpenSettings() {}, onRoutePreferenceApplied() {},
      });
    }
    const openModelPane = async () => {
      if (document.querySelector(".model-trigger").getAttribute("aria-expanded") !== "true") {
        await act(async () => document.querySelector(".model-trigger").click());
      }
      const row = [...document.querySelectorAll(".route-sheet-row")]
        .find((button) => button.textContent.includes("Model"));
      await act(async () => row.click());
    };
    const choose = async (next) => {
      if (field === "model") {
        await openModelPane();
        const label = next ? secondModel.display : model.display;
        const entry = [...document.querySelectorAll('[role="option"]')]
          .find((button) => button.textContent.includes(label));
        assert.ok(entry);
        await act(async () => entry.click());
      } else {
        await act(async () => option(next ? "Low" : "High").click());
      }
    };
    const assertChosen = () => {
      if (field === "model") {
        assert.ok(document.querySelector(".model-trigger").textContent.includes(secondModel.display));
      } else {
        assert.equal(option("Low").getAttribute("aria-checked"), "true");
      }
    };
    try {
      await act(async () => root.render(React.createElement(Harness)));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      if (field === "effort") {
        await act(async () => document.querySelector(".model-trigger").click());
        const row = [...document.querySelectorAll(".route-sheet-row")]
          .find((button) => button.textContent.includes("Reasoning effort"));
        await act(async () => row.click());
      }
      await choose(true);
      assertChosen();
      await act(async () => paint({ ...initial, busy: true }));
      assertChosen();
      const resolved = { ...initial, ...requestedSelection };
      await act(async () => request.resolve(field === "effort"
        ? { value: "low", snapshot: resolved }
        : resolved));
      assertChosen();
      await act(async () => paint({ ...initial, busy: true, spinner: { text: "working" } }));
      assertChosen();
      await act(async () => paint(pendingSnapshot));
      assertChosen();
      await choose(false);
      await act(async () => request.reject(new Error("route update failed")));
      assertChosen();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      window.mixdogDesktop.invokeCapability = oldInvoke;
      window.mixdogDesktop.setModelRoute = oldSetRoute;
    }
  });
}
