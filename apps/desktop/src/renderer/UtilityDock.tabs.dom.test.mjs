import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import React, { act } from "react";

import {
  cleanupDom,
  installDom,
  root,
} from "./renderer-dom-test-harness.mjs";

const { UtilityDock } = await import("./UtilityDock.tsx");
const { SourceControlDock } = await import("./SourceControlDock.tsx");
const { SurfaceActiveContext } = await import("./surface-activity.ts");
const { SnapshotUtilityDock } = await import("./app-snapshot-views.tsx");
const { createDesktopSnapshotStore } = await import("./desktop-snapshot-store.ts");
const { PullRequestsPane } = await import("./PullRequestsPane.tsx");

afterEach(cleanupDom);

const GIT_STATUS = {
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

/** Records the DOM as it stands INSIDE each commit (layout phase), before any
 *  passive effect of that commit has run. A portal that is still present here
 *  after deactivation would mean the close depends on an effect pass. */
function CommitProbe({ onCommit }) {
  React.useLayoutEffect(() => { onCommit(); });
  return null;
}

const scmProps = (projectPath, active) => ({
  projectPath,
  status: GIT_STATUS,
  statusReady: true,
  loading: false,
  statusError: "",
  onRefreshStatus() {},
  active,
  readinessKey: `source-control:${projectPath}`,
  onReadyChange() {},
});

const installScmApi = (branchCalls) => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  window.mixdogDesktop = {
    gitStatus: async () => GIT_STATUS,
    gitBranches: async () => {
      branchCalls.push(Date.now());
      return [
        { name: "main", current: true, remote: false, upstream: "" },
        { name: "feature", current: false, remote: false, upstream: "" },
      ];
    },
    gitReview: async () => ({ base: "origin/main" }),
  };
};

const typeInto = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
};

