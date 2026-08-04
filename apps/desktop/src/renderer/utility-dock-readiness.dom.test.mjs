import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React, { act } from "react";

import {
  cleanupDom,
  installDom,
  root,
} from "./renderer-dom-test-harness.mjs";

const { UtilityDock } = await import("./UtilityDock.tsx");
const {
  DEFAULT_PROBLEMS_PANEL_FILTER,
  WorkbenchProblemsPane,
} = await import("./WorkbenchProblems.tsx");
const {
  clearActiveEditorDocument,
  setActiveEditorDocument,
  setActiveEditorPosition,
  setEditorOutline,
  setNativeEditorProblems,
} = await import("./editor-language-store.ts");

afterEach(cleanupDom);

test("Dock surfaces wait for data and stable layout before revealing Files or Source Control", async () => {
  installDom();
  const projectPath = "C:\\work\\ready";
  let resolveRoot;
  const resolveGit = [];
  const gitStatus = {
    repository: true,
    branch: "main",
    detached: false,
    unborn: false,
    upstream: false,
    upstreamName: "",
    remote: false,
    ahead: 0,
    behind: 0,
    operation: "",
    files: [],
  };
  window.mixdogDesktop = {
    listProjects: async () => [
      { path: projectPath, name: "ready", alias: "" },
      { path: "C:\\work\\other", name: "other", alias: "" },
    ],
    listProjectDir: async () => new Promise((resolve) => { resolveRoot = resolve; }),
    gitStatus: async () => new Promise((resolve) => { resolveGit.push(resolve); }),
  };
  const props = {
    open: true,
    width: 380,
    onTab() {},
    onResize() {},
    snapshot: { currentProject: projectPath, items: [] },
    projectPath,
  };
  await act(async () => {
    root.render(React.createElement(UtilityDock, { ...props, tab: "files" }));
    await Promise.resolve();
  });
  const dockBody = document.querySelector(".utility-dock-body");
  assert.equal(document.querySelectorAll(".utility-dock-pane").length, 1,
    "an unopened Dock surface must not allocate hidden DOM or start background reads");
  assert.equal(document.querySelector('.utility-dock-pane[data-tab="files"]')
    ?.dataset.surfaceActive, "true");
  assert.equal(document.querySelector('.utility-dock-pane[data-tab="tasks"]'), null);
  const currentCover = () => {
    const last = dockBody?.lastElementChild ?? null;
    return last?.classList.contains("pane-surface-cover") ? last : null;
  };
  const filesCover = currentCover();
  const filesStatus = filesCover?.querySelector(".desktop-loading-surface");
  assert.equal(filesStatus?.textContent?.trim(), "");
  assert.equal(filesStatus?.getAttribute("aria-label"), "Preparing Search…");
  assert.ok(filesStatus?.querySelector(".desktop-loading-spinner"));
  assert.ok(document.querySelector(".dock-files"));

  await act(async () => {
    resolveRoot([{ name: "ready.ts", dir: false }]);
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(filesCover?.isConnected);
  await act(async () => {
    for (const resolve of resolveGit.splice(0)) resolve(gitStatus);
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => new Promise((resolve) => window.requestAnimationFrame(() =>
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))));
  assert.equal(filesCover?.isConnected, false);
  assert.ok(document.querySelector('.dock-file-row[title="ready.ts"]'));

  await act(async () => {
    root.render(React.createElement(UtilityDock, { ...props, tab: "source-control" }));
    await Promise.resolve();
  });
  assert.equal(currentCover(), null,
    "a cached project snapshot must reveal Source Control in the switching paint");
  assert.ok(document.querySelector('.utility-dock-pane[data-tab="source-control"]'));
  assert.ok(document.querySelector(".dock-source-control"));
  assert.equal(dockBody?.dataset.transitioning, "false");
  assert.equal(document.querySelector(
    '.utility-dock-pane[data-surface-active="true"]',
  )?.dataset.tab, "source-control");
  assert.equal(document.querySelector(
    '.utility-dock-pane[data-surface-active="true"] .workbench-explorer',
  ), null, "the active Source Control layer must not retain the Files toolbar");
  // GitHub Desktop's commit form: the branch lives on the button, not in a
  // message placeholder (commit-message.tsx:1519-1541).
  assert.ok(document.querySelector('.dock-scm-commit input[aria-label="Summary"]'),
    "the revealed Source Control surface carries the commit summary field");
  assert.match(document.querySelector(".dock-scm-commit-button")?.textContent || "", /main/);
  assert.equal(document.querySelector(".dock-scm-header"), null);
  await act(async () => {
    for (const resolve of resolveGit.splice(0)) resolve(gitStatus);
    await Promise.resolve();
    await Promise.resolve();
  });

  await act(async () => {
    root.render(React.createElement(UtilityDock, { ...props, tab: "tasks" }));
    await Promise.resolve();
    root.render(React.createElement(UtilityDock, { ...props, tab: "source-control" }));
    await Promise.resolve();
  });
  assert.equal(currentCover(), null,
    "Source Control re-entry must not invalidate and replay its ready cover");
  assert.ok(document.querySelector(".dock-source-control"));

  const sourceHeader = document.querySelector(
    '.utility-dock-pane[data-tab="source-control"] .utility-dock-header',
  );
  const projectTrigger = document.querySelector(
    '.utility-dock-pane[data-tab="source-control"] [aria-label="Switch project"]',
  );
  await act(async () => projectTrigger?.click());
  await act(async () => Array.from(document.querySelectorAll('.mx-menu [role="option"]'))
    .find((option) => option.textContent.includes("other"))?.click());
  assert.equal(document.querySelector(
    '.utility-dock-pane[data-tab="source-control"] .utility-dock-header',
  ), sourceHeader, "project selection must preserve the exact panel frame");
  assert.equal(currentCover(), null,
    "a project dropdown update must not replay the whole Dock cover");
  assert.equal(dockBody?.dataset.ready, "true");
  assert.ok(document.querySelector(".dock-scm-loading"),
    "only the data region should expose its local loading state");
});

test("cold Source Control uses a static target shell instead of replaying a spinner", async () => {
  installDom();
  const projectPath = "C:\\work\\cold-source-control";
  const resolveGit = [];
  window.mixdogDesktop = {
    gitStatus: async () => new Promise((resolve) => { resolveGit.push(resolve); }),
  };
  const props = {
    open: true,
    width: 380,
    tab: "source-control",
    onTab() {},
    onResize() {},
    snapshot: { currentProject: projectPath, items: [] },
    projectPath,
  };
  await act(async () => {
    root.render(React.createElement(UtilityDock, props));
    await Promise.resolve();
  });
  const dockBody = document.querySelector(".utility-dock-body");
  const coldCover = dockBody?.lastElementChild;
  assert.ok(coldCover?.classList.contains("pane-surface-cover"));
  assert.equal(coldCover?.textContent?.trim(), "");
  assert.equal(coldCover?.querySelector(".desktop-loading-spinner"), null);
  assert.equal(document.querySelector(".dock-source-control"), null);

  const gitStatus = {
    repository: true,
    branch: "main",
    detached: false,
    unborn: false,
    upstream: false,
    upstreamName: "",
    remote: false,
    ahead: 0,
    behind: 0,
    operation: "",
    files: [],
  };
  await act(async () => {
    for (const resolve of resolveGit.splice(0)) resolve(gitStatus);
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => new Promise((resolve) => window.requestAnimationFrame(() =>
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))));
  assert.equal(coldCover?.isConnected, false);
  assert.ok(document.querySelector(".dock-source-control"));
});

test("synchronous Dock surfaces stay visible when the selected session changes", async () => {
  installDom();
  window.mixdogDesktop = {};
  const props = {
    open: true,
    width: 380,
    tab: "tasks",
    onTab() {},
    onResize() {},
  };
  await act(async () => root.render(React.createElement(UtilityDock, {
    ...props,
    snapshot: { sessionId: "session-a", items: [] },
  })));
  const dockBody = document.querySelector(".utility-dock-body");
  assert.equal(dockBody?.dataset.ready, "true");
  assert.equal(dockBody?.lastElementChild?.classList.contains("pane-surface-cover"), false);

  await act(async () => root.render(React.createElement(UtilityDock, {
    ...props,
    snapshot: { sessionId: "session-b", items: [] },
  })));
  assert.equal(dockBody?.dataset.ready, "true");
  assert.equal(dockBody?.lastElementChild?.classList.contains("pane-surface-cover"), false);
});

test("Problems panel navigates to the exact file location", async () => {
  installDom();
  const projectPath = "C:\\work\\language";
  const uri = "file:///C:/work/language/src/main.py";
  const opened = [];
  window.mixdogDesktop = {};
  setNativeEditorProblems(projectPath, "src/main.py", uri, [{
    severity: 8,
    message: "Undefined name",
    source: "pyright",
    code: "reportUndefinedVariable",
    startLineNumber: 7,
    startColumn: 3,
    endLineNumber: 7,
    endColumn: 10,
  }]);
  setActiveEditorDocument({ projectPath, relPath: "src/main.py", uri, languageId: "python" });
  setEditorOutline(uri, [{
    key: "main",
    projectPath,
    relPath: "src/main.py",
    uri,
    name: "main",
    detail: "function",
    kind: "12",
    line: 4,
    column: 1,
    endLine: 20,
    level: 0,
  }, {
    key: "step",
    projectPath,
    relPath: "src/main.py",
    uri,
    name: "step",
    detail: "method",
    kind: "6",
    line: 5,
    column: 3,
    endLine: 9,
    level: 1,
  }, {
    key: "cache",
    projectPath,
    relPath: "src/main.py",
    uri,
    name: "cache",
    detail: "binding",
    kind: "binding",
    line: 24,
    column: 1,
    endLine: 24,
    level: 0,
  }]);
  setActiveEditorPosition(uri, 6);
  const onOpenFile = (project, rel, line) => { opened.push([project, rel, line]); };
  await act(async () => root.render(React.createElement(WorkbenchProblemsPane, {
    projectPath,
    active: true,
    activeFileRel: "src/main.py",
    filter: DEFAULT_PROBLEMS_PANEL_FILTER,
    onOpenFile,
  })));
  assert.match(document.querySelector(".problem-tree-row b")?.textContent || "", /Undefined name/);
  assert.equal(document.querySelector(".problems-file-row")?.getAttribute("aria-expanded"), "true");
  await act(async () => document.querySelector(".problem-tree-row")?.click());
  assert.deepEqual(opened.at(-1), [projectPath, "src/main.py", 7]);
  await act(async () => clearActiveEditorDocument(uri));
});
