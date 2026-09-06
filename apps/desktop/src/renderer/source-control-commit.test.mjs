import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) return { url: "data:text/javascript,", shortCircuit: true };
    return next(specifier, context);
  },
});

const projectPath = "C:/project";
const status = {
  repository: true, branch: "main", detached: false, unborn: false,
  upstream: false, upstreamName: "", remote: false, ahead: 0, behind: 0,
  operation: "",
  files: [{
    path: "selected.txt", index: " ", worktree: "M", untracked: false,
    conflicted: false, stagedAdditions: 0, stagedDeletions: 0,
    unstagedAdditions: 1, unstagedDeletions: 0, additions: 1, deletions: 0,
  }],
};

async function mount(t, commit) {
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
  const legacyCalls = [];
  window.mixdogDesktop = {
    rendererDiagnostic() {},
    gitStatus: async () => status,
    gitCommitPaths: commit,
    // An older host must not re-enable the removed behavior.
    readGitPreferences: async () => {
      legacyCalls.push("preferences");
      return { autoCommitMessage: true, commitPreset: "conventional" };
    },
    gitGenerateCommitMessage: async () => {
      legacyCalls.push("generation");
      return { message: "Generated message" };
    },
  };
  const { SourceControlDock } = await import("./SourceControlDock.tsx");
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
  await act(async () => root.render(React.createElement(SourceControlDock, {
    projectPath, status, statusReady: true, statusError: "", loading: false,
    active: true, readinessKey: "manual-commit", onReadyChange() {}, onRefreshStatus() {},
  })));
  const summary = host.querySelector(".dock-scm-commit-summary");
  const description = host.querySelector(".dock-scm-commit-description");
  const button = host.querySelector("button[type=submit]");
  assert.ok(summary && description && button);
  return {
    host, summary, description, button, legacyCalls,
    input: (element, value) => act(async () => {
      element.value = value;
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
    }),
    submit: () => act(async () => {
      summary.form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    }),
    accelerator: (element, key) => act(async () => {
      element.focus();
      element.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "Enter", [key]: true, bubbles: true, cancelable: true,
      }));
    }),
  };
}

test("empty summaries never commit or generate a message, including with a legacy host", async (t) => {
  const commits = [];
  const view = await mount(t, async (...args) => { commits.push(args); });
  await act(async () => window.dispatchEvent(new window.CustomEvent(
    "mixdog:git-preferences-changed",
    { detail: { autoCommitMessage: true, commitPreset: "custom", commitExample: "Legacy hint" } },
  )));
  for (const summary of ["", "   "]) {
    await view.input(view.summary, summary);
    await view.input(view.description, "A description alone is not a summary.");
    assert.equal(view.button.disabled, true);
    await view.submit();
    await view.accelerator(view.summary, "ctrlKey");
    await view.accelerator(view.description, "metaKey");
  }
  assert.deepEqual(commits, []);
  assert.deepEqual(view.legacyCalls, []);
  assert.equal(view.summary.placeholder, "Summary (required)");
});

test("manual prose commits the selected files and clears the draft only after success", async (t) => {
  const commits = [];
  const pending = Promise.withResolvers();
  const view = await mount(t, async (...args) => {
    commits.push(args);
    await pending.promise;
  });
  await view.input(view.summary, "  저장 복구 개선  ");
  await view.input(view.description, "  입력한 설명을 그대로 사용합니다.  ");
  assert.equal(view.button.disabled, false);
  await act(async () => view.button.click());
  assert.deepEqual(commits, [[
    projectPath, "저장 복구 개선\n\n입력한 설명을 그대로 사용합니다.", ["selected.txt"],
  ]]);
  assert.equal(view.summary.value, "  저장 복구 개선  ");
  assert.equal(view.summary.readOnly, true);
  assert.equal(view.button.disabled, true);
  await act(async () => pending.resolve());
  assert.equal(view.summary.value, "");
  assert.equal(view.description.value, "");
  assert.deepEqual(view.legacyCalls, []);
});

test("a rejected manual commit preserves the draft and can be retried with Ctrl+Enter", async (t) => {
  let attempts = 0;
  const view = await mount(t, async () => {
    if (++attempts === 1) throw new Error("Commit rejected by hook.");
  });
  await view.input(view.summary, "Free-form summary");
  await view.input(view.description, "Keep this draft.");
  await view.submit();
  assert.equal(attempts, 1);
  assert.equal(view.summary.value, "Free-form summary");
  assert.equal(view.description.value, "Keep this draft.");
  assert.equal(view.button.disabled, false);
  assert.match(view.host.textContent, /Commit rejected by hook/);
  await view.accelerator(view.summary, "ctrlKey");
  assert.equal(attempts, 2);
  assert.equal(view.summary.value, "");
  assert.deepEqual(view.legacyCalls, []);
});