test("Source Control body portals close in the deactivation commit itself", async () => {
  installDom();
  const branchCalls = [];
  installScmApi(branchCalls);
  // Live document listener census: the branch panel's dismiss/Escape handlers
  // and the context menu's own listeners must be REMOVED by deactivation, not
  // merely made ineffective.
  const listenerLog = [];
  const nativeAdd = document.addEventListener.bind(document);
  const nativeRemove = document.removeEventListener.bind(document);
  document.addEventListener = (type, handler, options) => {
    listenerLog.push(["add", type, handler]);
    nativeAdd(type, handler, options);
  };
  document.removeEventListener = (type, handler, options) => {
    listenerLog.push(["remove", type, handler]);
    nativeRemove(type, handler, options);
  };
  const liveListeners = (type) => {
    const live = new Set();
    for (const [kind, entryType, handler] of listenerLog) {
      if (entryType !== type) continue;
      if (kind === "add") live.add(handler);
      else live.delete(handler);
    }
    return live.size;
  };

  const projectPath = "C:\\work\\scm-portals";
  const commits = [];
  const renderDock = async (surfaceActive) => {
    await act(async () => {
      root.render(React.createElement(
        SurfaceActiveContext.Provider,
        { value: surfaceActive },
        React.createElement(SourceControlDock, scmProps(projectPath, surfaceActive)),
        React.createElement(CommitProbe, {
          onCommit: () => commits.push({
            pickers: document.querySelectorAll(".dock-scm-branch-picker").length,
            menus: document.querySelectorAll(".dock-scm-context-menu").length,
          }),
        }),
      ));
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  await renderDock(true);
  const scmRoot = document.querySelector(".dock-source-control");
  const summary = document.querySelector('.dock-scm-commit input[aria-label="Summary"]');
  assert.ok(scmRoot && summary);
  await act(async () => typeInto(summary, "retained draft"));
  await act(async () => document.querySelector(".dock-scm-branch-button")?.click());
  await act(async () => document.querySelector(".dock-scm-sort")?.click());
  assert.ok(document.querySelector(".dock-scm-branch-picker"),
    "the branch picker opens as a body portal");
  const menuItem = document.querySelector(".dock-scm-context-menu [role='menuitemradio']");
  assert.ok(menuItem, "the shared row/View & Sort menu opens as a body portal");
  assert.ok(liveListeners("keydown") > 0, "the open portals own document listeners");
  const branchCallsWhileOpen = branchCalls.length;

  commits.length = 0;
  await renderDock(false);
  assert.ok(commits.length > 0);
  assert.deepEqual(commits[0], { pickers: 0, menus: 0 },
    "both portals are gone in the FIRST commit of the deactivation, not a later effect pass");
  assert.equal(document.querySelector(".dock-scm-branch-picker"), null);
  assert.equal(document.querySelector(".dock-scm-context-menu"), null);
  assert.equal(document.querySelector(".dock-scm-branch-button")
    ?.getAttribute("aria-expanded"), "false");
  assert.equal(liveListeners("keydown"), 0,
    "no Escape handler survives the surface that registered it");
  assert.equal(liveListeners("pointerdown"), 0,
    "and neither does the outside-click dismisser");

  // Stale interaction attempts: none may act on the surface the user left.
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    menuItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(document.querySelector(".dock-scm-branch-picker"), null,
    "a detached menu item and stale document events cannot reopen or re-run anything");
  assert.equal(document.querySelector(".dock-scm-context-menu"), null);
  assert.equal(branchCalls.length, branchCallsWhileOpen,
    "a retained surface issues no branch reload while inactive");

  // Local, non-portal SCM state is untouched by the portal lifecycle.
  assert.equal(document.querySelector(".dock-source-control"), scmRoot,
    "deactivation retains the pane node itself");
  assert.equal(document.querySelector('.dock-scm-commit input[aria-label="Summary"]'), summary);
  assert.equal(summary.value, "retained draft");

  await renderDock(true);
  assert.equal(document.querySelector(".dock-source-control"), scmRoot);
  assert.equal(document.querySelector('.dock-scm-commit input[aria-label="Summary"]'), summary);
  assert.equal(summary.value, "retained draft",
    "the commit draft survives the whole round trip");
  assert.equal(document.querySelector(".dock-scm-branch-picker"), null,
    "reactivation restores the pane without replaying a menu the user left");
  await act(async () => document.querySelector(".dock-scm-branch-button")?.click());
  assert.ok(document.querySelector(".dock-scm-branch-picker"),
    "and the picker reopens normally on the next click");

  document.addEventListener = nativeAdd;
  document.removeEventListener = nativeRemove;
});

test("a standalone Source Control dock defaults to active and keeps its portals", async () => {
  installDom();
  installScmApi([]);
  const projectPath = "C:\\work\\scm-standalone";
  await act(async () => {
    root.render(React.createElement(SourceControlDock, scmProps(projectPath, true)));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => document.querySelector(".dock-scm-branch-button")?.click());
  await act(async () => document.querySelector(".dock-scm-sort")?.click());
  assert.ok(document.querySelector(".dock-scm-branch-picker"),
    "no provider means no retained surface: the branch portal behaves as before");
  assert.ok(document.querySelector(".dock-scm-context-menu"));
});

const flushFrames = () => act(async () => new Promise((resolve) =>
  window.requestAnimationFrame(() => window.requestAnimationFrame(() =>
    window.requestAnimationFrame(resolve)))));

// Seti file icons render as private-use font glyphs INSIDE the row text
// (e.g. "\uE099deep.ts") — strip them before matching the visible label.
const rowByText = (text) => Array.from(document.querySelectorAll(".dock-files-tree button"))
  .find((row) => (row.textContent || "").replace(/[\uE000-\uF8FF]/g, "").trim() === text) || null;

const paneOf = (tab) => document.querySelector(`.utility-dock-pane[data-tab="${tab}"]`);

function installDockApi() {
  window.mixdogDesktop = {
    listProjects: async () => [],
    listProjectDir: async (_project, rel) => (rel === "src"
      ? [{ name: "deep.ts", dir: false }]
      : [{ name: "src", dir: true }, { name: "one.ts", dir: false }]),
    gitStatus: async () => GIT_STATUS,
  };
}

test("switching Dock tabs re-presents the retained surface instead of rebuilding it", async () => {
  installDom();
  installDockApi();
  const projectPath = "C:\\work\\persistent";
  const props = {
    open: true,
    width: 380,
    onTab() {},
    onResize() {},
    snapshot: { currentProject: projectPath, items: [] },
    projectPath,
  };
  const show = async (tab) => {
    await act(async () => {
      root.render(React.createElement(UtilityDock, { ...props, tab }));
      await Promise.resolve();
    });
  };

  await show("files");
  await flushFrames();
  const dockBody = document.querySelector(".utility-dock-body");
  const filesPane = paneOf("files");
  const filesTree = document.querySelector(".dock-files");
  assert.ok(filesPane && filesTree);
  await act(async () => rowByText("src")?.click());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const deepRow = rowByText("deep.ts");
  assert.ok(deepRow, "the expanded folder contributes its own local tree state");

  await show("tasks");
  assert.equal(paneOf("files"), filesPane,
    "an inactive Dock tab keeps its exact pane node");
  assert.equal(document.querySelector(".dock-files"), filesTree);
  assert.equal(rowByText("deep.ts"), deepRow, "local tree expansion survives a tab switch");
  assert.equal(filesPane.dataset.surfaceActive, "false");
  assert.equal(paneOf("tasks")?.dataset.surfaceActive, "true");

  await show("files");
  assert.equal(paneOf("files"), filesPane, "returning to a tab reuses the same DOM");
  assert.equal(document.querySelector(".dock-files"), filesTree);
  assert.equal(rowByText("deep.ts"), deepRow);
  assert.equal(deepRow.isConnected, true);
  assert.equal(filesPane.dataset.surfaceActive, "true");
  assert.equal(dockBody?.dataset.ready, "true");
  assert.equal(dockBody?.lastElementChild?.classList.contains("pane-surface-cover"), false,
    "a retained surface must never replay its loading cover on re-entry");

  await show("tasks");
  await show("files");
  await show("tasks");
  await show("files");
  assert.equal(paneOf("files"), filesPane,
    "repeated round trips stay instant: no surface is destroyed and recreated");
  assert.equal(rowByText("deep.ts"), deepRow);
  assert.equal(dockBody?.lastElementChild?.classList.contains("pane-surface-cover"), false);
});

test("only the selected Dock surface is active, and unopened tabs stay unmounted", async () => {
  installDom();
  installDockApi();
  const projectPath = "C:\\work\\one-active";
  const props = {
    open: true,
    width: 380,
    onTab() {},
    onResize() {},
    snapshot: { currentProject: projectPath, items: [] },
    projectPath,
  };
  const show = async (tab) => {
    await act(async () => {
      root.render(React.createElement(UtilityDock, { ...props, tab }));
      await Promise.resolve();
    });
  };

  await show("files");
  await flushFrames();
  assert.equal(document.querySelectorAll(".utility-dock-pane").length, 1,
    "an unopened Dock surface must not allocate DOM or start background reads");
  assert.equal(paneOf("tasks"), null);

  await show("source-control");
  await flushFrames();
  await show("tasks");
  assert.equal(paneOf("pull-requests"), null,
    "a tab the user never opened stays unmounted");
  assert.equal(document.querySelectorAll(
    '.utility-dock-pane[data-surface-active="true"]').length, 1,
    "exactly one Dock surface may be active at a time");
  const active = document.querySelector('.utility-dock-pane[data-surface-active="true"]');
  assert.equal(active?.dataset.tab, "tasks");
  assert.equal(active?.hasAttribute("aria-hidden"), false);
  assert.equal(active?.hasAttribute("inert"), false);
  for (const tab of ["files", "source-control"]) {
    const pane = paneOf(tab);
    assert.equal(pane?.dataset.surfaceActive, "false");
    assert.equal(pane?.getAttribute("aria-hidden"), "true",
      "a retained inactive surface must be hidden from assistive technology");
    assert.equal(pane?.hasAttribute("inert"), true,
      "a retained inactive surface must not be focusable or interactive");
  }
  // Retained-but-inactive surfaces never present themselves as active work:
  // the Files tree keeps its DOM while the Agents pane owns the selection.
  assert.ok(document.querySelector('.utility-dock-pane[data-tab="files"] .dock-files'));
  assert.equal(document.querySelector(
    '.utility-dock-pane[data-surface-active="true"] .dock-files'), null);
});

test("the Explorer tab uses the Files glyph, not Search", async () => {
  installDom();
  installDockApi();
  await act(async () => {
    root.render(React.createElement(UtilityDock, {
      open: true,
      width: 380,
      tab: "tasks",
      onTab() {},
      onResize() {},
      snapshot: { items: [] },
    }));
    await Promise.resolve();
  });
  const icon = document.querySelector('.utility-dock-tabs button[aria-label="Explorer"] svg');
  assert.ok(icon, "the Explorer tab renders an icon");
  assert.match(icon.getAttribute("class") || "", /lucide-files/);
  assert.doesNotMatch(icon.getAttribute("class") || "", /lucide-search/);
});

test("the production dock wrapper keeps ONE dock element across every tab", async () => {
  installDom();
  installDockApi();
  const projectPath = "C:\\work\\wrapper";
  const snapshotStore = createDesktopSnapshotStore();
  const props = {
    snapshotStore,
    frozenSnapshot: null,
    hidden: false,
    open: true,
    width: 380,
    onTab() {},
    onResize() {},
    projectPath,
    contentReady: true,
  };
  const show = async (tab) => {
    await act(async () => {
      root.render(React.createElement(SnapshotUtilityDock, { ...props, tab }));
      await Promise.resolve();
    });
  };

  await show("files");
  await flushFrames();
  const dockRoot = document.querySelector(".utility-dock");
  const filesTree = document.querySelector(".dock-files");
  assert.ok(dockRoot && filesTree);

  for (const tab of ["tasks", "source-control", "tasks", "files"]) {
    await show(tab);
    await flushFrames();
    assert.equal(document.querySelector(".utility-dock"), dockRoot,
      `switching to ${tab} must not swap the dock component type`);
  }
  assert.equal(document.querySelector(".dock-files"), filesTree,
    "the retained Files tree survives a wrapper-level tab cycle");

  // A live snapshot publish keeps feeding the same dock instance.
  await act(async () => {
    snapshotStore.publish({
      sessionId: "session-a",
      currentProject: projectPath,
      items: [],
      agentWorkers: [],
    });
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".utility-dock"), dockRoot);
  assert.equal(document.querySelector(".dock-files"), filesTree);
});

test("no Git I/O runs while Agents is selected or a Git tab was never opened", async () => {
  installDom();
  const gitCalls = [];
  const dirCalls = [];
  window.mixdogDesktop = {
    listProjects: async () => [],
    listProjectDir: async (project, rel) => {
      dirCalls.push(`${project}|${rel}`);
      return rel === "src"
        ? [{ name: "deep.ts", dir: false }]
        : [{ name: "src", dir: true }, { name: "one.ts", dir: false }];
    },
    gitStatus: async (project) => {
      gitCalls.push(project);
      return GIT_STATUS;
    },
  };
  const projectPath = "C:\\work\\idle-git";
  const base = {
    open: true,
    width: 380,
    onTab() {},
    onResize() {},
    snapshot: { currentProject: projectPath, items: [] },
  };
  const show = async (extra) => {
    await act(async () => {
      root.render(React.createElement(UtilityDock, { ...base, projectPath, ...extra }));
      await Promise.resolve();
    });
  };

  await show({ tab: "tasks" });
  await flushFrames();
  assert.deepEqual(gitCalls, [],
    "an Agents-only dock must not warm Git in the background");
  assert.deepEqual(dirCalls, [], "no Files listing may run before Search is opened");

  await show({ tab: "files" });
  await flushFrames();
  assert.equal(gitCalls.length > 0, true, "the first Git surface selection loads the status");
  assert.equal(dirCalls.length, 1);
  const gitAfterFiles = gitCalls.length;

  await show({ tab: "tasks" });
  await act(async () => {
    window.dispatchEvent(new window.Event("focus"));
    window.dispatchEvent(new window.Event("mixdog:git-changed"));
    await Promise.resolve();
  });
  assert.equal(gitCalls.length, gitAfterFiles,
    "a retained Git surface must not keep polling while Agents is presented");

  // A project change while Files is retained must not read the disk for a
  // surface nobody is looking at; the correct project loads on activation.
  const retainedPane = document.querySelector('.utility-dock-pane[data-tab="files"]');
  await show({ tab: "tasks", projectPath: "C:\\work\\idle-git-two" });
  assert.equal(dirCalls.length, 1, "an inactive Files pane issues no listProjectDir");
  assert.equal(document.querySelector('.utility-dock-pane[data-tab="files"]'), retainedPane,
    "the retained layer survives a project change; only its per-project tree re-keys");
  assert.equal(document.querySelector(".dock-file-row"), null,
    "no stale previous-project rows may stay behind in the retained pane");
  await act(async () => {
    root.render(React.createElement(UtilityDock, {
      ...base,
      projectPath: "C:\\work\\idle-git-two",
      tab: "files",
    }));
    await Promise.resolve();
  });
  await flushFrames();
  assert.equal(dirCalls.length, 2);
  assert.equal(dirCalls[1], "C:\\work\\idle-git-two|",
    "activation loads the current project instead of keeping a stale tree");
});

test("a deactivated pane cannot leave an interactive body portal behind", async () => {
  installDom();
  window.mixdogDesktop = {
    listProjects: async () => [
      { path: "C:\\work\\portal", name: "portal", alias: "" },
      { path: "C:\\work\\other", name: "other", alias: "" },
    ],
    listProjectDir: async () => [{ name: "one.ts", dir: false }],
    gitStatus: async () => GIT_STATUS,
  };
  const projectPath = "C:\\work\\portal";
  const props = {
    open: true,
    width: 380,
    onTab() {},
    onResize() {},
    snapshot: { currentProject: projectPath, items: [] },
    projectPath,
  };
  const show = async (tab) => {
    await act(async () => {
      root.render(React.createElement(UtilityDock, { ...props, tab }));
      await Promise.resolve();
    });
  };
  await show("files");
  await flushFrames();
  const trigger = document.querySelector(
    '.utility-dock-pane[data-tab="files"] [aria-label="Switch project"]');
  assert.ok(trigger);
  await act(async () => trigger.click());
  assert.ok(document.querySelector(".mx-menu"), "the picker opens a body portal");

  await show("tasks");
  assert.equal(document.querySelector(".mx-menu"), null,
    "deactivating the owning pane closes its escaped portal in the same commit");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("Explorer, Source Control and Pull Requests share one controlled project selection", async () => {
  installDom();
  const first = "C:\\work\\shared-one";
  const second = "C:\\work\\shared-two";
  const selections = [];
  window.mixdogDesktop = {
    listProjects: async () => [
      { path: first, name: "shared-one", alias: "" },
      { path: second, name: "shared-two", alias: "" },
    ],
    listProjectDir: async () => [],
    gitStatus: async () => GIT_STATUS,
  };
  function Harness({ tab }) {
    const [projectPath, setProjectPath] = React.useState(first);
    return React.createElement(UtilityDock, {
      open: true,
      width: 380,
      tab,
      onTab() {},
      onResize() {},
      snapshot: { currentProject: first, items: [] },
      projectPath,
      onSelectProject: (path) => {
        selections.push(path);
        setProjectPath(path);
      },
    });
  }
  const show = async (tab) => {
    await act(async () => {
      root.render(React.createElement(Harness, { tab }));
      await Promise.resolve();
    });
  };

  await show("files");
  await flushFrames();
  const activeProjectTrigger = () => document.querySelector(
    '.utility-dock-pane[data-surface-active="true"] [aria-label="Switch project"]');
  await act(async () => activeProjectTrigger()?.click());
  await act(async () => Array.from(document.querySelectorAll('.mx-menu [role="option"]'))
    .find((option) => option.textContent.includes("shared-two"))?.click());
  assert.deepEqual(selections, [second]);

  for (const tab of ["source-control", "pull-requests"]) {
    await show(tab);
    assert.match(activeProjectTrigger()?.textContent || "", /shared-two/,
      `${tab} must inherit the project selected in Explorer`);
  }
});

test("a retained Pull Requests pane stops fetching and ignores late answers", async () => {
  installDom();
  const listCalls = [];
  const branchCalls = [];
  let pending = null;
  const rowsFor = (title) => [
    { key: "copilot", label: "Copilot on My Behalf", prs: [] },
    { key: "review-requested", label: "Waiting For My Review", prs: [] },
    { key: "created", label: "Created By Me", prs: [] },
    {
      key: "all",
      label: "All Open",
      prs: [{
        number: 7,
        title,
        author: "octocat",
        headRefName: "feature/x",
        baseRefName: "main",
        isDraft: false,
        state: "OPEN",
        url: "https://example.test/pull/7",
        updatedAt: "2026-01-01T00:00:00Z",
        reviewDecision: "",
        checks: { total: 0, passing: 0, failing: 0, pending: 0 },
      }],
    },
  ];
  window.mixdogDesktop = {
    ghPrList: async (project) => {
      listCalls.push(project);
      if (listCalls.length === 1) return rowsFor("first answer");
      return new Promise((resolve) => { pending = resolve; });
    },
    gitBranches: async (project) => { branchCalls.push(project); return []; },
    openExternal: async () => {},
  };
  const paneProps = {
    projectPath: "C:\\work\\pr",
    prUrl: "",
    repositoryUrl: "https://github.com/example/pr",
    currentBranch: "main",
    createHint: "",
  };
  const render = (active, extra = {}) => act(async () => {
    root.render(React.createElement(
      SurfaceActiveContext.Provider,
      { value: active },
      React.createElement(PullRequestsPane, { ...paneProps, ...extra }),
    ));
    await Promise.resolve();
    await Promise.resolve();
  });

  await render(false);
  assert.deepEqual(listCalls, [], "an inactive PR pane issues no ghPrList");
  assert.deepEqual(branchCalls, [], "an inactive PR pane issues no gitBranches");

  await render(true);
  assert.equal(listCalls.length, 1);
  assert.match(document.querySelector(".dock-pr-row-label b")
    ?.textContent || "", /first answer/);

  // Second load in flight, then the pane is deactivated: the cached rows stay
  // on screen and the late answer is dropped by the epoch guard.
  await act(async () => document.querySelector('[aria-label="Refresh pull requests"]')?.click());
  assert.equal(listCalls.length, 2);
  await render(false);
  await act(async () => {
    pending?.(rowsFor("stale answer"));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(document.querySelector(".dock-pr-row-label b")
    ?.textContent || "", /first answer/,
  "a late list answer must not repaint a surface the user has left");
  assert.equal(listCalls.length, 2, "no refetch happens while the pane is retained");

  await render(true);
  assert.equal(listCalls.length, 3, "re-entry refreshes once, over the retained rows");
});

test("static contracts: pull-requests clipping and standard suite registration", async () => {
  const css = await readFile(new URL("./desktop.css", import.meta.url), "utf8");
  assert.match(css,
    /\.utility-dock-pane\[data-tab="tasks"\],[\s\S]*?\.utility-dock-pane\[data-tab="pull-requests"\]\s*\{[^}]*overflow:\s*hidden;[^}]*padding:\s*0;/s,
    "every retained Dock surface, Pull Requests included, clips inside one fixed layer");
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts["test:renderer"] || "",
    /src\/renderer\/UtilityDock\.tabs\.dom\.test\.mjs/,
    "the Dock persistence suite runs in the standard renderer test command");
});
