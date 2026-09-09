import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { SurfaceActiveContext, useSurfaceNavigationReset } from "./surface-activity.ts";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) return { url: "data:text/javascript,", shortCircuit: true };
    return next(specifier, context);
  },
});

async function mount(t) {
  const dom = new JSDOM("<!doctype html><body><main></main></body>", {
    url: "https://mixdog.test/", pretendToBeVisual: true,
  });
  const saved = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    Event: dom.window.Event, CustomEvent: dom.window.CustomEvent,
    ResizeObserver: class { observe() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.attachEvent = () => {};
  window.HTMLElement.prototype.detachEvent = () => {};
  window.mixdogDesktop = {
    rendererDiagnostic() {}, setTitleBarDimmed() {},
    invokeCapability: async () => ({ value: {} }),
    github: async () => ({ ok: true, data: [] }),
  };
  const host = document.querySelector("main");
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    host,
    render: (element) => act(async () => root.render(element)),
    click: (element) => act(async () => element.click()),
    change: (element, value) => act(async () => {
      element.value = value;
      element.dispatchEvent(new window.Event("change", { bubbles: true }));
    }),
  };
}

test("closing one retained side tab resets only its navigation, not drafts or cold deep links", async (t) => {
  const ui = await mount(t);
  function Pane({ id, active }) {
    const [menu, setMenu] = useState("detail");
    const [draft, setDraft] = useState("unsaved text");
    useSurfaceNavigationReset(active, () => setMenu("home"));
    return React.createElement("section", { "data-pane": id },
      React.createElement("output", null, menu),
      React.createElement("textarea", { value: draft, onChange: (event) => setDraft(event.target.value) }));
  }
  const view = (first, second) => React.createElement(React.Fragment, null,
    React.createElement(Pane, { id: "first", active: first }),
    React.createElement(Pane, { id: "second", active: second }));
  await ui.render(view(false, true));
  assert.equal(ui.host.querySelector('[data-pane="first"] output').textContent, "detail");
  await ui.render(view(true, true));
  await ui.render(view(false, true));
  await ui.render(view(true, true));
  assert.equal(ui.host.querySelector('[data-pane="first"] output').textContent, "home");
  assert.equal(ui.host.querySelector('[data-pane="second"] output').textContent, "detail");
  for (const field of ui.host.querySelectorAll("textarea")) assert.equal(field.value, "unsaved text");
});

for (const kind of ["projects", "extensions"]) {
  test(`${kind} reopens at its own first menu without resetting another mounted tab`, async (t) => {
    const ui = await mount(t);
    const Component = kind === "projects"
      ? (await import("./ProjectsView.tsx")).ProjectsPane
      : (await import("./ExtensionsView.tsx")).ExtensionsPane;
    const initial = kind === "projects" ? "projects" : "plugins";
    const detail = kind === "projects" ? "Workflow" : "Skill";
    const home = kind === "projects" ? "Project" : "Plugin";
    function Panel({ active, id }) {
      const [section, onSectionChange] = useState(initial);
      return React.createElement("section", { "data-pane": id },
        React.createElement(Component, {
          active, section, onSectionChange,
          projects: [], selectedProjectPath: "", onChooseFolder: async () => null,
          onCreateProject: async () => {}, onRename() {}, onRemove() {},
        }));
    }
    const view = (active) => React.createElement(React.Fragment, null,
      React.createElement(Panel, { active, id: "first" }),
      React.createElement(Panel, { active: true, id: "second" }));
    const menu = (id, label) => [...ui.host.querySelectorAll(`[data-pane="${id}"] .sidebar-section-toolbar button`)]
      .find((button) => button.textContent === label);
    await ui.render(view(true));
    await ui.click(menu("first", detail));
    await ui.click(menu("second", detail));
    await ui.render(view(false));
    await ui.render(view(true));
    assert.equal(menu("first", home).getAttribute("aria-pressed"), "true");
    assert.equal(menu("second", detail).getAttribute("aria-pressed"), "true");
  });
}

test("Source Control returns to Changes while retaining the commit message", async (t) => {
  const ui = await mount(t);
  const { SourceControlDock } = await import("./SourceControlDock.tsx");
  const props = {
    projectPath: "C:/project",
    status: { repository: true, branch: "main", files: [], operation: "" },
    statusReady: true, statusError: "", loading: false,
    readinessKey: "navigation", onReadyChange() {}, onRefreshStatus() {},
  };
  const view = (active) => React.createElement(SourceControlDock, { ...props, active });
  await ui.render(view(true));
  const input = ui.host.querySelector(".dock-scm-commit-summary");
  assert.ok(input);
  await act(async () => {
    input.value = "Keep this unfinished commit";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await ui.click(ui.host.querySelector('[data-review-option="history"]'));
  await ui.render(view(false));
  await ui.render(view(true));
  assert.equal(ui.host.querySelector('[data-review-option="changes"]').getAttribute("aria-checked"), "true");
  assert.equal(ui.host.querySelector(".dock-scm-commit-summary").value, "Keep this unfinished commit");
});

for (const repositoryUrl of ["", "https://github.com/example/project"]) {
  test(`GitHub reopens its own default menu with repository=${Boolean(repositoryUrl)}`, async (t) => {
    const ui = await mount(t);
    const { GithubDock } = await import("./github/GithubDock.tsx");
    const view = (active) => React.createElement(SurfaceActiveContext.Provider, { value: active },
      React.createElement(GithubDock, {
        projectPath: "", repositoryUrl, prUrl: "", currentBranch: "", createHint: "",
      }));
    await ui.render(view(true));
    await ui.change(ui.host.querySelector('[aria-label="GitHub view"]'), "notifications");
    await ui.render(view(false));
    await ui.render(view(true));
    assert.equal(ui.host.querySelector('[aria-label="GitHub view"]').value,
      repositoryUrl ? "pulls" : "repositories");
  });
}
