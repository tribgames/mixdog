import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React, { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

test("a split-pane conversation portal fills its slot so the composer stays at the bottom", async () => {
  const css = await readFile(new URL("./pane-layout.css", import.meta.url), "utf8");
  const dom = new JSDOM(`
    <style>${css}</style>
    <div class="pane-conversation-slot">
      <div class="persistent-pane-surface conversation-persistent-surface">
        <div class="workspace"></div>
      </div>
    </div>
  `);
  const host = dom.window.document.querySelector(".conversation-persistent-surface");
  const workspace = dom.window.document.querySelector(".workspace");

  assert.ok(host);
  assert.ok(workspace);
  const rules = [...dom.window.document.styleSheets[0].cssRules];
  const ruleFor = (selector) => rules.find((rule) => rule.selectorText === selector);
  const hostRule = ruleFor(".pane-conversation-slot > .conversation-persistent-surface");
  assert.ok(hostRule);
  assert.equal(hostRule.style.position, "absolute");
  assert.equal(hostRule.style.inset, "0");
  assert.equal(hostRule.style.display, "flex");
  assert.equal(hostRule.style.flexDirection, "column");

  const workspaceRule = ruleFor(
    ".pane-conversation-slot > .conversation-persistent-surface > .workspace",
  );
  assert.ok(workspaceRule);
  assert.equal(workspaceRule.style.width, "100%");
  assert.equal(workspaceRule.style.height, "100%");
  assert.equal(workspaceRule.style.flex, "1 1 0%");
});

test("a persistent pane portal mounts layout-sensitive children after its target appears", async () => {
  const dom = new JSDOM("<!doctype html><html><body><main id=\"root\"></main></body></html>", {
    url: "https://mixdog.test/",
  });
  const globals = ["window", "document", "navigator", "Element", "HTMLElement",
    "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(globals.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.defineProperty(globalThis, "Element", {
    configurable: true,
    value: dom.window.Element,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: dom.window.HTMLElement,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });

  const measurements = [];
  const { PersistentPanePortal } = await import("./PaneSurfaceGate.tsx");
  function LayoutProbe() {
    useLayoutEffect(() => {
      const probe = document.getElementById("layout-probe");
      measurements.push({
        connected: probe.isConnected,
        targetId: probe.parentElement?.parentElement?.id,
      });
    }, []);
    return React.createElement("div", { id: "layout-probe" });
  }
  function Harness() {
    return React.createElement(PersistentPanePortal, {
      targetId: "pane-target",
      className: "conversation-persistent-surface",
    }, React.createElement(LayoutProbe));
  }

  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.deepEqual(measurements, []);
    await act(async () => {
      const target = document.createElement("div");
      target.id = "pane-target";
      document.getElementById("root").append(target);
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });
    assert.deepEqual(measurements, [{ connected: true, targetId: "pane-target" }]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
