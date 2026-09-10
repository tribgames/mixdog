import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useDockVisibilityMenu } from "./dock-icon-visibility.tsx";
import { WorkbenchSideIconBar } from "./workbench-side-view-layout.tsx";
import { PaneDockToggles } from "./pane-dock-toggles.tsx";

test("dock check menus hide and restore icons, share panes, and survive remounts without changing selections", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  const globals = ["window", "document", "navigator", "Element", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) Object.defineProperty(globalThis, key, {
    configurable: true, writable: true,
    value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[key],
  });
  let root = createRoot(document.getElementById("root"));
  const actions = [];
  const Icon = () => React.createElement("span");
  const entries = [{ id: "projects", label: "Projects" }, { id: "search", label: "Search" }];
  const descriptors = new Map([
    ...entries,
    { id: "terminal", label: "Terminal" },
    { id: "browser", label: "Browser" },
  ].map((entry) => [entry.id, { ...entry, icon: Icon }]));
  const groups = [["projects"], ["search"]];
  function LeftRail() {
    const { menuProps, menu } = useDockVisibilityMenu(entries, "Activity Bar");
    return React.createElement("aside", { ...menuProps, id: "rail" },
      React.createElement(WorkbenchSideIconBar, {
        side: "left", groups, descriptors, activeRoot: "projects", orientation: "vertical",
        onSelect: (id) => actions.push(id), onMoveGroup() {}, onMoveView() {},
      }), menu);
  }
  function App() {
    return React.createElement(React.Fragment, null,
      React.createElement(LeftRail),
      ...[0, 1].map((key) => React.createElement(PaneDockToggles, {
        key, groups: [["terminal"], ["browser"]], descriptors,
        activeRoot: "terminal", sessionBound: true,
        onSelect: (id) => actions.push(id), onClose: () => actions.push("close"),
      })));
  }
  const open = async (element, keyboard = false) => {
    await act(async () => element.dispatchEvent(keyboard
      ? new window.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })
      : new window.MouseEvent("contextmenu", { button: 2, clientX: 100, clientY: 100, bubbles: true, cancelable: true })));
  };
  const item = (id) => document.querySelector(`[role="menuitemcheckbox"][data-action-id="${id}"]`);
  const click = async (element) => {
    assert.ok(element);
    await act(async () => element.click());
  };
  const rail = () => document.getElementById("rail");
  const dock = () => document.querySelector(".pane-dock-toggles");
  try {
    // Corrupt preferences must not hide any shipped icons.
    window.localStorage.setItem("mixdog.desktop.hidden-dock-icons.v1", "{broken");
    await act(async () => root.render(React.createElement(App)));
    assert.equal(rail().querySelectorAll("button").length, 2);
    await open(rail().querySelector("button"));
    assert.equal(item("projects").getAttribute("aria-checked"), "true");
    assert.equal(document.activeElement, item("projects"));
    await act(async () => item("projects").dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    assert.equal(document.activeElement, item("search"));
    await click(item("projects"));
    assert.equal(rail().querySelectorAll("button").length, 1);
    assert.equal(document.querySelector('[role="menu"]'), null);
    await open(rail(), true);
    assert.equal(item("projects").getAttribute("aria-checked"), "false");
    await click(item("search"));
    assert.equal(rail().querySelectorAll("button").length, 0);
    // The container remains a recovery target even with every icon hidden.
    await open(rail());
    await click(item("projects"));
    assert.equal(rail().querySelector("button").getAttribute("aria-current"), "page");
    assert.deepEqual(groups, [["projects"], ["search"]]);

    await open(dock());
    await click(item("terminal"));
    assert.equal(document.querySelectorAll('.pane-dock-toggle[aria-pressed="true"]').length, 0);
    assert.equal(document.querySelectorAll(".pane-dock-toggle").length, 2);
    await open(dock());
    await click(item("browser"));
    assert.equal(document.querySelectorAll(".pane-dock-toggle").length, 0);
    assert.equal(document.querySelectorAll(".pane-dock-toggles").length, 2);
    assert.deepEqual(actions, []);

    await act(async () => root.unmount());
    root = createRoot(document.getElementById("root"));
    await act(async () => root.render(React.createElement(App)));
    assert.equal(rail().querySelectorAll("button").length, 1);
    assert.equal(document.querySelectorAll(".pane-dock-toggle").length, 0);
    await open(dock(), true);
    assert.equal(item("terminal").getAttribute("aria-checked"), "false");
    await click(item("terminal"));
    assert.equal(document.querySelectorAll('.pane-dock-toggle[aria-pressed="true"]').length, 2);
    await open(dock());
    await act(async () => document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.querySelector('[role="menu"]'), null);
    await open(dock());
    await act(async () => document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
    assert.equal(document.querySelector('[role="menu"]'), null);
    // Cross-window preference changes also update every mounted consumer.
    window.localStorage.removeItem("mixdog.desktop.hidden-dock-icons.v1");
    await act(async () => window.dispatchEvent(new window.StorageEvent("storage", { key: "mixdog.desktop.hidden-dock-icons.v1" })));
    assert.equal(rail().querySelectorAll("button").length, 2);
    assert.equal(document.querySelectorAll(".pane-dock-toggle").length, 4);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
