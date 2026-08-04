import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import React, { act } from "react";

import {
  cleanupDom,
  installDom,
  root,
} from "./renderer-dom-test-harness.mjs";

const { SourceControlDock } = await import("./SourceControlDock.tsx");
const { anchoredPanelGeometry } = await import("./anchored-panel.ts");

afterEach(cleanupDom);

const rect = (left, top, width, height) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

// The dock hugs the window's right edge at DESKTOP_UTILITY_DOCK_MIN_WIDTH, so
// every overlay has to be clamped instead of CSS-anchored (anchored-panel.ts).
test("anchored overlays align to their trigger and stay inside their bounds", () => {
  const window1113 = rect(0, 0, 1113, 687);

  const branch = anchoredPanelGeometry({
    trigger: rect(925, 40, 88, 28),
    bounds: window1113,
    preferredWidth: 300,
    minWidth: 220,
    naturalHeight: 208,
    align: "start",
    placement: "below",
  });
  assert.equal(branch.width, 300, "a roomy window keeps the preferred width");
  assert.ok(branch.left + branch.width <= window1113.right - 8,
    "the panel is shifted back inside the window instead of overflowing it");
  assert.equal(branch.top, 72, "it still opens directly under its trigger");
  assert.equal(branch.placement, "below");

  const narrow = anchoredPanelGeometry({
    trigger: rect(20, 40, 88, 28),
    bounds: rect(0, 0, 260, 687),
    preferredWidth: 300,
    minWidth: 220,
    naturalHeight: 208,
  });
  assert.equal(narrow.width, 244,
    "width is capped to the available space, never a fixed 365px");
  assert.ok(narrow.left >= 8 && narrow.left + narrow.width <= 252);

  const flipped = anchoredPanelGeometry({
    trigger: rect(925, 620, 88, 28),
    bounds: window1113,
    preferredWidth: 300,
    minWidth: 220,
    naturalHeight: 400,
    placement: "below",
  });
  assert.equal(flipped.placement, "above",
    "no room below flips the panel above its trigger");
  assert.ok(flipped.top >= 8 && flipped.top + Math.min(400, flipped.maxHeight) <= 620);

  // Commit split menu: bounds are the dock panel, and it prefers to open up.
  const commit = anchoredPanelGeometry({
    trigger: rect(849, 376, 240, 28),
    bounds: rect(823, 36, 290, 384),
    preferredWidth: 240,
    minWidth: 180,
    naturalHeight: 130,
    align: "end",
    placement: "above",
  });
  assert.equal(commit.placement, "above");
  assert.ok(commit.top >= 44, "the menu never starts above the panel's top edge");
  assert.ok(commit.top + 130 <= 376, "it hugs the split button instead of floating");
  assert.ok(commit.left >= 823 - 240 && commit.left + commit.width <= 1113 - 8);

  const squeezed = anchoredPanelGeometry({
    trigger: rect(849, 120, 240, 28),
    bounds: rect(823, 36, 290, 200),
    preferredWidth: 240,
    minWidth: 180,
    naturalHeight: 320,
    align: "end",
    placement: "above",
  });
  assert.ok(squeezed.maxHeight <= 200 - 16,
    "a menu taller than its bounds is capped, never clipped");
});

const file = (path, values = {}) => ({
  path,
  index: " ",
  worktree: "M",
  untracked: false,
  conflicted: false,
  stagedAdditions: 0,
  stagedDeletions: 0,
  unstagedAdditions: 1,
  unstagedDeletions: 0,
  additions: 1,
  deletions: 0,
  ...values,
});

test("SCM surface follows the compact desktop rows and complete Git action grammar", async () => {
  installDom();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  const calls = [];
  const headerSlot = document.createElement("span");
  headerSlot.className = "utility-dock-header-actions";
  document.body.append(headerSlot);
  window.mixdogDesktop = {
    gitBranches: async () => [
      { name: "main", current: true, remote: false, upstream: "origin/main" },
      { name: "feature/scm", current: false, remote: false, upstream: "" },
    ],
    gitIgnore: async (_cwd, path, scope) => { calls.push(["ignore", path, scope]); },
    gitStage: async (_cwd, paths) => { calls.push(["stage", paths]); },
    gitUnstage: async (_cwd, paths) => { calls.push(["unstage", paths]); },
    gitRevert: async (_cwd, path) => { calls.push(["discard", path]); },
    gitCommit: async () => "",
    gitFetch: async () => { calls.push(["fetch"]); return ""; },
    gitPull: async () => "",
    gitPush: async () => { calls.push(["push"]); return ""; },
    gitSync: async () => "",
    gitStash: async () => "",
    gitStashPop: async () => "",
    revealFile: async (_cwd, path) => { calls.push(["reveal", path]); },
  };
  const status = {
    repository: true,
    branch: "main",
    detached: false,
    unborn: false,
    upstream: true,
    upstreamName: "origin/main",
    remote: true,
    remoteUrl: "https://github.com/example/project.git",
    ahead: 1,
    behind: 0,
    operation: "",
    files: [
      file("src/staged.ts", { index: "M", worktree: " ", stagedAdditions: 1, unstagedAdditions: 0 }),
      file("src/change.ts"),
      file("generated/cache.txt", { index: "?", worktree: "?", untracked: true }),
    ],
  };

  await act(async () => {
    root.render(React.createElement(SourceControlDock, {
      projectPath: "C:\\work\\project",
      status,
      statusReady: true,
      loading: false,
      statusError: "",
      onRefreshStatus: async () => {},
      headerSlot,
      active: true,
      readinessKey: "source-control:C:\\work\\project",
      onReadyChange() {},
      onOpenFile() {},
      onOpenDiff() {},
    }));
    await Promise.resolve();
  });

  // Pull/Push left the panel header for the toolbar's ONE morphing button
  // (refs/github-desktop app/src/ui/toolbar/push-pull-button.tsx:435-510).
  assert.equal(headerSlot.querySelector('[aria-label="Pull"]'), null,
    "the header no longer owns a separate Pull button");
  assert.equal(headerSlot.querySelector('[aria-label="Push"]'), null,
    "the header no longer owns a separate Push button");
  // The panel header's "…" overflow menu is GONE and stays gone. Its ONE
  // action is Fetch: the toolbar's THIRD SECTION is Fetch only while there is
  // nothing to pull or push (here it is Push), so fetching keeps a control of
  // its own at the right end of the title row.
  assert.equal(headerSlot.querySelector('[aria-label="More source control actions"]'), null,
    "the header's … overflow menu is deleted");
  const headerFetchButton = headerSlot.querySelector(".dock-scm-header-fetch");
  assert.ok(headerFetchButton, "the header row carries the always-available Fetch");
  assert.deepEqual([...headerSlot.querySelectorAll("button")], [headerFetchButton],
    "and nothing else — the header owns exactly one action");
  assert.equal(headerFetchButton.getAttribute("aria-label"), "Fetch from origin");
  assert.equal(headerFetchButton.disabled, false,
    "a repository with a remote can always fetch");
  const toolbar = document.querySelector(".dock-scm-toolbar");
  assert.ok(toolbar, "the dock renders the repository | branch | push-pull toolbar");
  // Every toolbar segment is the SAME kind of section (equal thirds in CSS —
  // renderer.dom.test.mjs asserts the `flex: 1 1 0` rule itself); with no
  // project picker passed only branch and remote render.
  assert.deepEqual(
    [...toolbar.querySelectorAll(".dock-scm-toolbar-section")]
      .map((section) => section.className.split(" ").at(-1)),
    ["dock-scm-toolbar-branch", "dock-scm-toolbar-remote"],
    "the push/pull button is a full toolbar SECTION, not a pinned icon stub");
  assert.equal(toolbar.querySelector(".dock-scm-branch-button span")?.textContent, "main");
  assert.equal(toolbar.querySelector(".dock-scm-remote-button > span")?.textContent, "Push origin",
    "1 ahead / 0 behind lands on the ladder's Push rung");
  assert.equal(toolbar.querySelector(".dock-scm-ahead-behind")?.textContent, "1");
  const reviewSwitch = document.querySelector('[role="radiogroup"][aria-label="Changes or history"]');
  assert.ok(reviewSwitch, "Changes/History is a radio group segmented control");
  assert.deepEqual(
    [...reviewSwitch.querySelectorAll('[role="radio"]')]
      .map((radio) => [radio.dataset.reviewOption, radio.getAttribute("aria-checked")]),
    [["changes", "true"], ["history", "false"]],
  );
  assert.equal(
    reviewSwitch.querySelector('[data-review-option="changes"] .dock-review-count')?.textContent,
    "3",
    "the Changes option carries the changed-file count badge",
  );
  // ONE flat list with checkbox semantics replaces the staged/unstaged/merge
  // groups (filter-changes-list.tsx + changed-file.tsx:30-43).
  assert.equal(document.querySelector(".dock-scm-group"), null,
    "the Staged/Unstaged group grammar is gone");
  assert.deepEqual(
    [...document.querySelectorAll(".dock-scm-file-name")].map((node) => node.textContent),
    ["cache.txt", "change.ts", "staged.ts"],
  );
  const rowChecks = [...document.querySelectorAll(".dock-scm-file-check")];
  assert.equal(rowChecks.length, 3, "every changed file is one checkbox row");
  assert.ok(rowChecks.every((box) => box.checked),
    "changed files start included in the next commit");
  // The status is GitHub Desktop's ICON at the row's trailing edge
  // (iconForStatus, ui/octicons/status.ts:16-37), not a letter badge — and it
  // keeps an accessible name so the state is still announced.
  const statusIcons = [...document.querySelectorAll(".dock-scm-file .dock-scm-status")];
  assert.deepEqual(statusIcons.map((icon) => icon.getAttribute("data-status")),
    ["new", "modified", "modified"],
    "untracked reads New (diffAdded); tracked edits read Modified (diffModified)");
  assert.deepEqual(statusIcons.map((icon) => icon.getAttribute("aria-label")),
    ["New", "Modified", "Modified"]);
  assert.ok(statusIcons.every((icon) => icon.getAttribute("role") === "img"
    && icon.querySelector("svg") && !icon.textContent.trim()),
    "each status is a named icon with no letter text left in the row");
  // The glyph is the reference's FILLED octicon shape (a solid rounded square
  // with the +/·/− knocked out), not an outline square: outline strokes read a
  // full weight thinner than GitHub Desktop at these sizes.
  assert.ok(statusIcons.every((icon) => {
    const svg = icon.querySelector("svg");
    return svg.getAttribute("fill") === "currentColor"
      && svg.getAttribute("viewBox") === "0 0 16 16"
      && !svg.getAttribute("stroke")
      && svg.querySelector('path[fill-rule="evenodd"]');
  }), "the status glyphs are filled octicon shapes, never outline strokes");
  assert.ok(statusIcons.every((icon) => icon.classList.contains("dock-scm-file-state")
    && icon.previousElementSibling?.classList.contains("dock-scm-file-main")),
    "the status icon sits after the name, on the row's trailing edge");
  assert.ok(document.querySelector(".dock-scm-file-copy > small"));
  assert.equal(document.querySelector(".dock-scm-check-all > span")?.textContent,
    "3 changed files");

  // Path truncation is GitHub Desktop's ALGORITHM, not a CSS ellipsis
  // (path-text.tsx:107-139 truncatePath, :188-227 the split, :316-355 the
  // tooltip): squeeze the path column to a narrow dock width and the FILE NAME
  // still reads in full while the dim directory prefix loses its tail to `…`
  // and the full path moves into the tooltip.
  const measuredRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function narrowDockRect() {
    if (!this.classList?.contains("dock-scm-file-copy")) return measuredRect.call(this);
    return { x: 0, y: 0, left: 0, top: 0, right: 90, bottom: 18, width: 90, height: 18,
      toJSON() { return this; } };
  };
  await act(async () => {
    window.dispatchEvent(new window.Event("resize"));
    await Promise.resolve();
  });
  const narrowPath = document.querySelector(
    '.dock-scm-file-main[title="generated/cache.txt"] .dock-scm-file-copy');
  assert.equal(narrowPath?.querySelector(".dock-scm-file-name")?.textContent, "cache.txt",
    "the file name survives whole at the narrow dock width");
  assert.equal(narrowPath?.querySelector(".dock-scm-file-path")?.textContent, "g…/",
    "the directory prefix is the part that loses its tail");
  assert.equal(narrowPath?.textContent, "g…/cache.txt",
    "the row still reads as ONE truncated sentence");
  assert.equal(narrowPath?.getAttribute("title"), "generated/cache.txt",
    "the full path moves into the tooltip once anything was dropped");
  window.Element.prototype.getBoundingClientRect = measuredRect;
  await act(async () => {
    window.dispatchEvent(new window.Event("resize"));
    await Promise.resolve();
  });
  assert.equal(document.querySelector(
    '.dock-scm-file-main[title="generated/cache.txt"] .dock-scm-file-copy')?.textContent,
    "generated/cache.txt", "a roomy row renders the whole path again");

  // The filter box IS the product's shared search box and sits above the
  // Changes | History selector, matching the Search panel's control order.
  const filterField = document.querySelector(
    '.dock-scm-view-controls > .dock-scm-search.workbench-search-input'
    + ' input[aria-label="Filter changed files"]');
  assert.ok(filterField, "the changes list keeps GitHub Desktop's filter box");
  assert.equal(filterField.getAttribute("placeholder"), "Filter");
  const viewControls = document.querySelector(".dock-scm-view-controls");
  assert.equal(viewControls?.firstElementChild?.querySelector("input"), filterField);
  assert.ok(viewControls?.lastElementChild?.classList.contains("dock-scm-tab-bar"),
    "the shared query field stays above the mode selector");
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
      .set.call(filterField, "change");
    filterField.dispatchEvent(new window.Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".dock-scm-check-all > span")?.textContent,
    "1 of 3 changed files", "a filtered list reports M of N changed files");
  assert.deepEqual(
    [...document.querySelectorAll(".dock-scm-file-name")].map((node) => node.textContent),
    ["change.ts"],
  );
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
      .set.call(filterField, "");
    filterField.dispatchEvent(new window.Event("input", { bubbles: true }));
    await Promise.resolve();
  });

  // The toolbar's third section IS the remote action (Push here, Fetch on a
  // level branch) — the only place it lives now.
  await act(async () => {
    document.querySelector(".dock-scm-toolbar-remote .dock-scm-remote-button").click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(calls.at(-1), ["push"],
    "the toolbar section really runs its rung");

  // View & Sort landed in the FILE-LIST header. (The DOM suite queries it by
  // class: jsdom's selector engine cannot match an attribute value with `&`.)
  const sortTrigger = document.querySelector(".dock-scm-list-header .dock-scm-sort");
  assert.equal(sortTrigger?.getAttribute("aria-label"), "View & Sort");
  assert.ok(sortTrigger, "View & Sort moved into the file-list header");
  await act(async () => {
    sortTrigger.click();
    await Promise.resolve();
  });
  assert.deepEqual(
    [...document.querySelectorAll('.dock-scm-context-menu [role="menuitemradio"]')]
      .map((item) => [item.textContent, item.getAttribute("aria-checked")]),
    // ONE flat list leaves ordering as the only view choice.
    [["Sort by Path", "true"], ["Sort by Name", "false"], ["Sort by Status", "false"]],
  );
  assert.equal(sortTrigger.getAttribute("aria-expanded"), "true");
  await act(async () => {
    [...document.querySelectorAll('.dock-scm-context-menu [role="menuitemradio"]')]
      .find((item) => item.textContent === "Sort by Status").click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".dock-scm-context-menu"), null,
    "choosing an order closes the menu");
  assert.deepEqual(
    [...document.querySelectorAll(".dock-scm-file-name")].map((node) => node.textContent),
    ["change.ts", "staged.ts", "cache.txt"],
    "the relocated View & Sort really reorders the list (modified before new)");
  await act(async () => {
    sortTrigger.click();
    await Promise.resolve();
  });
  await act(async () => {
    [...document.querySelectorAll('.dock-scm-context-menu [role="menuitemradio"]')]
      .find((item) => item.textContent === "Sort by Path").click();
    await Promise.resolve();
  });

  // Stage All / Unstage All / Discard All became the `N changed files` header
  // actions (same checkbox grammar the deleted menu used).
  const bulk = (label) => document.querySelector(`.dock-scm-check-all [aria-label="${label}"]`);
  assert.ok(bulk("Stage All") && bulk("Unstage All") && bulk("Discard All"),
    "the changed-files header owns the bulk actions now");
  await act(async () => {
    bulk("Unstage All").click();
    await Promise.resolve();
  });
  assert.ok([...document.querySelectorAll(".dock-scm-file-check")].every((box) => !box.checked),
    "Unstage All drops every file from the next commit");
  await act(async () => {
    bulk("Stage All").click();
    await Promise.resolve();
  });
  assert.ok([...document.querySelectorAll(".dock-scm-file-check")].every((box) => box.checked),
    "Stage All puts them back");

  // The per-row "…" button is gone: the row answers the RIGHT BUTTON instead.
  assert.equal(document.querySelector('[aria-label="More actions for generated/cache.txt"]'), null,
    "no per-row overflow trigger survives in the changes list");
  const cacheRow = document
    .querySelector('.dock-scm-file-main[title="generated/cache.txt"]').closest(".dock-scm-file");
  await act(async () => {
    cacheRow.dispatchEvent(new window.MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: 120, clientY: 220,
    }));
    await Promise.resolve();
  });
  assert.deepEqual(
    [...document.querySelectorAll('.dock-scm-context-menu [role="menuitem"]')]
      .map((item) => item.textContent),
    // refs/github-desktop's file-list context menu.
    [
      "Discard changes…",
      "Ignore file (add to .gitignore)",
      "Ignore folder (add to .gitignore)",
      "Ignore all .txt files (add to .gitignore)",
      "Copy file path",
      "Copy relative file path",
      "Show in Explorer",
      "Open with default program",
    ],
  );
  await act(async () => {
    [...document.querySelectorAll('.dock-scm-context-menu [role="menuitem"]')]
      .find((item) => item.textContent === "Ignore file (add to .gitignore)").click();
    await Promise.resolve();
  });
  assert.deepEqual(calls.at(-1), ["ignore", "generated/cache.txt", undefined]);
  // …and the file-TYPE entry asks for the unanchored `*<ext>` rule the main
  // side now supports (contract.ts `DesktopGitIgnoreScope`).
  await act(async () => {
    cacheRow.dispatchEvent(new window.MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: 120, clientY: 220,
    }));
    await Promise.resolve();
  });
  const ignoreType = [...document.querySelectorAll('.dock-scm-context-menu [role="menuitem"]')]
    .find((item) => item.textContent === "Ignore all .txt files (add to .gitignore)");
  assert.equal(ignoreType.disabled, false, "ignoring a file type is wired now");
  await act(async () => {
    ignoreType.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(calls.at(-1), ["ignore", "generated/cache.txt", "extension"]);

  await act(async () => {
    // Branch checkout is the toolbar dropdown's job now (the deleted menu's
    // Branch submenu duplicated it).
    document.querySelector(".dock-scm-branch-button").click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.ok(document.querySelector('[role="dialog"][aria-label="Git branches"]'));
  assert.deepEqual(
    [...document.querySelectorAll(".dock-scm-branch-list h3")].map((node) => node.textContent),
    // branch-list.tsx:378-398 grouping.
    ["Default branch", "Other branches"],
  );
  assert.ok([...document.querySelectorAll(".dock-scm-branch-new")].length,
    "the branch panel offers New branch");
  assert.equal(document.querySelector(".dock-scm-merge-row")?.textContent,
    "Choose a branch to merge into main");
  const branchPanel = document.querySelector('[role="dialog"][aria-label="Git branches"]');
  assert.equal(branchPanel.parentElement, document.body,
    "the branch panel is portaled out of the dock so no ancestor overflow can clip it");
  assert.equal(branchPanel.style.position, "fixed",
    "the panel is measured against the window instead of its toolbar section");
});

const historyStatus = {
  repository: true,
  branch: "main",
  detached: false,
  unborn: false,
  upstream: true,
  upstreamName: "origin/main",
  remote: true,
  remoteUrl: "https://github.com/example/project.git",
  ahead: 1,
  behind: 0,
  operation: "",
  files: [
    file("src/staged.ts", { index: "M", worktree: " ", stagedAdditions: 1, unstagedAdditions: 0 }),
    file("src/change.ts"),
  ],
};

const historyEntries = [
  {
    hash: "aaaaaaaaaaaa",
    shortHash: "aaaaaaa",
    subject: "Restore the history surface",
    author: "Mixdog",
    when: "2 minutes ago",
    parents: ["bbbbbbbbbbbb"],
    refs: ["HEAD -> main"],
    pushed: false,
  },
  {
    hash: "bbbbbbbbbbbb",
    shortHash: "bbbbbbb",
    subject: "Merge feature/scm",
    author: "Mixdog",
    when: "1 hour ago",
    parents: ["cccccccccccc", "dddddddddddd"],
    refs: [],
    pushed: true,
  },
  {
    hash: "cccccccccccc",
    shortHash: "ccccccc",
    subject: "Compact the SCM rows",
    author: "Mixdog",
    when: "yesterday",
    parents: [],
    refs: [],
    pushed: true,
  },
];

const flush = async () => {
  // The history effect schedules its own timer while React commits, so drain
  // one extra macrotask turn after every click that changes the surface.
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
};

const reviewOption = (label) => {
  const group = document.querySelector('[role="radiogroup"][aria-label="Changes or history"]');
  assert.ok(group, "the Changes | History radio group must render in the Changes surface");
  // The Changes option carries a count badge, so match the stable option id.
  const option = group.querySelector(`[role="radio"][data-review-option="${label.toLowerCase()}"]`);
  assert.ok(option, `the radio group must expose a ${label} option`);
  return option;
};

const selectHistoryTab = async () => {
  const historyTab = reviewOption("History");
  await act(async () => {
    historyTab.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await flush();
  return historyTab;
};

test("History tab loads the commit graph, opens commit detail, and returns to the list", async () => {
  installDom();
  const calls = [];
  window.mixdogDesktop = {
    gitLog: async (cwd, query, skip, limit) => {
      calls.push(["log", cwd, query, skip, limit]);
      return historyEntries;
    },
    gitShow: async (_cwd, hash) => {
      calls.push(["show", hash]);
      return {
        hash,
        shortHash: hash.slice(0, 7),
        subject: "Restore the history surface",
        author: "Mixdog",
        email: "mixdog@example.com",
        authoredAt: "2026-07-30T00:00:00.000Z",
        parents: ["bbbbbbbbbbbb"],
        files: [
          { path: "src/renderer/SourceControlDock.tsx", status: "M", additions: 12, deletions: 130 },
          { path: "src/renderer/History.tsx", oldPath: "src/renderer/Legacy.tsx", status: "R", additions: 0, deletions: 0 },
        ],
      };
    },
  };
  const openedDiffs = [];

  await act(async () => {
    root.render(React.createElement(SourceControlDock, {
      projectPath: "C:\\work\\project",
      status: historyStatus,
      statusReady: true,
      loading: false,
      statusError: "",
      onRefreshStatus: async () => {},
      headerSlot: null,
      active: true,
      readinessKey: "source-control:C:\\work\\project",
      onReadyChange() {},
      onOpenFile() {},
      onOpenDiff: (project, rel, request) => openedDiffs.push([project, rel, request]),
    }));
    await Promise.resolve();
  });

  assert.ok(document.querySelector(".dock-scm-commit"),
    "the Changes surface starts with the commit composer");
  assert.equal(calls.length, 0, "history must not load until the History tab is selected");

  const historyTab = await selectHistoryTab();
  assert.equal(historyTab.getAttribute("aria-checked"), "true");
  assert.equal(historyTab.tabIndex, 0, "the checked option owns the group's tab stop");
  assert.equal(reviewOption("Changes").tabIndex, -1);
  assert.deepEqual(calls[0], ["log", "C:\\work\\project", "", 0, 40]);
  assert.equal(document.querySelector(".dock-scm-commit"), null,
    "the commit composer belongs to the Changes surface only");

  const historyList = document.querySelector(".dock-scm-history");
  assert.ok(historyList, "the History tab renders the history surface");
  assert.ok(document.querySelector(
    '.dock-scm-view-controls > .dock-scm-search.workbench-search-input'
    + ' input[type="search"][placeholder="Search commits"]'),
    "history keeps its commit search field above the shared mode selector");
  assert.equal(document.querySelector(".dock-scm-history-search"), null,
    "no gray frame survives behind the shared search box");
  const rows = [...historyList.querySelectorAll(".dock-scm-commit-row")];
  assert.deepEqual(rows.map((row) => row.querySelector("b")?.textContent),
    historyEntries.map((entry) => entry.subject));
  // The commit-graph rail is gone: it only ate width inside a ~300px dock
  // (the reference commit list has no graph at all).
  assert.equal(historyList.querySelector("svg.dock-scm-graph"), null,
    "no vestigial commit-graph SVG rail survives in the history rows");
  assert.equal(rows[0].querySelector(".dock-scm-refs em")?.textContent, "HEAD -> main");
  assert.ok(rows[0].querySelector(
    '.dock-scm-unpushed[aria-label="Push unpushed commits to origin"]'),
    "an unpushed commit ends in the round push button");
  assert.equal(rows[1].querySelector(".dock-scm-unpushed"), null,
    "a pushed commit carries no push button at all");

  await act(async () => {
    rows[0].click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await flush();
  assert.deepEqual(calls.at(-1), ["show", "aaaaaaaaaaaa"]);
  const detail = document.querySelector(".dock-scm-history.dock-scm-commit-detail");
  assert.ok(detail, "selecting a commit opens the commit detail surface");
  assert.equal(detail.querySelector("header b")?.textContent, "Restore the history surface");
  assert.equal(detail.querySelector(".dock-scm-commit-ref code")?.textContent, "aaaaaaa",
    "the header carries the short SHA (expandable-commit-summary.tsx:434-449)");
  assert.equal(detail.querySelector(".dock-scm-commit-author > span:last-child")?.textContent,
    "Mixdog");
  const fileRows = [...detail.querySelectorAll(".dock-scm-commit-file-row")];
  assert.deepEqual(fileRows.map((row) => row.querySelector("span")?.textContent), [
    "src/renderer/SourceControlDock.tsx",
    "src/renderer/Legacy.tsx → src/renderer/History.tsx",
  ]);
  // The commit-detail list reads with the SAME status icons as the working
  // directory rows.
  assert.deepEqual(
    fileRows.map((row) => row.querySelector(".dock-scm-status")?.getAttribute("data-status")),
    ["modified", "renamed"]);
  assert.deepEqual(
    fileRows.map((row) => row.querySelector(".dock-scm-status")?.getAttribute("aria-label")),
    ["Modified", "Renamed"]);
  assert.equal(fileRows[0].querySelector("strong"), null,
    "no letter badge survives in the commit-detail rows");
  assert.equal(fileRows[0].querySelector("small i")?.textContent, "+12");
  assert.equal(fileRows[0].querySelector("small em")?.textContent, "-130");
  // The path is the SAME renderer the Changes list uses (ScmPathText), so the
  // file name is preserved and only the dim directory prefix can truncate.
  assert.ok(fileRows.every((row) => row.querySelector(".dock-scm-file-copy")),
    "the commit-detail rows render their path through ScmPathText");
  assert.deepEqual(
    fileRows.map((row) => row.querySelector(".dock-scm-file-name")?.textContent),
    ["SourceControlDock.tsx", "History.tsx"],
    "the file NAME is the bright trailing segment, never the truncated part");
  // ONE trailing control per row: the status icon. The second icon (chevron /
  // diff glyph) only squeezed the path.
  assert.deepEqual(fileRows.map((row) => row.querySelectorAll(":scope > svg").length),
    [0, 0], "no second trailing control survives beside the status icon");
  assert.deepEqual(fileRows.map((row) => row.querySelectorAll(".dock-scm-status").length),
    [1, 1], "each row carries exactly one status icon");

  await act(async () => {
    fileRows[0].click();
    await Promise.resolve();
  });
  assert.deepEqual(openedDiffs.at(-1), [
    "C:\\work\\project",
    "src/renderer/SourceControlDock.tsx",
    { source: "commit", hash: "aaaaaaaaaaaa" },
  ]);

  await act(async () => {
    detail.querySelector('[aria-label="Back to commit history"]').click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await flush();
  assert.equal(document.querySelector(".dock-scm-commit-detail"), null,
    "back navigation leaves the commit detail surface");
  assert.deepEqual(
    [...document.querySelectorAll(".dock-scm-history .dock-scm-commit-row b")]
      .map((node) => node.textContent),
    historyEntries.map((entry) => entry.subject),
  );

  await act(async () => {
    reviewOption("Changes").click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await flush();
  assert.ok(document.querySelector(".dock-scm-commit"),
    "switching back to Changes restores the commit composer");
  assert.equal(document.querySelector(".dock-scm-history"), null);
});

// Changes | History keeps radio semantics and the count badge while sharing
// Search's equal-width Names | Contents segmented-control grammar.
test("Changes | History shares the Search mode control with the count badge", async () => {
  installDom();
  window.mixdogDesktop = { gitLog: async () => historyEntries };
  await mountDock(historyStatus);

  const bar = document.querySelector('.dock-scm-tab-bar[role="radiogroup"][aria-label="Changes or history"]');
  assert.ok(bar, "the selector shares the Search panel's two-column control");
  assert.equal(document.querySelector(".dock-review-switch"), null,
    "the compact inline segmented control is gone");
  const tabs = [...bar.children];
  assert.equal(tabs.length, 2, "exactly two halves span the panel");
  assert.ok(tabs.every((tab) => tab.classList.contains("dock-scm-tab")
    && tab.getAttribute("role") === "radio"),
    "each half is a tab-bar item that keeps its radio semantics");
  assert.deepEqual(tabs.map((tab) => tab.dataset.reviewOption), ["changes", "history"]);
  // Roving tabindex is unchanged by the layout port.
  assert.deepEqual(tabs.map((tab) => tab.tabIndex), [0, -1]);
  assert.equal(tabs[0].querySelector(".dock-scm-tab-label")?.textContent, "Changes");
  assert.equal(tabs[1].querySelector(".dock-scm-tab-label")?.textContent, "History");
  assert.equal(tabs[0].querySelector(".dock-scm-tab-content .dock-review-count")?.textContent,
    "2", "the Changes half carries the changed-file counter");
  assert.equal(tabs[1].querySelector(".dock-review-count"), null,
    "the History half never shows a count");
});

// refs/github-desktop app/src/ui/history/commit-list-item.tsx:136-211.
test("History rows keep the reference single-line commit grammar", async () => {
  installDom();
  const longSubject = "Rewrite the history list so a 300px dock never wraps a commit row";
  const pushes = [];
  window.mixdogDesktop = {
    gitLog: async () => [{
      hash: "eeeeeeeeeeee",
      shortHash: "eeeeeee",
      subject: longSubject,
      author: "Ada Lovelace",
      when: "3 hours ago",
      parents: ["ffffffffffff"],
      refs: ["main", "origin/main", "v0.9.87"],
      pushed: false,
    }],
    gitPush: async () => { pushes.push("push"); return ""; },
  };
  await mountDock(historyStatus);
  await selectHistoryTab();

  const row = document.querySelector(".dock-scm-history .dock-scm-commit-row");
  assert.ok(row, "the History surface renders commit rows");
  assert.equal(row.getAttribute("title"), longSubject,
    "the full subject stays reachable as the row tooltip while the line truncates");
  assert.equal(row.querySelector(".dock-scm-commit-avatar"), null,
    "history rows carry NO author monogram — the width belongs to the summary");
  assert.equal(row.firstElementChild?.className, "dock-scm-commit-info",
    "the text column is the row's leading element now");
  assert.equal(row.getAttribute("role"), "button",
    "the row keeps its button semantics while hosting its own push button");
  assert.equal(row.tabIndex, 0, "and stays one keyboard stop");
  assert.equal(row.querySelector(".dock-scm-commit-info > b")?.textContent, longSubject,
    "line one is the commit summary only");
  assert.equal(row.querySelector(".dock-scm-commit-info > small")?.textContent,
    "Ada Lovelace · 3 hours ago",
    "line two is the byline: author · relative age");
  assert.equal(row.querySelectorAll(".dock-scm-commit-info > *").length, 2,
    "nothing else is allowed to add a third line");
  // renderCommitListItemTags: the FIRST ref plus a dot, never a wrapping list.
  const refs = row.querySelector(".dock-scm-refs");
  assert.equal(refs.querySelectorAll("em").length, 1,
    "three refs still render as ONE badge inside the row");
  assert.equal(refs.querySelector("em").textContent, "main");
  assert.ok(refs.querySelector(".dock-scm-refs-more"),
    "the remaining refs collapse into the more dot");
  assert.equal(refs.querySelector(".dock-scm-refs-more").textContent, "+2",
    "the hidden refs are COUNTED visibly for pointer and touch users");
  assert.equal(refs.getAttribute("title"), "main, origin/main, v0.9.87",
    "and stay readable in the tooltip");
  // The row is the focusable element, so the hidden refs (and the unpushed
  // glyph) have to live in ITS accessible name — a title on a non-focusable
  // child is unreachable by keyboard and AT.
  assert.equal(row.getAttribute("aria-label"),
    `${longSubject} · Ada Lovelace, 3 hours ago · refs: main, origin/main, v0.9.87 · unpushed`,
    "every truncated or glyph-only detail is spelled out in the row's name");
  const unpushed = row.querySelector(".dock-scm-unpushed");
  assert.ok(unpushed, "an unpushed commit ends in a trailing affordance");
  assert.equal(unpushed.tagName, "BUTTON",
    "it is a real push BUTTON now, not a decorative arrow");
  assert.equal(unpushed.textContent, "",
    "it is an icon button, not the old text badge that collided with the title");
  assert.equal(unpushed.getAttribute("aria-label"), "Push unpushed commits to origin",
    "the button carries a clear accessible name");
  assert.equal(unpushed.disabled, false, "an upstream with no operation lets it fire");
  assert.ok(unpushed.querySelector("svg"), "the button keeps the reference's arrow icon");
  // It is a QUIET list-row affordance, not the composer's send button: the
  // loud contrast disc competed with the commit title beside it.
  assert.ok(unpushed.classList.contains("dock-scm-unpushed"),
    "the round push button carries its own row-action class");
  assert.ok(!unpushed.classList.contains("send-button"),
    "and never borrows the composer's loud send-button surface");
  const desktopCss = await readFile(new URL("./desktop.css", import.meta.url), "utf8");
  assert.match(desktopCss,
    /\.dock-scm-unpushed\s*\{[^}]*color:\s*var\(--mx-grey-50\);[^}]*background:\s*var\(--mx-accent-bg\);/s,
    "the History row push receives the download-style accent fill");
  assert.match(unpushed.querySelector("svg").getAttribute("class") || "", /\blucide\b/,
    "and the composer's own icon set, not a hand-rolled path");
  assert.match(unpushed.querySelector("svg").getAttribute("class") || "", /arrow-up/,
    "with the arrow pointing UP (push), never a down/right caret");
  assert.equal(row.querySelector(".dock-scm-commit-indicators").lastElementChild, unpushed,
    "the indicators sit after the text column so neither can grow the row");
  // The button runs the TOOLBAR's push action, and never opens the commit.
  await act(async () => {
    unpushed.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await flush();
  assert.deepEqual(pushes, ["push"], "the row button reuses the toolbar's push");
  assert.equal(document.querySelector(".dock-scm-commit-detail"), null,
    "pushing from the row never opens the commit detail surface");
});

// Same rules as the toolbar's push/pull button (push-pull-button.tsx:435-555).
test("the history row's push button obeys the toolbar's push rules", async () => {
  installDom();
  const pushes = [];
  window.mixdogDesktop = {
    gitLog: async () => [{
      hash: "eeeeeeeeeeee",
      shortHash: "eeeeeee",
      subject: "Unpushed work",
      author: "Ada Lovelace",
      when: "3 hours ago",
      parents: [],
      refs: [],
      pushed: false,
    }],
    gitPush: async () => { pushes.push("push"); return ""; },
  };

  await mountDock({ ...historyStatus, operation: "rebase" });
  await selectHistoryTab();
  const midOperation = document.querySelector(".dock-scm-history .dock-scm-unpushed");
  assert.equal(midOperation.disabled, true,
    "a git operation in progress blocks the row push exactly like the toolbar");
  assert.equal(midOperation.title, "Finish the in-progress rebase first");
  await act(async () => {
    midOperation.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(pushes, [], "a disabled push never reaches git");

  await mountDock({ ...historyStatus, upstream: false, upstreamName: "" });
  await selectHistoryTab();
  const noUpstream = document.querySelector(".dock-scm-history .dock-scm-unpushed");
  assert.equal(noUpstream.disabled, true,
    "without an upstream, publishing stays the toolbar's job");
  assert.equal(noUpstream.title, "Publish the branch from the toolbar before pushing");
  await act(async () => {
    noUpstream.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(pushes, [], "and no push is fired without one");
});

// refs/github-desktop app/src/ui/history/expandable-commit-summary.tsx:434-449,
// :552-566 and selected-commits.tsx:278-283.
test("Commit detail adopts the reference header: SHA copy, totals, changed files", async () => {
  installDom();
  const copied = [];
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => { copied.push(text); } },
  });
  window.mixdogDesktop = {
    gitLog: async () => historyEntries,
    gitShow: async (_cwd, hash) => ({
      hash,
      shortHash: hash.slice(0, 7),
      subject: "Restore the history surface",
      author: "Ada Lovelace",
      email: "ada@example.com",
      authoredAt: "2026-07-30T00:00:00.000Z",
      parents: ["bbbbbbbbbbbb"],
      files: [
        { path: "src/renderer/SourceControlDock.tsx", status: "M", additions: 12, deletions: 130 },
        { path: "src/renderer/desktop.css", status: "M", additions: 30, deletions: 18 },
      ],
    }),
  };
  await mountDock(historyStatus);
  await selectHistoryTab();
  await act(async () => {
    document.querySelector(".dock-scm-history .dock-scm-commit-row").click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await flush();

  const header = document.querySelector(".dock-scm-commit-detail .dock-scm-commit-header");
  assert.ok(header, "the detail surface opens with the reference commit header");
  assert.equal(header.querySelector(".dock-scm-commit-headline > b")?.textContent,
    "Restore the history surface");
  // The header reads exactly like the history rows: NO monogram disc, just the
  // author name — the freed width goes to the meta row's own content.
  assert.equal(header.querySelector(".dock-scm-commit-avatar"), null,
    "the commit-detail header carries NO author monogram either");
  assert.equal(header.querySelector(".dock-scm-commit-author > span:last-child")?.textContent,
    "Ada Lovelace", "the author slot is the plain name");
  assert.equal(header.querySelector(".dock-scm-commit-ref code")?.textContent, "aaaaaaa",
    "the short SHA is the visible ref");
  assert.equal(header.querySelector(".dock-scm-commit-lines i")?.textContent, "+42",
    "the totals sum every changed file's additions");
  assert.equal(header.querySelector(".dock-scm-commit-lines em")?.textContent, "−148",
    "and its deletions");
  assert.equal(document.querySelector(".dock-scm-commit-files-header")?.textContent,
    "2 changed files", "the file list is introduced by the reference count header");

  const copy = header.querySelector('.dock-scm-commit-copy[aria-label="Copy the full SHA"]');
  assert.ok(copy, "the short SHA keeps a copy affordance");
  await act(async () => {
    copy.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(copied, ["aaaaaaaaaaaa"],
    "copying yields the FULL sha, not the abbreviated one");
  assert.equal(document.querySelector('.dock-scm-commit-copy[title="Copied"]') !== null, true,
    "the affordance confirms the copy");

  // Opening a file still routes to the existing diff surface — no third pane.
  assert.equal(document.querySelectorAll(".dock-scm-commit-diff").length, 0);
});

test("a refused SHA copy reports the failure instead of claiming Copied", async () => {
  installDom();
  window.mixdogDesktop = {
    gitLog: async () => historyEntries,
    gitShow: async (_cwd, hash) => ({
      hash,
      shortHash: hash.slice(0, 7),
      subject: "Restore the history surface",
      author: "Ada Lovelace",
      email: "ada@example.com",
      authoredAt: "2026-07-30T00:00:00.000Z",
      parents: [],
      files: [{ path: "src/renderer/SourceControlDock.tsx", status: "M", additions: 1, deletions: 0 }],
    }),
  };
  // No Clipboard API at all (an insecure context behaves exactly like this).
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  await mountDock(historyStatus);
  await selectHistoryTab();
  await act(async () => {
    document.querySelector(".dock-scm-history .dock-scm-commit-row").click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await flush();

  const copy = document.querySelector(".dock-scm-commit-copy");
  assert.equal(copy.title, "Copy the full SHA");
  await act(async () => {
    copy.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(document.querySelector(".dock-scm-commit-copy").title, "Copy failed",
    "a copy that never happened must not read as Copied");
  assert.equal(document.querySelector('.dock-scm-copy-status[role="status"]')?.textContent,
    "Could not copy the SHA to the clipboard",
    "the outcome is announced through a live region");
  assert.match(errorText(), /no clipboard access/,
    "and surfaces in the dock's error banner");

  // A rejecting clipboard is reported the same way, with its own reason.
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => { throw new Error("Write permission denied"); } },
  });
  await act(async () => {
    document.querySelector(".dock-scm-commit-copy").click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(document.querySelector(".dock-scm-commit-copy").title, "Copy failed");
  assert.match(errorText(), /Write permission denied/,
    "a rejection is never swallowed");
});

test("an empty commit message and a missing author stay distinct from loading", async () => {
  installDom();
  let resolveShow = () => {};
  window.mixdogDesktop = {
    gitLog: async () => [{
      hash: "1111111111111111",
      shortHash: "1111111",
      subject: "   ",
      author: "",
      when: "just now",
      authoredAt: "2026-07-31T00:00:00.000Z",
      pushed: true,
      parents: [],
      refs: [],
    }],
    gitShow: () => new Promise((resolve) => { resolveShow = resolve; }),
  };
  await mountDock(historyStatus);
  await selectHistoryTab();

  const row = document.querySelector(".dock-scm-history .dock-scm-commit-row");
  assert.equal(row.querySelector(".dock-scm-commit-info > b")?.textContent,
    "Empty commit message", "an empty subject is LABELLED, never a blank line");
  assert.equal(row.querySelector(".dock-scm-commit-info > b")?.dataset.empty, "true");
  assert.equal(row.querySelector(".dock-scm-commit-info > small")?.textContent,
    "Unknown author · just now");
  assert.equal(row.querySelector(".dock-scm-commit-avatar"), null,
    "history rows render no monogram at all, blank author or not");

  // While gitShow is still in flight the header says LOADING…
  await act(async () => {
    row.click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".dock-scm-commit-headline > b")?.textContent,
    "Loading commit…");
  // …and once it lands empty, it says so instead of pretending to still load.
  await act(async () => {
    resolveShow({
      hash: "1111111111111111",
      shortHash: "1111111",
      subject: "",
      author: "  ",
      email: "",
      authoredAt: "2026-07-31T00:00:00.000Z",
      parents: [],
      files: [],
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  const headline = document.querySelector(".dock-scm-commit-headline > b");
  assert.equal(headline?.textContent, "Empty commit message",
    "a loaded commit is never stuck on the loading string");
  assert.equal(headline?.dataset.empty, "true");
  assert.equal(document.querySelector(".dock-scm-commit-author > span:last-child")?.textContent,
    "Unknown author");
  assert.equal(document.querySelector(".dock-scm-commit-files-header")?.textContent,
    "0 changed files");
  assert.ok(document.querySelector(".dock-scm-commit-detail .utility-dock-empty"),
    "a commit with no files degrades instead of throwing");
});

test("Arrow keys move the Changes/History radio group and switch the surface", async () => {
  installDom();
  const calls = [];
  window.mixdogDesktop = {
    gitLog: async (cwd, query, skip, limit) => {
      calls.push(["log", cwd, query, skip, limit]);
      return historyEntries;
    },
    gitStage: async () => {},
    gitUnstage: async () => {},
  };

  await act(async () => {
    root.render(React.createElement(SourceControlDock, {
      projectPath: "C:\\work\\project",
      status: historyStatus,
      statusReady: true,
      loading: false,
      statusError: "",
      onRefreshStatus: async () => {},
      headerSlot: null,
      active: true,
      readinessKey: "source-control:C:\\work\\project",
      onReadyChange() {},
      onOpenFile() {},
      onOpenDiff() {},
    }));
    await Promise.resolve();
  });

  const press = async (key, from) => {
    await act(async () => {
      reviewOption(from).dispatchEvent(new window.KeyboardEvent("keydown", {
        key, bubbles: true, cancelable: true,
      }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await flush();
  };

  assert.equal(reviewOption("Changes").getAttribute("aria-checked"), "true");
  await press("ArrowRight", "Changes");
  assert.equal(reviewOption("History").getAttribute("aria-checked"), "true",
    "ArrowRight moves the selection to History");
  assert.equal(document.activeElement, reviewOption("History"),
    "selection follows focus inside the radio group");
  assert.ok(document.querySelector(".dock-scm-history"),
    "keyboard selection switches the surface exactly like a click");
  assert.deepEqual(calls[0], ["log", "C:\\work\\project", "", 0, 40],
    "keyboard selection runs the same history load as a click");

  await press("ArrowLeft", "History");
  assert.equal(reviewOption("Changes").getAttribute("aria-checked"), "true",
    "ArrowLeft moves the selection back to Changes");
  assert.ok(document.querySelector(".dock-scm-commit"),
    "returning to Changes restores the commit card");

  // Up/Down mirror Left/Right for platform radio parity.
  await press("ArrowDown", "Changes");
  assert.equal(reviewOption("History").getAttribute("aria-checked"), "true");
  // Re-entering History re-runs the load behind the 180ms debounce
  // (SourceControlDock.tsx:351-358) — the surface does not cache.
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 260));
  });
  assert.equal(calls.length, 2,
    "re-entering History re-runs gitLog once the debounce elapses");
  await press("ArrowUp", "History");
  assert.equal(reviewOption("Changes").getAttribute("aria-checked"), "true");
});

test("Escape clears the SCM row selection without a multi-select toolbar", async () => {
  installDom();
  window.mixdogDesktop = {
    gitStage: async () => {},
    gitUnstage: async () => {},
  };
  const openedDiffs = [];

  await act(async () => {
    root.render(React.createElement(SourceControlDock, {
      projectPath: "C:\\work\\project",
      status: historyStatus,
      statusReady: true,
      loading: false,
      statusError: "",
      onRefreshStatus: async () => {},
      headerSlot: null,
      active: true,
      readinessKey: "source-control:C:\\work\\project",
      onReadyChange() {},
      onOpenFile() {},
      onOpenDiff: (project, rel, request) => openedDiffs.push([project, rel, request]),
    }));
    await Promise.resolve();
  });

  const changeRow = document.querySelector('.dock-scm-file-main[title="src/change.ts"]');
  assert.ok(changeRow);
  await act(async () => {
    changeRow.click();
    await Promise.resolve();
  });
  assert.equal(changeRow.closest(".dock-scm-file").getAttribute("data-selected"), "true");
  assert.equal(changeRow.closest(".dock-scm-file").getAttribute("aria-selected"), "true");
  assert.equal(document.querySelector(".dock-scm-selection"), null,
    "multi-select is row state only — the legacy selection toolbar stays gone");

  await act(async () => {
    changeRow.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector('.dock-scm-file[data-selected="true"]'), null,
    "Escape inside the change list clears the selection");
  assert.equal(
    document.querySelector('.dock-scm-file-main[title="src/change.ts"]')
      .closest(".dock-scm-file").getAttribute("aria-selected"),
    "false",
  );
});

const setFieldValue = async (element, value) => {
  const prototype = element.tagName === "TEXTAREA"
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

// GitHub Desktop's commit form: Summary (required) + Description
// (refs/github-desktop app/src/ui/changes/commit-message.tsx:1771-1852).
const typeCommitMessage = async (summary, description = "") => {
  const summaryField = document.querySelector('.dock-scm-commit input[aria-label="Summary"]');
  assert.ok(summaryField, "the commit card keeps a required summary input");
  await setFieldValue(summaryField, summary);
  if (description) {
    const descriptionField = document
      .querySelector('.dock-scm-commit textarea[aria-label="Description"]');
    assert.ok(descriptionField, "the commit card keeps a description textarea");
    await setFieldValue(descriptionField, description);
  }
  return summaryField;
};

const rowCheckbox = (path) => {
  const box = document.querySelector(`.dock-scm-file-check[aria-label="Include ${path} in the commit"]`);
  assert.ok(box, `the list must expose a checkbox for ${path}`);
  return box;
};

const toggleRow = async (path) => {
  const box = rowCheckbox(path);
  await act(async () => {
    box.click();
    await Promise.resolve();
  });
  return box;
};

// GitHub Desktop: the checkboxes ARE the commit selection; the index is only
// reconstructed under the hood right before `git commit`.
test("Checkbox selection drives the commit path and the button label", async () => {
  installDom();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  const calls = [];
  window.mixdogDesktop = {
    gitStage: async (_cwd, paths) => { calls.push(["stage", [...paths].sort()]); },
    gitUnstage: async (_cwd, paths) => { calls.push(["unstage", [...paths].sort()]); },
    gitCommit: async (_cwd, message) => { calls.push(["commit", message]); return ""; },
    gitPush: async () => { calls.push(["push"]); },
    gitSync: async () => { calls.push(["sync"]); },
    gitAmend: async () => "",
  };
  const dirtyStatus = {
    repository: true,
    branch: "main",
    detached: false,
    unborn: false,
    upstream: true,
    upstreamName: "origin/main",
    remote: true,
    remoteUrl: "https://github.com/example/project.git",
    ahead: 0,
    behind: 0,
    operation: "",
    files: [
      file("src/change.ts"),
      file("generated/new.txt", { index: "?", worktree: "?", untracked: true }),
    ],
  };
  // The commit path re-reads the index instead of trusting the polled prop.
  window.mixdogDesktop.gitStatus = async () => {
    calls.push(["status"]);
    return dirtyStatus;
  };

  await act(async () => {
    root.render(React.createElement(SourceControlDock, {
      projectPath: "C:\\work\\project",
      status: dirtyStatus,
      statusReady: true,
      loading: false,
      statusError: "",
      onRefreshStatus: async () => {},
      headerSlot: null,
      active: true,
      readinessKey: "source-control:C:\\work\\project",
      onReadyChange() {},
      onOpenFile() {},
      onOpenDiff() {},
    }));
    await Promise.resolve();
  });

  const primary = document.querySelector('.dock-scm-commit-split > button[type="submit"]');
  assert.ok(primary, "the commit card keeps a primary submit button");
  assert.equal(primary.textContent.trim(), "Commit 2 files to main",
    "the button names the selection and the branch (commit-message.tsx:1519-1541)");
  assert.equal(primary.querySelector("strong")?.textContent, "main",
    "the branch is bolded inside the button label");
  assert.equal(primary.disabled, true, "an empty summary keeps Commit disabled");
  assert.equal(primary.title, "A commit summary is required to commit");

  // The reference reports the blank summary first (commit-message.tsx:1584),
  // so the selection tooltip only surfaces once a summary exists.
  const summaryField = await typeCommitMessage("Ship the changes");
  await toggleRow("generated/new.txt");
  assert.equal(rowCheckbox("generated/new.txt").checked, false,
    "unchecking a row drops it from the next commit");
  assert.equal(document.querySelector('.dock-scm-commit-split > button[type="submit"]')
    .textContent.trim(), "Commit 1 file to main", "one file is singular");

  await toggleRow("src/change.ts");
  assert.equal(document.querySelector('.dock-scm-commit-split > button[type="submit"]').title,
    "Select one or more files to commit",
    "zero selected files blocks the commit with the reference tooltip");
  assert.equal(document.querySelector('.dock-scm-commit-split > button[type="submit"]').disabled,
    true, "zero selected files disables Commit");
  await toggleRow("src/change.ts");

  await typeCommitMessage("Ship the changes", "Extra detail");
  const enabled = document.querySelector('.dock-scm-commit-split > button[type="submit"]');
  assert.equal(enabled.disabled, false, "a summary plus a selection enables Commit");
  assert.equal(enabled.title, "Commit to main");

  await act(async () => {
    summaryField.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "Enter", ctrlKey: true, bubbles: true,
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(calls, [
    ["status"],
    ["stage", ["src/change.ts"]],
    ["commit", "Ship the changes\n\nExtra detail"],
  ], "Ctrl+Enter re-reads the index, stages exactly the checked paths, then commits"
    + " — an unchecked path that was never staged is left alone");
  assert.equal(document.querySelector('.dock-scm-commit input[aria-label="Summary"]').value, "",
    "a landed commit clears the draft");
});

test("The commit button is ONE action and the toolbar owns the follow-up push", async () => {
  installDom();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  const calls = [];
  let confirmed = 0;
  window.confirm = () => { confirmed += 1; return true; };
  window.mixdogDesktop = {
    gitStatus: async () => historyStatus,
    gitStage: async (_cwd, paths) => { calls.push(["stage", paths]); },
    gitUnstage: async () => {},
    gitCommit: async (_cwd, message) => { calls.push(["commit", message]); return ""; },
    gitPush: async () => { calls.push(["push"]); },
    gitSync: async () => { calls.push(["sync"]); },
    gitAmend: async () => { calls.push(["amend"]); return ""; },
  };

  await act(async () => {
    root.render(React.createElement(SourceControlDock, {
      projectPath: "C:\\work\\project",
      status: historyStatus,
      statusReady: true,
      loading: false,
      statusError: "",
      onRefreshStatus: async () => {},
      headerSlot: null,
      active: true,
      readinessKey: "source-control:C:\\work\\project",
      onReadyChange() {},
      onOpenFile() {},
      onOpenDiff() {},
    }));
    await Promise.resolve();
  });

  await typeCommitMessage("Staged only");
  const primary = document.querySelector('.dock-scm-commit-split > button[type="submit"]');
  await act(async () => {
    primary.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(confirmed, 0, "the commit path never prompts about staging");
  assert.deepEqual(calls, [
    ["stage", ["src/staged.ts", "src/change.ts"]],
    ["commit", "Staged only"],
  ], "every checked file is staged before the commit");

  // The split chevron (∨) is DELETED: the commit row holds exactly one
  // control, and no portaled menu can come back with it.
  assert.equal(document.querySelector('[aria-label="More commit actions"]'), null,
    "the commit button carries no split chevron any more");
  assert.equal(document.querySelector(".dock-scm-commit-menu"), null);
  assert.equal(document.querySelectorAll(".dock-scm-commit-split > button").length, 1,
    "the action row holds exactly one control");

  // Commit & Push is the same two steps it always was: the commit lands, and
  // the toolbar's morphing button (Push, this branch is ahead) sends it.
  await typeCommitMessage("Commit and push");
  await act(async () => {
    document.querySelector('.dock-scm-commit-split > button[type="submit"]').click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(calls.slice(2), [
    ["stage", ["src/staged.ts", "src/change.ts"]],
    ["commit", "Commit and push"],
  ]);
  const remote = document.querySelector(".dock-scm-remote-button");
  assert.equal(remote.getAttribute("aria-label"), "Push origin",
    "the toolbar button IS the follow-up push after a commit");
  assert.equal(remote.querySelector(".dock-scm-remote-verb").textContent, "Push",
    "and it shows its TEXT label, not a bare icon");
  await act(async () => {
    remote.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(calls.at(-1), ["push"], "the toolbar action runs the remote command");

  // A remote action never consumed the draft, so it must not wipe it.
  const draft = await typeCommitMessage("Draft that survives a push");
  await act(async () => {
    document.querySelector(".dock-scm-remote-button").click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(calls.at(-1), ["push"]);
  assert.equal(draft.value, "Draft that survives a push",
    "a standalone Push/Sync/Publish keeps the drafted commit summary");
});

// refs/github-desktop app/src/ui/toolbar/push-pull-button.tsx:435-510.
test("The toolbar push/pull button follows the reference state ladder", async () => {
  installDom();
  const base = {
    repository: true,
    branch: "main",
    detached: false,
    unborn: false,
    upstream: true,
    upstreamName: "origin/main",
    remote: true,
    remoteUrl: "https://github.com/example/project.git",
    ahead: 0,
    behind: 0,
    operation: "",
    files: [file("src/change.ts")],
  };
  const calls = [];
  window.mixdogDesktop = {
    gitBranches: async () => [],
    gitFetch: async () => { calls.push(["fetch"]); return ""; },
    gitPull: async () => { calls.push(["pull"]); return ""; },
    gitPush: async () => { calls.push(["push"]); return ""; },
  };
  const show = async (overrides) => {
    await act(async () => {
      root.render(React.createElement(SourceControlDock, {
        projectPath: "C:\\work\\project",
        status: { ...base, ...overrides },
        statusReady: true,
        loading: false,
        statusError: "",
        onRefreshStatus: async () => {},
        headerSlot: null,
        active: true,
        readinessKey: "source-control:C:\\work\\project",
        onReadyChange() {},
        onOpenFile() {},
        onOpenDiff() {},
      }));
      await Promise.resolve();
    });
    const button = document.querySelector(".dock-scm-remote-button");
    assert.ok(button, "the toolbar always resolves to exactly one remote action");
    return button;
  };

  assert.equal((await show({ remote: false, upstream: false })).querySelector("span").textContent,
    "Publish repository");
  assert.equal((await show({ unborn: true })).querySelector("span").textContent, "Fetch origin");
  assert.equal((await show({ upstream: false, upstreamName: "" })).querySelector("span").textContent,
    "Publish branch");
  const level = await show({});
  assert.equal(level.querySelector("span").textContent, "Fetch origin");
  assert.equal(level.querySelector(".dock-scm-ahead-behind"), null,
    "the ahead/behind badge hides at 0/0");
  const behind = await show({ behind: 3 });
  assert.equal(behind.querySelector("span").textContent, "Pull origin");
  assert.equal(behind.querySelector(".dock-scm-ahead-behind").textContent, "3");
  assert.equal(behind.querySelector(".dock-scm-ahead-behind svg"), null,
    "one direction only: the count stands alone (`Pull 3`, not `Pull 3↓`)");
  const ahead = await show({ ahead: 2 });
  assert.equal(ahead.querySelector("span").textContent, "Push origin");
  assert.equal(ahead.querySelector(".dock-scm-ahead-behind").textContent, "2");
  assert.equal(ahead.querySelector(".dock-scm-ahead-behind svg"), null,
    "the verb already carries the direction, so the badge reads `Push 2`");
  assert.equal(ahead.querySelector(".dock-scm-ahead-behind").dataset.directions, "one");
  // Degradation order: the icon and the badge are structural, the remote name
  // is its own span so a narrow dock drops it before the verb, and the full
  // action always survives in the accessible name.
  assert.ok(ahead.querySelector("svg"), "the push/pull icon is always rendered");
  assert.equal(ahead.querySelector(".dock-scm-remote-verb")?.textContent, "Push");
  assert.equal(ahead.querySelector(".dock-scm-remote-target")?.textContent, " origin");
  assert.equal(ahead.getAttribute("aria-label"), "Push origin");
  const both = await show({ ahead: 2, behind: 3 });
  assert.equal(both.querySelector("span").textContent, "Pull origin",
    "behind wins over ahead, exactly like the reference ladder");
  assert.equal(both.querySelector(".dock-scm-ahead-behind").textContent, "23");
  assert.equal(both.querySelector(".dock-scm-ahead-behind").dataset.directions, "both");
  assert.equal(both.querySelectorAll(".dock-scm-ahead-behind svg").length, 2,
    "ahead AND behind is the one case that needs both arrows (2↑ 3↓)");

  await act(async () => {
    both.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(calls.at(-1), ["pull"]);

  // The dropdown (∨) beside the morphing button is DELETED: the SECTION itself
  // is Fetch whenever there is nothing to pull or push, so nothing it carried
  // became unreachable.
  assert.equal(document.querySelector('[aria-label="More remote actions"]'), null,
    "the morphing button carries no dropdown any more");
  assert.equal(document.querySelector(".dock-scm-remote-menu"), null);
  assert.equal(document.querySelector(".dock-scm-header-fetch"), null,
    "the header Fetch renders in the header SLOT only, never inside the panel");
  const fetchRung = await show({});
  assert.equal(fetchRung.getAttribute("aria-label"), "Fetch origin",
    "a level branch puts Fetch on the toolbar itself");
  assert.equal(fetchRung.disabled, false);
  assert.equal(fetchRung.querySelector(".dock-scm-remote-verb").textContent, "Fetch");
  await act(async () => {
    fetchRung.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(calls.at(-1), ["fetch"]);
});

const repoStatus = (overrides = {}) => ({
  repository: true,
  branch: "main",
  detached: false,
  unborn: false,
  upstream: true,
  upstreamName: "origin/main",
  remote: true,
  remoteUrl: "https://github.com/example/project.git",
  ahead: 0,
  behind: 0,
  operation: "",
  files: [file("src/change.ts")],
  ...overrides,
});

const mountDock = async (status, extra = {}) => {
  await act(async () => {
    root.render(React.createElement(SourceControlDock, {
      projectPath: "C:\\work\\project",
      status,
      statusReady: true,
      loading: false,
      statusError: "",
      onRefreshStatus: async () => {},
      headerSlot: null,
      active: true,
      readinessKey: "source-control:C:\\work\\project",
      onReadyChange() {},
      onOpenFile() {},
      onOpenDiff() {},
      ...extra,
    }));
    await Promise.resolve();
  });
};

const clickCommit = async () => {
  const primary = document.querySelector('.dock-scm-commit-split > button[type="submit"]');
  await act(async () => {
    primary.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  return primary;
};

const errorText = () => document.querySelector(".dock-scm-error")?.textContent || "";

// The status prop is a POLL. Every commit decision is taken from a fresh read,
// and nothing outside the visible, checked selection may be committed or reset.
test("the commit path protects staged work it did not select", async () => {
  installDom();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  const calls = [];
  const prompts = [];
  const snapshot = repoStatus();
  let fresh = snapshot;
  window.mixdogDesktop = {
    gitStatus: async () => { calls.push(["status"]); return fresh; },
    gitStage: async (_cwd, paths) => { calls.push(["stage", [...paths].sort()]); },
    gitUnstage: async (_cwd, paths) => { calls.push(["unstage", [...paths].sort()]); },
    gitCommit: async (_cwd, message) => { calls.push(["commit", message]); return ""; },
  };
  await mountDock(snapshot);
  await typeCommitMessage("Ship it");

  // 1. A file staged partially outside the app: committing would replace that
  // staged content with the whole working tree, so it needs consent.
  fresh = repoStatus({ files: [file("src/change.ts", { index: "M", worktree: "M" })] });
  window.confirm = (message) => { prompts.push(message); return false; };
  await clickCommit();
  assert.match(prompts[0] || "", /staged changes that differ from the working tree/,
    "the partial staging is reported before anything touches the index");
  assert.deepEqual(calls, [["status"]],
    "declining leaves the index untouched and commits nothing");
  assert.equal(document.querySelector('.dock-scm-commit input[aria-label="Summary"]').value,
    "Ship it", "and keeps the draft");

  window.confirm = () => true;
  await clickCommit();
  assert.deepEqual(calls.slice(1), [
    ["status"],
    ["stage", ["src/change.ts"]],
    ["commit", "Ship it"],
  ], "accepting stages exactly the checked path and commits it");

  // 2. A path staged outside this list was never on screen: it must neither be
  // swept into the commit nor reset behind the user's back.
  calls.length = 0;
  await typeCommitMessage("Second commit");
  fresh = repoStatus({
    files: [file("src/change.ts"), file("secret/keys.env", { index: "A", worktree: " " })],
  });
  await clickCommit();
  assert.match(errorText(), /index changed outside this list/,
    "a stale snapshot aborts the commit with an actionable message");
  assert.ok(calls.every((entry) => entry[0] !== "commit"),
    "nothing is committed from a stale snapshot");
  assert.ok(calls.every((entry) => entry[0] !== "unstage"),
    "and the unseen staged path is not reset either");
  assert.equal(document.querySelector('.dock-scm-commit input[aria-label="Summary"]').value,
    "Second commit");

  // 3. An unchecked path that IS staged is the one case a reset is required.
  calls.length = 0;
  fresh = repoStatus({
    files: [file("src/change.ts"), file("docs/notes.md", { index: "M", worktree: " " })],
  });
  await mountDock(fresh);
  await typeCommitMessage("Third commit");
  await act(async () => {
    rowCheckbox("docs/notes.md").click();
    await Promise.resolve();
  });
  await clickCommit();
  assert.deepEqual(calls, [
    ["status"],
    ["stage", ["src/change.ts"]],
    ["unstage", ["docs/notes.md"]],
    ["commit", "Third commit"],
  ], "only an explicitly unchecked, staged path leaves the index");
});

// contract.ts:1233-1238 — `gitCommitPaths` commits a pathspec, so git itself
// constrains the commit and every unrelated index entry survives untouched.
test("commit routes through gitCommitPaths instead of staging around the commit", async () => {
  installDom();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  const calls = [];
  const mounted = repoStatus({
    files: [file("src/change.ts"), file("docs/notes.md", { index: "M", worktree: " " })],
  });
  let fresh = mounted;
  window.confirm = () => true;
  window.mixdogDesktop = {
    gitStatus: async () => { calls.push(["status"]); return fresh; },
    gitStage: async (_cwd, paths) => { calls.push(["stage", [...paths].sort()]); },
    gitUnstage: async (_cwd, paths) => { calls.push(["unstage", [...paths].sort()]); },
    gitCommit: async (_cwd, message) => { calls.push(["commit", message]); return ""; },
    gitCommitPaths: async (_cwd, message, paths) => {
      calls.push(["commit-paths", message, [...paths].sort()]);
      return "";
    },
  };
  await mountDock(mounted);
  await typeCommitMessage("Ship the checked files");
  await act(async () => {
    rowCheckbox("docs/notes.md").click();
    await Promise.resolve();
  });
  await clickCommit();
  assert.deepEqual(calls, [
    ["status"],
    ["commit-paths", "Ship the checked files", ["src/change.ts"]],
  ], "the fresh read still happens, then ONE pathspec commit — no stage, no"
    + " unstage, and the unchecked staged path keeps its index entry");

  // Every abort condition survives the switch.
  calls.length = 0;
  await typeCommitMessage("Second commit");
  fresh = repoStatus({
    files: [file("src/change.ts"), file("secret/keys.env", { index: "A", worktree: " " })],
  });
  await clickCommit();
  assert.match(errorText(), /index changed outside this list/,
    "a staged path that was never on screen still aborts the commit");
  assert.ok(calls.every((entry) => entry[0] !== "commit-paths"));

  calls.length = 0;
  fresh = repoStatus({ operation: "merge" });
  await clickCommit();
  assert.match(errorText(), /Finish the in-progress merge before committing/);
  assert.ok(calls.every((entry) => entry[0] !== "commit-paths"));

  calls.length = 0;
  fresh = repoStatus({
    files: [
      file("src/change.ts"),
      file("src/merge.ts", { index: "U", worktree: "U", conflicted: true }),
    ],
  });
  await clickCommit();
  assert.match(errorText(), /Resolve 1 conflicted file before committing/);
  assert.ok(calls.every((entry) => entry[0] !== "commit-paths"));
  assert.equal(document.querySelector('.dock-scm-commit input[aria-label="Summary"]').value,
    "Second commit", "an aborted commit keeps the draft");
});

// The pathspec channel is strict (it re-reads status and refuses conflicts,
// operations and unknown paths on its own): its rejections must reach the user
// with the draft intact.
test("a rejected pathspec commit surfaces the reason and keeps the draft", async () => {
  installDom();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  const calls = [];
  window.confirm = () => true;
  window.mixdogDesktop = {
    gitStatus: async () => repoStatus(),
    gitCommitPaths: async () => {
      calls.push(["commit-paths"]);
      throw new Error("Not in this repository: src/change.ts. Refresh Source Control and try again.");
    },
  };
  await mountDock(repoStatus());
  await typeCommitMessage("Draft that must survive", "and its description");
  await clickCommit();
  assert.deepEqual(calls, [["commit-paths"]], "the commit was attempted exactly once");
  assert.match(errorText(), /Not in this repository: src\/change\.ts/,
    "the channel's own error text reaches the user");
  assert.equal(document.querySelector('.dock-scm-commit input[aria-label="Summary"]').value,
    "Draft that must survive", "a failed commit never clears the summary");
  assert.equal(document.querySelector('.dock-scm-commit textarea[aria-label="Description"]').value,
    "and its description", "nor the description");
});

test("pathspec commits only ask consent for the partials they actually replace", async () => {
  installDom();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  const calls = [];
  const prompts = [];
  window.confirm = (message) => { prompts.push(message); return true; };
  // docs/notes.md is staged AND dirty (a partial), but it is UNCHECKED, so a
  // pathspec commit never touches it — asking about it would be a lie.
  const withPartials = repoStatus({
    files: [file("src/change.ts"), file("docs/notes.md", { index: "M", worktree: "M" })],
  });
  window.mixdogDesktop = {
    gitStatus: async () => withPartials,
    gitCommitPaths: async (_cwd, message, paths) => {
      calls.push(["commit-paths", message, [...paths].sort()]);
      return "";
    },
  };
  await mountDock(withPartials);
  await typeCommitMessage("Only the checked file");
  await act(async () => {
    rowCheckbox("docs/notes.md").click();
    await Promise.resolve();
  });
  await clickCommit();
  assert.deepEqual(prompts, [],
    "an unchecked staged partial is left alone, so it raises no prompt");
  assert.deepEqual(calls, [["commit-paths", "Only the checked file", ["src/change.ts"]]]);

  // A CHECKED partial is replaced by its worktree content, so it still asks.
  calls.length = 0;
  await typeCommitMessage("Replace the staged content");
  await act(async () => {
    rowCheckbox("docs/notes.md").click();
    await Promise.resolve();
  });
  assert.equal(rowCheckbox("docs/notes.md").checked, true);
  await clickCommit();
  assert.equal(prompts.length, 1, "the selected partial is confirmed, not assumed");
  assert.match(prompts[0], /staged changes that differ from the working tree/);
  assert.match(prompts[0], /docs\/notes\.md/);
});

test("the fresh read alone decides the selection, and rename halves must be seen", async () => {
  installDom();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  const calls = [];
  let fresh = repoStatus();
  window.confirm = () => true;
  window.mixdogDesktop = {
    gitStatus: async () => { calls.push(["status"]); return fresh; },
    gitCommitPaths: async (_cwd, message, paths) => {
      calls.push(["commit-paths", message, [...paths].sort()]);
      return "";
    },
  };
  await mountDock(repoStatus());
  await typeCommitMessage("Nothing left to commit");

  // 1. The worktree went clean between the poll and the commit.
  fresh = repoStatus({ files: [] });
  await clickCommit();
  assert.match(errorText(), /Select one or more files to commit/,
    "an empty FRESH selection aborts even though the stale list looked dirty");
  assert.ok(calls.every((entry) => entry[0] !== "commit-paths"));

  // 2. The fresh read turns the selected file into a rename whose OLD half was
  // never on screen — committing it would sweep in a recreated, unseen path.
  calls.length = 0;
  fresh = repoStatus({
    files: [file("src/change.ts", { index: "R", worktree: " ", oldPath: "secret/keys.env" })],
  });
  await clickCommit();
  assert.match(errorText(), /index changed outside this list/,
    "the unseen rename half aborts the commit");
  assert.match(errorText(), /secret\/keys\.env/, "and it is named");
  assert.ok(calls.every((entry) => entry[0] !== "commit-paths"),
    "nothing is committed from a rename the user never saw");

  // 3. The same rename IS committable once both halves were on screen.
  calls.length = 0;
  const renamed = repoStatus({
    files: [file("src/renamed.ts", { index: "R", worktree: " ", oldPath: "src/change.ts" })],
  });
  fresh = renamed;
  await mountDock(renamed);
  await typeCommitMessage("Commit the rename");
  await clickCommit();
  assert.deepEqual(calls, [
    ["status"],
    ["commit-paths", "Commit the rename", ["src/change.ts", "src/renamed.ts"]],
  ], "both halves of a SEEN rename commit together");
});

// The pathspec channel never touches the index around the commit, so the
// unseen-path rule can only be violated by the FALLBACK: it resets
// `pathsFor(file)` for every unchecked staged path. Only the legacy set is
// installed here (no gitCommitPaths) — the one channel that can mutate the
// index behind the checkboxes.
test("the fallback never resets the unseen old half of a staged rename", async () => {
  installDom();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  const calls = [];
  window.confirm = () => true;
  const onScreen = repoStatus({
    files: [file("src/change.ts"), file("docs/notes.md", { index: "M", worktree: " " })],
  });
  // The fresh read turns that unchecked staged path into a rename whose OLD
  // half was NEVER on screen: unstaging the pair would reset an unseen file.
  let fresh = repoStatus({
    files: [
      file("src/change.ts"),
      file("docs/notes.md", { index: "R", worktree: " ", oldPath: "secret/keys.env" }),
    ],
  });
  window.mixdogDesktop = {
    gitStatus: async () => { calls.push(["status"]); return fresh; },
    gitStage: async (_cwd, paths) => { calls.push(["stage", [...paths].sort()]); },
    gitUnstage: async (_cwd, paths) => { calls.push(["unstage", [...paths].sort()]); },
    gitCommit: async (_cwd, message) => { calls.push(["commit", message]); return ""; },
  };
  assert.equal(window.mixdogDesktop.gitCommitPaths, undefined,
    "this build has no pathspec commit, so the stage/unstage fallback runs");
  await mountDock(onScreen);
  await typeCommitMessage("Commit only what is checked");
  await act(async () => {
    rowCheckbox("docs/notes.md").click();
    await Promise.resolve();
  });
  await clickCommit();
  assert.match(errorText(), /index changed outside this list/,
    "the unseen old half of an unchecked staged rename aborts the commit");
  assert.match(errorText(), /secret\/keys\.env/, "and it is named");
  assert.deepEqual(calls, [["status"]],
    "nothing is staged, unstaged or committed: the unseen path keeps its index entry");

  // Once BOTH halves are on screen the same rename is reset as a pair and the
  // legacy commit runs exactly as before.
  calls.length = 0;
  const seenRename = repoStatus({
    files: [
      file("src/change.ts"),
      file("docs/renamed.md", { index: "R", worktree: " ", oldPath: "docs/notes.md" }),
    ],
  });
  fresh = seenRename;
  await mountDock(seenRename);
  await typeCommitMessage("Commit the seen rename");
  await act(async () => {
    rowCheckbox("docs/renamed.md").click();
    await Promise.resolve();
  });
  assert.equal(rowCheckbox("docs/renamed.md").checked, false,
    "the staged rename is the unchecked row of this commit");
  await clickCommit();
  assert.deepEqual(calls, [
    ["status"],
    ["stage", ["src/change.ts"]],
    ["unstage", ["docs/notes.md", "docs/renamed.md"]],
    ["commit", "Commit the seen rename"],
  ], "a SEEN rename is still kept out of the commit as a pair");
});

test("an incomplete Git API refuses the fallback commit instead of half-doing it", async () => {
  installDom();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  const calls = [];
  window.confirm = () => true;
  const staleStaged = repoStatus({
    files: [file("src/change.ts"), file("docs/notes.md", { index: "M", worktree: " " })],
  });
  // No gitCommitPaths (old preload) AND no gitUnstage: the fallback cannot
  // keep the unchecked staged path out of the commit, so it must not run.
  window.mixdogDesktop = {
    gitStatus: async () => staleStaged,
    gitStage: async (_cwd, paths) => { calls.push(["stage", [...paths].sort()]); },
    gitCommit: async (_cwd, message) => { calls.push(["commit", message]); return ""; },
  };
  await mountDock(staleStaged);
  await typeCommitMessage("Would drop a file");
  await act(async () => {
    rowCheckbox("docs/notes.md").click();
    await Promise.resolve();
  });
  await clickCommit();
  assert.deepEqual(calls, [],
    "nothing is staged and nothing is committed with a partial API");
  assert.match(errorText(), /Git commit API is incomplete/);
  assert.equal(document.querySelector('.dock-scm-commit input[aria-label="Summary"]').value,
    "Would drop a file", "the draft survives the refusal");

  // The complete fallback set still commits exactly as before.
  calls.length = 0;
  window.mixdogDesktop.gitUnstage = async (_cwd, paths) => {
    calls.push(["unstage", [...paths].sort()]);
  };
  await clickCommit();
  assert.deepEqual(calls, [
    ["stage", ["src/change.ts"]],
    ["unstage", ["docs/notes.md"]],
    ["commit", "Would drop a file"],
  ], "with gitStage + gitUnstage + gitCommit present the legacy path runs intact");
});

test("conflicts and in-progress operations block every commit entry point", async () => {
  installDom();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  const calls = [];
  const headerSlot = document.createElement("span");
  document.body.append(headerSlot);
  const conflicted = file("src/merge.ts", { index: "U", worktree: "U", conflicted: true });
  let fresh = repoStatus({ files: [file("src/change.ts"), conflicted] });
  window.confirm = () => true;
  window.mixdogDesktop = {
    gitStatus: async () => { calls.push(["status"]); return fresh; },
    gitStage: async (_cwd, paths) => { calls.push(["stage", [...paths].sort()]); },
    gitUnstage: async (_cwd, paths) => { calls.push(["unstage", [...paths].sort()]); },
    gitCommit: async (_cwd, message) => { calls.push(["commit", message]); return ""; },
  };

  await mountDock(repoStatus({ files: [file("src/change.ts"), conflicted] }), { headerSlot });
  await typeCommitMessage("Resolve later");
  const primary = document.querySelector('.dock-scm-commit-split > button[type="submit"]');
  assert.equal(primary.disabled, true, "an unresolved conflict blocks the commit button");
  assert.equal(primary.title, "Resolve conflicts before committing");
  assert.equal(rowCheckbox("src/merge.ts").disabled, true,
    "a conflicted row cannot be checked into a commit");
  assert.equal(document.querySelector('[aria-label="More commit actions"]'), null,
    "there is no second commit entry point that could slip past the guard");
  assert.equal(document.querySelector(".dock-scm-commit-menu"), null);

  // A conflict that only the FRESH read knows about still stops the commit,
  // and the conflicted path is never reset (that would resolve it to HEAD).
  calls.length = 0;
  await mountDock(repoStatus());
  await typeCommitMessage("Sneak past the conflict");
  fresh = repoStatus({ files: [file("src/change.ts"), conflicted] });
  await clickCommit();
  assert.match(errorText(), /Resolve 1 conflicted file before committing/);
  assert.ok(calls.every((entry) => entry[0] !== "commit"));
  assert.ok(calls.every((entry) => entry[0] !== "unstage"),
    "an unmerged path is never reset");

  // Same for an operation the snapshot has not caught up with yet.
  calls.length = 0;
  fresh = repoStatus({ operation: "merge" });
  await clickCommit();
  assert.match(errorText(), /Finish the in-progress merge before committing/);
  assert.ok(calls.every((entry) => entry[0] !== "commit"));

  // And when the snapshot itself reports the operation, the UI is already shut.
  await mountDock(repoStatus({ operation: "merge" }));
  await typeCommitMessage("During a merge");
  const blocked = document.querySelector('.dock-scm-commit-split > button[type="submit"]');
  assert.equal(blocked.disabled, true, "no commit while a merge is in progress");
  assert.equal(blocked.title, "Finish the in-progress Git operation first");
});

test("branch actions stay closed while a git operation is in progress", async () => {
  installDom();
  window.mixdogDesktop = {
    gitStatus: async () => repoStatus({ operation: "rebase" }),
    gitBranches: async () => [
      { name: "main", current: true, remote: false, upstream: "origin/main", lastCommitRelative: "2 days ago" },
      { name: "feature/x", current: false, remote: false, upstream: "", lastCommitRelative: "1 hour ago" },
    ],
    gitMergeBranch: async () => "",
    gitCreateBranch: async () => "",
    gitCheckoutBranch: async () => "",
  };
  await mountDock(repoStatus({ operation: "rebase" }));
  await act(async () => {
    document.querySelector(".dock-scm-branch-button").click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  const rows = [...document.querySelectorAll(".dock-scm-branch-main")];
  assert.ok(rows.length, "the branch panel still opens for inspection");
  assert.ok(rows.every((row) => row.disabled),
    "checkout is refused while an operation is in progress");
  const merge = document.querySelector(".dock-scm-merge-row");
  assert.equal(merge.disabled, true, "so is the merge action");
  assert.match(merge.title, /Finish the in-progress rebase first/);
  assert.equal(document.querySelector(".dock-scm-branch-new").disabled, true);
});

test("the push/pull ladder refuses rungs that cannot act", async () => {
  installDom();
  const calls = [];
  window.mixdogDesktop = {
    gitStatus: async () => repoStatus(),
    gitBranches: async () => [],
    gitPush: async () => { calls.push(["push"]); return ""; },
    gitFetch: async () => { calls.push(["fetch"]); return ""; },
  };

  await mountDock(repoStatus({ remote: false, upstream: false, upstreamName: "" }));
  const publish = document.querySelector(".dock-scm-remote-button");
  assert.equal(publish.getAttribute("aria-label"), "Publish repository");
  assert.equal(publish.disabled, true,
    "there is nothing to publish to without a remote, so the rung cannot fire");
  assert.equal(publish.title, "Add a remote before publishing this repository");
  await act(async () => {
    publish.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(calls, [], "a disabled rung never reaches git");

  // refs/github-desktop app/src/ui/toolbar/push-pull-button.tsx:541-555.
  await mountDock(repoStatus({ detached: true, upstream: false, upstreamName: "", ahead: 3 }));
  const detached = document.querySelector(".dock-scm-remote-button");
  assert.equal(detached.getAttribute("aria-label"), "Publish branch");
  assert.equal(detached.disabled, true);
  assert.equal(detached.title, "Cannot publish detached HEAD");

  await mountDock(repoStatus({
    detached: true,
    upstream: false,
    upstreamName: "",
    operation: "rebase",
  }));
  assert.equal(document.querySelector(".dock-scm-remote-button").title, "Rebase in progress");
});

test("unchecked paths that disappear come back checked", async () => {
  installDom();
  window.mixdogDesktop = { gitStatus: async () => repoStatus() };
  const withBoth = repoStatus({ files: [file("src/change.ts"), file("docs/notes.md")] });
  await mountDock(withBoth);
  await act(async () => {
    rowCheckbox("docs/notes.md").click();
    await Promise.resolve();
  });
  assert.equal(rowCheckbox("docs/notes.md").checked, false);

  // The file is discarded/committed elsewhere and the poll drops it…
  await mountDock(repoStatus({ files: [file("src/change.ts")] }));
  // …then it changes again and comes back.
  await mountDock(repoStatus({ files: [file("src/change.ts"), file("docs/notes.md")] }));
  assert.equal(rowCheckbox("docs/notes.md").checked, true,
    "a path that left the list returns in the default included state");
  assert.equal(document.querySelector(".dock-scm-check-all > span").textContent,
    "2 changed files");
});

test("overlays close on Escape and outside clicks and release their listeners", async () => {
  installDom();
  const listeners = new Map();
  const keyFor = (type, options) =>
    `${type}:${options === true || options?.capture === true}`;
  const nativeAdd = document.addEventListener.bind(document);
  const nativeRemove = document.removeEventListener.bind(document);
  document.addEventListener = (type, handler, options) => {
    listeners.set(keyFor(type, options), (listeners.get(keyFor(type, options)) || 0) + 1);
    nativeAdd(type, handler, options);
  };
  document.removeEventListener = (type, handler, options) => {
    listeners.set(keyFor(type, options), (listeners.get(keyFor(type, options)) || 0) - 1);
    nativeRemove(type, handler, options);
  };
  window.mixdogDesktop = {
    gitStatus: async () => repoStatus(),
    gitBranches: async () => [
      { name: "main", current: true, remote: false, upstream: "origin/main" },
    ],
    gitFetch: async () => "",
  };
  await mountDock(repoStatus());

  const openBranchPanel = async () => {
    await act(async () => {
      document.querySelector(".dock-scm-branch-button").click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  };
  await openBranchPanel();
  assert.ok(document.querySelector(".dock-scm-branch-picker"));
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".dock-scm-branch-picker"), null,
    "Escape closes the branch panel");

  await openBranchPanel();
  await act(async () => {
    document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".dock-scm-branch-picker"), null,
    "a click outside the panel closes it even though the panel is portaled");

  // The push/pull dropdown is gone, so it has no overlay to dismiss and no
  // listener to leak: nothing may re-introduce it.
  assert.equal(document.querySelector('[aria-label="More remote actions"]'), null,
    "the toolbar's remote dropdown trigger is deleted");
  assert.equal(document.querySelector(".dock-scm-remote-menu"), null,
    "and it can no longer open an overlay");

  // The commit split menu is gone too, so it has no overlay to dismiss and no
  // listener to leak either.
  await typeCommitMessage("Draft");
  assert.equal(document.querySelector('[aria-label="More commit actions"]'), null,
    "the commit split trigger is deleted");
  assert.equal(document.querySelector(".dock-scm-commit-menu"), null);

  // Row context menus follow the same dismissal grammar, on the same
  // listeners, and they replace the per-row "…" buttons entirely.
  const contextRow = document.querySelector(".dock-scm-file");
  const rightClick = () => contextRow.dispatchEvent(new window.MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: 40, clientY: 60,
  }));
  await act(async () => {
    rightClick();
    await Promise.resolve();
  });
  assert.ok(document.querySelector(".dock-scm-context-menu"),
    "the right button opens the row context menu");
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".dock-scm-context-menu"), null,
    "Escape closes a row context menu");
  await act(async () => {
    rightClick();
    await Promise.resolve();
  });
  await act(async () => {
    document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".dock-scm-context-menu"), null,
    "an outside click dismisses the row context menu");

  // Unmount with an overlay AND a context menu open: every document listener
  // must be released.
  await openBranchPanel();
  await act(async () => {
    rightClick();
    await Promise.resolve();
  });
  await act(async () => {
    root.render(null);
    await Promise.resolve();
  });
  const leaked = [...listeners.entries()].filter(([, count]) => count !== 0);
  assert.deepEqual(leaked, [],
    "unmounting removes every pointerdown/keydown listener the overlays added");
  document.addEventListener = nativeAdd;
  document.removeEventListener = nativeRemove;
});

// ── Row context menus ────────────────────────────────────────────────────────
// The per-row "…" overflow buttons are gone; the right button and the
// keyboard's context key open the reference menus instead.
const contextMenuItems = () =>
  [...document.querySelectorAll(".dock-scm-context-menu button")];
const contextMenuLabels = () => contextMenuItems().map((item) => item.textContent);
const contextItem = (label) => contextMenuItems().find((item) => item.textContent === label);

const openRowMenu = async (row, point = { clientX: 40, clientY: 90 }) => {
  await act(async () => {
    row.dispatchEvent(new window.MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, ...point,
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  const menu = document.querySelector('.dock-scm-context-menu[role="menu"]');
  assert.ok(menu, "the row answers the right button with a context menu");
  return menu;
};

const clickContextItem = async (label) => {
  const item = contextItem(label);
  assert.ok(item, `the context menu must expose "${label}"`);
  assert.equal(item.disabled, false, `"${label}" must be enabled to run`);
  await act(async () => {
    item.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  // A menu action runs through run(): status refresh, branch reload and the
  // history reload each need their own turn before the surface settles.
  await flush();
  await flush();
};

test("the changed-file context menu wires discard, ignore, copy, reveal and open", async () => {
  installDom();
  const calls = [];
  const copied = [];
  window.confirm = () => true;
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => { copied.push(text); } },
  });
  window.mixdogDesktop = {
    gitStatus: async () => repoStatus(),
    gitRevert: async (_cwd, path) => { calls.push(["discard", path]); },
    gitIgnore: async (_cwd, path, scope) => { calls.push(["ignore", path, scope]); },
    revealFile: async (_cwd, path) => { calls.push(["reveal", path]); },
    openFilePath: async (_cwd, path) => { calls.push(["open", path]); },
  };
  await mountDock(repoStatus({
    files: [file("src/change.ts"), file("README", { index: "?", worktree: "?", untracked: true })],
  }));

  const row = (path) => document
    .querySelector(`.dock-scm-file-main[title="${path}"]`).closest(".dock-scm-file");
  const menu = await openRowMenu(row("src/change.ts"));
  assert.equal(menu.getAttribute("aria-label"), "Actions for src/change.ts");
  assert.deepEqual(contextMenuLabels(), [
    "Discard changes…",
    "Ignore file (add to .gitignore)",
    "Ignore folder (add to .gitignore)",
    "Ignore all .ts files (add to .gitignore)",
    "Copy file path",
    "Copy relative file path",
    "Show in Explorer",
    "Open with default program",
  ]);
  // Nothing is blocked any more: gitIgnore takes `scope: 'extension'` and
  // writes the unanchored `*.ts` rule itself.
  assert.deepEqual(contextMenuItems().filter((item) => item.disabled)
    .map((item) => item.textContent), [],
    "every file entry this build has a channel for is enabled");
  // The separators keep the reference's four groups.
  assert.deepEqual(contextMenuItems()
    .filter((item) => item.classList.contains("menu-separator"))
    .map((item) => item.textContent), [
    "Ignore file (add to .gitignore)",
    "Copy file path",
    "Show in Explorer",
  ]);

  await clickContextItem("Copy file path");
  assert.deepEqual(copied.at(-1), "C:\\work\\project\\src\\change.ts",
    "Copy file path copies the ABSOLUTE path");
  await openRowMenu(row("src/change.ts"));
  await clickContextItem("Copy relative file path");
  assert.deepEqual(copied.at(-1), "src/change.ts");
  await openRowMenu(row("src/change.ts"));
  await clickContextItem("Show in Explorer");
  assert.deepEqual(calls.at(-1), ["reveal", "src/change.ts"]);
  await openRowMenu(row("src/change.ts"));
  await clickContextItem("Open with default program");
  assert.deepEqual(calls.at(-1), ["open", "src/change.ts"]);
  await openRowMenu(row("src/change.ts"));
  await clickContextItem("Ignore folder (add to .gitignore)");
  assert.deepEqual(calls.at(-1), ["ignore", "src", undefined],
    "Ignore folder adds the file's DIRECTORY");
  await openRowMenu(row("src/change.ts"));
  await clickContextItem("Ignore all .ts files (add to .gitignore)");
  assert.deepEqual(calls.at(-1), ["ignore", "src/change.ts", "extension"],
    "Ignore all <ext> files asks the main side for the unanchored `*<ext>` rule");
  await openRowMenu(row("src/change.ts"));
  await clickContextItem("Discard changes…");
  assert.deepEqual(calls.at(-1), ["discard", "src/change.ts"]);

  // A file at the repository root has no folder to ignore.
  await openRowMenu(row("README"));
  const rootFolder = contextItem("Ignore folder (add to .gitignore)");
  assert.equal(rootFolder.disabled, true);
  assert.match(rootFolder.title, /repository root/);
  // …and a file with no extension has no file TYPE to ignore either.
  const extensionless = contextItem("Ignore all extensionless files (add to .gitignore)");
  assert.equal(extensionless.disabled, true);
  assert.match(extensionless.title, /no extension/);

  // Keyboard parity: Shift+F10 and the Menu key open the same menu.
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".dock-scm-context-menu"), null);
  for (const event of [
    { key: "F10", shiftKey: true },
    { key: "ContextMenu", shiftKey: false },
  ]) {
    await act(async () => {
      row("src/change.ts").dispatchEvent(new window.KeyboardEvent("keydown", {
        ...event, bubbles: true, cancelable: true,
      }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    assert.ok(document.querySelector(".dock-scm-context-menu"),
      `${event.key} opens the row context menu without a pointer`);
    assert.equal(document.activeElement?.textContent, "Discard changes…",
      "the keyboard lands on the first enabled item");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(document.querySelector(".dock-scm-context-menu"), null,
      "Escape closes it again");
  }
});

// refs/github-desktop app/src/ui/history commit context menu.
test("the history commit context menu keeps every reference action, disabled where no channel exists", async () => {
  installDom();
  const copied = [];
  const opened = [];
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => { copied.push(text); } },
  });
  window.mixdogDesktop = {
    gitLog: async () => historyEntries,
    gitShow: async () => { throw new Error("the context menu must not open the commit"); },
    openExternal: async (url) => { opened.push(url); },
  };
  await mountDock(historyStatus);
  await selectHistoryTab();

  const row = document.querySelector(".dock-scm-history .dock-scm-commit-row");
  const menu = await openRowMenu(row);
  assert.equal(menu.getAttribute("aria-label"), "Actions for commit aaaaaaa");
  assert.equal(document.querySelector(".dock-scm-commit-detail"), null,
    "right-clicking a commit never opens the commit detail surface");
  assert.deepEqual(contextMenuLabels(), [
    "Amend commit…",
    "Undo commit…",
    "Reset to commit…",
    "Checkout commit",
    "Reorder commit",
    "Revert changes in commit",
    "Create branch from commit",
    "Create Tag…",
    "Delete tag",
    "Cherry-pick commit…",
    "Copy SHA",
    "Copy tag",
    "View on GitHub",
  ]);
  // Only what today's IPC surface can really do is enabled.
  assert.deepEqual(contextMenuItems().filter((item) => !item.disabled)
    .map((item) => item.textContent), ["Copy SHA", "View on GitHub"]);
  assert.match(contextItem("Delete tag").title, /gitLog answers[\s\S]*tags/,
    "without the per-entry tags payload the tag entries name what is missing");
  assert.ok(contextMenuItems().filter((item) => item.disabled)
    .every((item) => (item.title || "").length > 20),
    "every disabled entry explains which channel it is waiting for");

  await clickContextItem("Copy SHA");
  assert.deepEqual(copied, ["aaaaaaaaaaaa"], "Copy SHA copies the FULL hash");
  await openRowMenu(row);
  await clickContextItem("View on GitHub");
  assert.deepEqual(opened, ["https://github.com/example/project/commit/aaaaaaaaaaaa"]);

  // Keyboard parity, and a repository with no hosted remote disables the link.
  await act(async () => {
    row.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "ContextMenu", bubbles: true, cancelable: true,
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.ok(document.querySelector(".dock-scm-context-menu"),
    "the Menu key opens the commit menu too");
  assert.equal(document.querySelector(".dock-scm-commit-detail"), null);
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });

  await mountDock({ ...historyStatus, remoteUrl: "" });
  await selectHistoryTab();
  await openRowMenu(document.querySelector(".dock-scm-history .dock-scm-commit-row"));
  const link = contextItem("View on GitHub");
  assert.equal(link.disabled, true, "no hosted remote, no commit link");
  assert.match(link.title, /no hosted remote/);
});

// The main process landed the history channels (shared/contract.ts:1275-1282);
// every one of them is wired here, behind a confirmation that NAMES the commit.
test("the wired history actions confirm, name the commit and surface their failures", async () => {
  installDom();
  const calls = [];
  const asked = [];
  let promptAnswer = "";
  window.confirm = (message) => { asked.push(message); return true; };
  window.prompt = (message) => { asked.push(message); return promptAnswer; };
  window.mixdogDesktop = {
    gitStatus: async () => historyStatus,
    gitLog: async () => historyEntries,
    openExternal: async () => {},
    gitResetToCommit: async (_cwd, hash, mode) => { calls.push(["reset", hash, mode]); return ""; },
    gitRevertCommit: async (_cwd, hash) => { calls.push(["revert", hash]); return ""; },
    gitCherryPickCommit: async (_cwd, hash) => { calls.push(["cherry-pick", hash]); return ""; },
    gitCreateTag: async (_cwd, tag, hash) => { calls.push(["tag", tag, hash]); return ""; },
    gitDeleteTag: async (_cwd, tag) => { calls.push(["delete-tag", tag]); return ""; },
    gitCheckoutCommit: async (_cwd, hash) => { calls.push(["checkout-commit", hash]); return ""; },
    gitCreateBranchAtCommit: async (_cwd, branch, hash) => {
      calls.push(["branch-at", branch, hash]);
      return "";
    },
  };
  await mountDock(historyStatus);
  await selectHistoryTab();
  const commitRow = () => document.querySelector(".dock-scm-history .dock-scm-commit-row");
  const namesTheCommit = (message) => message.includes("aaaaaaa")
    && message.includes("Restore the history surface");

  await openRowMenu(commitRow());
  assert.deepEqual(
    contextMenuItems().filter((item) => item.disabled).map((item) => item.textContent),
    ["Amend commit…", "Undo commit…", "Reorder commit", "Delete tag", "Copy tag"],
    "with these channels present only Reorder (out of scope), the amend/undo pair"
    + " (no gitAmend / gitUndoLastCommit here) and the two tag-READING entries"
    + " (this fixture carries no `tags`) stay disabled");
  for (const label of ["Delete tag", "Copy tag"]) {
    assert.match(contextItem(label).title, /gitLog answers[\s\S]*tags/,
      `${label} names the payload it waits for`);
  }

  // Reset asks for the reference's MODE first, then confirms while naming the
  // commit and saying what --hard destroys.
  promptAnswer = "hard";
  await clickContextItem("Reset to commit…");
  assert.match(asked.at(-2), /soft[\s\S]*mixed[\s\S]*hard/,
    "the mode choice comes before anything runs");
  assert.ok(namesTheCommit(asked.at(-1)) && /--hard/.test(asked.at(-1))
    && /destroyed/.test(asked.at(-1)),
    `the reset confirmation names the commit and its cost: ${asked.at(-1)}`);
  assert.deepEqual(calls.at(-1), ["reset", "aaaaaaaaaaaa", "hard"]);

  // A mode that is not one of the three never reaches the channel.
  promptAnswer = "nuke";
  await openRowMenu(commitRow());
  await clickContextItem("Reset to commit…");
  assert.deepEqual(calls.at(-1), ["reset", "aaaaaaaaaaaa", "hard"], "no second reset ran");
  assert.match(errorText(), /not a reset mode/);

  for (const [label, expected] of [
    ["Revert changes in commit", ["revert", "aaaaaaaaaaaa"]],
    ["Cherry-pick commit…", ["cherry-pick", "aaaaaaaaaaaa"]],
    ["Checkout commit", ["checkout-commit", "aaaaaaaaaaaa"]],
  ]) {
    await openRowMenu(commitRow());
    await clickContextItem(label);
    assert.ok(namesTheCommit(asked.at(-1)), `${label} confirms while naming the commit`);
    assert.deepEqual(calls.at(-1), expected);
  }
  assert.match(asked.at(-1), /DETACHED/, "checkout says HEAD is left detached");

  promptAnswer = "v1.2.3";
  await openRowMenu(commitRow());
  await clickContextItem("Create Tag…");
  assert.ok(namesTheCommit(asked.at(-1)), "the tag prompt names the commit it tags");
  assert.deepEqual(calls.at(-1), ["tag", "v1.2.3", "aaaaaaaaaaaa"]);

  promptAnswer = "feature/from-commit";
  await openRowMenu(commitRow());
  await clickContextItem("Create branch from commit");
  assert.deepEqual(calls.at(-1),
    ["branch-at", "feature/from-commit", "aaaaaaaaaaaa"]);

  // An empty name is refused instead of creating an unnamed ref.
  promptAnswer = "   ";
  await openRowMenu(commitRow());
  await clickContextItem("Create Tag…");
  assert.deepEqual(calls.at(-1), ["branch-at", "feature/from-commit", "aaaaaaaaaaaa"]);
  assert.match(errorText(), /tag name is required/);

  // A REFUSED action surfaces in the existing error banner and loses no state:
  // the history list and the selected surface survive it.
  window.mixdogDesktop.gitCherryPickCommit = async () => {
    throw new Error("cherry-pick failed: local changes would be overwritten");
  };
  await openRowMenu(commitRow());
  await clickContextItem("Cherry-pick commit…");
  assert.match(errorText(), /local changes would be overwritten/);
  assert.equal(document.querySelectorAll(".dock-scm-history .dock-scm-commit-row").length,
    historyEntries.length, "the history list is intact after the failure");
  await openRowMenu(commitRow());
  assert.equal(contextItem("Cherry-pick commit…").disabled, false,
    "and the menu is usable again");
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
});

test("history actions stay disabled, with a reason, while an operation owns the repo", async () => {
  installDom();
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  window.confirm = () => true;
  const wired = [
    "Reset to commit…",
    "Checkout commit",
    "Revert changes in commit",
    "Create branch from commit",
    "Create Tag…",
    "Cherry-pick commit…",
  ];
  window.mixdogDesktop = {
    gitStatus: async () => historyStatus,
    gitLog: async () => historyEntries,
    gitResetToCommit: async () => "",
    gitRevertCommit: async () => { await gate; return ""; },
    gitCherryPickCommit: async () => "",
    gitCreateTag: async () => "",
    gitCheckoutCommit: async () => "",
    gitCreateBranchAtCommit: async () => "",
  };
  // An in-progress merge blocks every one of them, naming the operation.
  await mountDock({ ...historyStatus, operation: "merge" });
  await selectHistoryTab();
  const commitRow = () => document.querySelector(".dock-scm-history .dock-scm-commit-row");
  await openRowMenu(commitRow());
  for (const label of wired) {
    const item = contextItem(label);
    assert.equal(item.disabled, true, `${label} is refused mid-merge`);
    assert.match(item.title, /Finish the in-progress merge first/);
  }
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });

  // And while one of them is still running, the rest say so too.
  await mountDock(historyStatus);
  await selectHistoryTab();
  await openRowMenu(commitRow());
  const revert = contextItem("Revert changes in commit");
  await act(async () => {
    revert.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await openRowMenu(commitRow());
  for (const label of wired) {
    const item = contextItem(label);
    assert.equal(item.disabled, true, `${label} waits for the running action`);
    assert.match(item.title, /Another Git action is running/);
  }
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    release();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await flush();
  await openRowMenu(commitRow());
  assert.equal(contextItem("Revert changes in commit").disabled, false,
    "the menu recovers once the action finishes");
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
});

// The main side REFUSES a dirty `--mixed` reset (git-cli.ts
// GIT_RESET_DIRTY_CODE) instead of unstaging uncommitted work in silence. That
// refusal IS the reference's WarningBeforeReset (app-store.ts:5839-5846), so it
// is shown as the warning and the confirmed reset comes back with the flag the
// main side waits for — without it the user confirms into the same refusal.
test("a dirty --mixed reset warns with the named files and retries with the confirmation", async () => {
  installDom();
  const calls = [];
  const asked = [];
  window.prompt = () => "mixed";
  window.confirm = (message) => { asked.push(message); return true; };
  const dirtyRefusal = () => {
    const refusal = new Error(
      "A --mixed reset rewrites the index, so resetting to aaaaaaaa unstages"
      + " uncommitted work: src/staged.ts, src/change.ts."
      + " Confirm the reset to run it anyway.");
    refusal.code = "git-reset-dirty-worktree";
    return refusal;
  };
  window.mixdogDesktop = {
    gitStatus: async () => historyStatus,
    gitLog: async () => historyEntries,
    gitResetToCommit: async (_cwd, hash, mode, confirmedDirty) => {
      calls.push(["reset", hash, mode, confirmedDirty]);
      if (mode === "mixed" && !confirmedDirty) throw dirtyRefusal();
      return "";
    },
  };
  await mountDock(historyStatus);
  await selectHistoryTab();
  const commitRow = () => document.querySelector(".dock-scm-history .dock-scm-commit-row");
  const resetOnce = async () => {
    await openRowMenu(commitRow());
    await clickContextItem("Reset to commit…");
  };

  await resetOnce();
  assert.deepEqual(calls, [
    ["reset", "aaaaaaaaaaaa", "mixed", false],
    ["reset", "aaaaaaaaaaaa", "mixed", true],
  ], "the confirmed reset carries confirmedDirty, so the main side stops asking");
  assert.match(asked.at(-1), /src\/staged\.ts/,
    "the warning NAMES the files the reset would unstage");
  assert.match(asked.at(-1), /aaaaaaa/, "and the commit it resets to");
  assert.equal(errorText(), "", "a confirmed reset is not reported as a failure");

  // A DECLINED warning leaves the repository exactly as it was.
  calls.length = 0;
  window.confirm = (message) => {
    asked.push(message);
    return !/rewrites the index/.test(message);
  };
  await resetOnce();
  assert.deepEqual(calls, [["reset", "aaaaaaaaaaaa", "mixed", false]],
    "a declined warning never retries the reset");

  // Anything that is not that refusal is a real Git failure: reported, never
  // retried behind a confirmation the user did not give for it.
  calls.length = 0;
  window.confirm = () => true;
  window.mixdogDesktop.gitResetToCommit = async (_cwd, hash, mode, confirmedDirty) => {
    calls.push(["reset", hash, mode, confirmedDirty]);
    throw new Error("fatal: ambiguous argument");
  };
  await resetOnce();
  assert.deepEqual(calls, [["reset", "aaaaaaaaaaaa", "mixed", false]],
    "a real failure is reported instead of being retried");
  assert.match(errorText(), /ambiguous argument/);
});

test("the context menu refuses cancelled, repeated and stale invocations", async () => {
  installDom();
  const calls = [];
  const asked = [];
  let answer = false;
  let releaseCherry = () => {};
  let releasePush = () => {};
  const cherryGate = new Promise((resolve) => { releaseCherry = resolve; });
  const pushGate = new Promise((resolve) => { releasePush = resolve; });
  window.confirm = (message) => { asked.push(message); return answer; };
  window.mixdogDesktop = {
    gitStatus: async () => historyStatus,
    gitLog: async () => historyEntries,
    gitRevertCommit: async (_cwd, hash) => { calls.push(["revert", hash]); return ""; },
    // Present so the FIRST entry of the menu is an enabled one — the keyboard
    // has to land on it.
    gitResetToCommit: async (_cwd, hash, mode) => { calls.push(["reset", hash, mode]); return ""; },
    gitCheckoutCommit: async (_cwd, hash) => { calls.push(["checkout-commit", hash]); return ""; },
    gitCherryPickCommit: async (_cwd, hash) => {
      calls.push(["cherry-pick", hash]);
      await cherryGate;
      return "";
    },
    gitPush: async () => { calls.push(["push"]); await pushGate; return ""; },
  };
  await mountDock(historyStatus);
  await selectHistoryTab();
  const commitRow = () => document.querySelector(".dock-scm-history .dock-scm-commit-row");

  // 1. A DECLINED confirmation runs nothing at all.
  await openRowMenu(commitRow());
  await clickContextItem("Revert changes in commit");
  assert.equal(asked.length, 1, "the destructive entry asked first");
  assert.deepEqual(calls, [], "and a declined confirmation never reaches git");

  // 2. The KEYBOARD path end to end: the Menu key opens the menu, the arrows
  // move inside it and the focused entry runs. (jsdom does not synthesize the
  // click a browser fires for Enter/Space on a focused button, so the
  // activation is that click.)
  answer = true;
  await act(async () => {
    commitRow().dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "ContextMenu", bubbles: true, cancelable: true,
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(document.activeElement?.textContent, "Reset to commit…",
    "the keyboard lands on the first enabled entry");
  const menu = document.querySelector('.dock-scm-context-menu[role="menu"]');
  await act(async () => {
    menu.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "ArrowDown", bubbles: true, cancelable: true,
    }));
    await Promise.resolve();
  });
  assert.equal(document.activeElement?.textContent, "Checkout commit",
    "ArrowDown walks past the entries that cannot run");
  await act(async () => {
    document.activeElement.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await flush();
  assert.deepEqual(calls.at(-1), ["checkout-commit", "aaaaaaaaaaaa"],
    "the keyboard-focused entry runs the same action the pointer does");
  assert.equal(document.querySelector(".dock-scm-context-menu"), null,
    "and the menu closes behind it");

  // 3. DOUBLE invocation: two activations before the first settles start ONE
  // cherry-pick, because the busy guard is re-read at EXECUTION time instead
  // of coming from the render that built the menu.
  await openRowMenu(commitRow());
  const cherry = contextItem("Cherry-pick commit…");
  await act(async () => {
    cherry.click();
    cherry.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(calls.filter((entry) => entry[0] === "cherry-pick").length, 1,
    "a second activation cannot start a second cherry-pick");
  await act(async () => {
    releaseCherry();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await flush();

  // 4. A menu that is ALREADY OPEN when the dock becomes busy must stop
  // offering its destructive entries instead of holding the stale snapshot.
  await openRowMenu(commitRow());
  await act(async () => {
    document.querySelector(".dock-scm-unpushed").click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(calls.at(-1), ["push"], "the push started while the menu was open");
  assert.equal(document.querySelector(".dock-scm-context-menu"), null,
    "the open menu closes when an action takes the repository");
  await openRowMenu(commitRow());
  const staleReset = contextItem("Reset to commit…");
  assert.equal(staleReset.disabled, true,
    "and a menu opened during that action carries no enabled destructive entry");
  assert.match(staleReset.title, /Another Git action is running/);
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    releasePush();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await flush();
});

/** A dock whose `status` prop really RE-READS the repository when the surface
 *  asks for a refresh — the poll's job in the app — so a failure that CHANGED
 *  the repository first can be observed as the surface catching up. */
const mountRefreshingDock = async (readStatus) => {
  const Live = () => {
    const [status, setStatus] = React.useState(readStatus());
    return React.createElement(SourceControlDock, {
      projectPath: "C:\\work\\project",
      status,
      statusReady: true,
      loading: false,
      statusError: "",
      onRefreshStatus: async () => { setStatus(readStatus()); },
      headerSlot: null,
      active: true,
      readinessKey: "source-control:C:\\work\\project",
      onReadyChange() {},
      onOpenFile() {},
      onOpenDiff() {},
    });
  };
  await act(async () => {
    root.render(React.createElement(Live));
    await Promise.resolve();
  });
};

// A revert or cherry-pick can apply its changes, hit conflicts and only THEN
// reject: the repository has moved even though the call failed.
test("a failure that already changed the repository refreshes the surface instead of leaving it stale", async () => {
  installDom();
  window.confirm = () => true;
  const conflicted = file("src/merge.ts", { index: "U", worktree: "U", conflicted: true });
  let repo = historyStatus;
  window.mixdogDesktop = {
    gitStatus: async () => repo,
    gitLog: async () => historyEntries,
    gitCherryPickCommit: async () => {
      // git applied the commit, stopped on a conflict and left the cherry-pick
      // in progress — THEN the channel rejects.
      repo = {
        ...historyStatus,
        operation: "cherry-pick",
        files: [...historyStatus.files, conflicted],
      };
      throw new Error("cherry-pick failed: conflicts in src/merge.ts");
    },
  };
  await mountRefreshingDock(() => repo);
  await selectHistoryTab();
  await openRowMenu(document.querySelector(".dock-scm-history .dock-scm-commit-row"));
  await clickContextItem("Cherry-pick commit…");

  assert.match(errorText(), /conflicts in src\/merge\.ts/,
    "the refusal is still reported");
  const banner = document.querySelector(".dock-scm-operation");
  assert.ok(banner, "the cherry-pick the failure left behind is announced without waiting for the poll");
  assert.match(banner.textContent, /cherry pick in progress/);
  assert.match(banner.textContent, /1 unresolved conflict/);
  assert.equal(document.querySelectorAll(".dock-scm-history .dock-scm-commit-row").length,
    historyEntries.length, "and the history list is intact");

  await act(async () => {
    reviewOption("Changes").click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.ok(document.querySelector('.dock-scm-file[data-conflicted="true"]'),
    "the conflicted file the failed cherry-pick created is in the list already");
});

// The dropdown (∨) beside the morphing Fetch/Pull/Push button is gone: Fetch IS
// the button on a level branch (the panel header pins the level-independent
// one), and the push rung the ladder loses to Pull stays reachable on the
// History rows.
test("no push/pull dropdown, and nothing it carried became unreachable", async () => {
  installDom();
  const calls = [];
  window.mixdogDesktop = {
    gitStatus: async () => historyStatus,
    gitLog: async () => historyEntries,
    gitFetch: async () => { calls.push(["fetch"]); return ""; },
    gitPull: async () => { calls.push(["pull"]); return ""; },
    gitPush: async () => { calls.push(["push"]); return ""; },
    gitSync: async () => { calls.push(["sync"]); return ""; },
  };
  const behindAndAhead = { ...historyStatus, ahead: 2, behind: 3 };
  await mountDock(behindAndAhead);

  assert.equal(document.querySelector(".dock-scm-remote-button > span")?.textContent,
    "Pull origin", "the button still morphs through the reference ladder");
  assert.equal(document.querySelector('[aria-label="More remote actions"]'), null);
  assert.equal(document.querySelector(".dock-scm-remote-more"), null);
  assert.equal(document.querySelector(".dock-scm-remote-menu"), null);
  assert.equal(document.querySelector(".dock-scm-header-fetch"), null,
    "and with no header slot the panel body grows no header control of its own");

  // Entry 1 — Fetch: the button itself, the moment the branch is level.
  await mountDock({ ...historyStatus, ahead: 0, behind: 0 });
  const levelButton = document.querySelector(".dock-scm-remote-button");
  assert.equal(levelButton.getAttribute("aria-label"), "Fetch origin");
  await act(async () => {
    levelButton.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(calls.at(-1), ["fetch"]);
  await mountDock(behindAndAhead);

  // Entry 2 — the losing Push: the unpushed history row pushes it.
  await selectHistoryTab();
  const unpushed = document.querySelector(".dock-scm-unpushed");
  assert.ok(unpushed, "an unpushed commit still carries the push action");
  assert.equal(unpushed.disabled, false);
  await act(async () => {
    unpushed.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(calls.at(-1), ["push"]);

  // …and back on Changes the toolbar still carries the ladder's own rung, with
  // its TEXT label and the ahead/behind count (no icon-only stub).
  await act(async () => {
    reviewOption("Changes").click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  const rung = document.querySelector(".dock-scm-remote-button");
  assert.equal(rung.querySelector(".dock-scm-remote-verb").textContent, "Pull");
  assert.equal(rung.querySelector(".dock-scm-ahead-behind").textContent, "23",
    "the ahead/behind count rides with the verb, exactly as before");
});

// refs/github-desktop app/styles/ui/changes/_commit-message.scss:4-13, 83-100,
// 196-250, 321-334 — the form's STRUCTURE, not just its fields.
test("the commit form separates summary and description in the reference's grammar", async () => {
  installDom();
  const calls = [];
  window.mixdogDesktop = {
    gitStatus: async () => repoStatus(),
    gitCommitPaths: async (_cwd, message, paths) => { calls.push(["commit", message, paths]); },
  };
  await mountDock(repoStatus());

  const form = document.querySelector("form.dock-scm-commit");
  assert.ok(form, "the commit form is the view stage's bottom region");
  const summaryField = form.querySelector('input[aria-label="Summary"]');
  assert.equal(summaryField.type, "text", "Summary is a REAL single-line input");
  assert.equal(summaryField.placeholder, "Summary (required)");
  // Native validation is OFF (noValidate): commit gating is the app's own
  // (commitBlocked), and with auto commit messages an empty summary is a
  // valid submit — the browser's off-theme balloon must never appear.
  assert.equal(summaryField.required, false);
  assert.equal(form.noValidate, true);
  const descriptionBox = form.querySelector(".dock-scm-commit-description-box");
  assert.ok(descriptionBox, "Description gets its own focus container");
  const descriptionField = descriptionBox.querySelector('textarea[aria-label="Description"]');
  assert.ok(descriptionField, "and the textarea lives INSIDE that container");
  assert.equal(descriptionField.placeholder, "Description");
  assert.equal(summaryField.closest(".dock-scm-commit-description-box"), null,
    "the two fields are not two identical boxes");
  assert.equal(descriptionBox.previousElementSibling, summaryField,
    "the description sits beneath the summary");

  const primary = form.querySelector('.dock-scm-commit-split > button[type="submit"]');
  assert.ok(primary.classList.contains("dock-scm-commit-button"));
  assert.equal(primary, form.querySelector(".dock-scm-commit-split").firstElementChild,
    "the full-width commit button leads the action row");
  assert.equal(primary.disabled, true, "a blank summary keeps it toned down");
  assert.match(primary.title, /summary is required/);

  await typeCommitMessage("Renew the commit form", "Body line");
  assert.equal(primary.disabled, false, "a summary lights it up");
  assert.equal(primary.textContent, "Commit 1 file to main",
    "the reference label survives the renewal");

  // Ctrl+Enter from either field still submits, and the message keeps the
  // summary + blank line + description shape.
  await act(async () => {
    descriptionField.focus();
    await Promise.resolve();
  });
  await act(async () => {
    descriptionField.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "Enter", ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await flush();
  assert.deepEqual(calls.at(-1),
    ["commit", "Renew the commit form\n\nBody line", ["src/change.ts"]]);
  assert.equal(document.querySelector('.dock-scm-commit input[aria-label="Summary"]').value, "",
    "the landed commit clears the draft");
  assert.equal(document.querySelector('[aria-label="More commit actions"]'), null,
    "the split chevron beside the full-width button is deleted");
  assert.equal(document.querySelectorAll(".dock-scm-commit-split > button").length, 1,
    "so the action row is a single, full-width commit button");
});

test("the branch row context menu checks out, renames, deletes and merges", async () => {
  installDom();
  const calls = [];
  window.confirm = () => true;
  window.prompt = () => "feature/renamed";
  window.mixdogDesktop = {
    gitStatus: async () => repoStatus(),
    gitBranches: async () => [
      { name: "main", current: true, remote: false, upstream: "origin/main" },
      { name: "feature/x", current: false, remote: false, upstream: "" },
    ],
    gitCheckoutBranch: async (_cwd, branch) => { calls.push(["checkout", branch]); return ""; },
    gitRenameBranch: async (_cwd, branch, next) => { calls.push(["rename", branch, next]); return ""; },
    gitDeleteBranch: async (_cwd, branch) => { calls.push(["delete", branch]); return ""; },
    gitMergeBranch: async (_cwd, branch) => { calls.push(["merge", branch]); return ""; },
  };
  await mountDock(repoStatus());

  const openPanel = async () => {
    // Only checkout and merge close the panel; reopening an OPEN one would
    // toggle it shut.
    if (document.querySelector(".dock-scm-branch-picker")) return;
    const trigger = document.querySelector(".dock-scm-branch-button");
    assert.equal(trigger.disabled, false, "the branch dropdown must be reachable");
    await act(async () => {
      trigger.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await flush();
  };
  const branchRow = (name) => {
    const rows = [...document.querySelectorAll(".dock-scm-branch-row")];
    const row = rows.find((node) =>
      node.querySelector(".dock-scm-branch-main span")?.textContent === name);
    assert.ok(row, `the branch panel must list ${name} (rows: ${rows.length}, picker: ${
      Boolean(document.querySelector(".dock-scm-branch-picker"))})`);
    return row;
  };
  await openPanel();

  // The right button must not dismiss the panel the row lives in.
  await act(async () => {
    branchRow("feature/x").dispatchEvent(new window.MouseEvent("pointerdown", {
      bubbles: true, cancelable: true, button: 2,
    }));
    await Promise.resolve();
  });
  assert.ok(document.querySelector(".dock-scm-branch-picker"),
    "a right-click keeps the branch panel open");
  await openRowMenu(branchRow("feature/x"));
  assert.deepEqual(contextMenuLabels(),
    ["Checkout", "Rename…", "Delete…", "Merge into main"]);
  assert.ok(contextMenuItems().every((item) => !item.disabled),
    "every branch action is wired to an existing channel");
  await clickContextItem("Checkout");
  assert.deepEqual(calls.at(-1), ["checkout", "feature/x"]);
  assert.equal(document.querySelector(".dock-scm-branch-picker"), null,
    "checkout closes the panel exactly like the row button");

  await openPanel();
  await openRowMenu(branchRow("feature/x"));
  await clickContextItem("Rename…");
  assert.deepEqual(calls.at(-1), ["rename", "feature/x", "feature/renamed"]);

  await openPanel();
  await openRowMenu(branchRow("feature/x"));
  await clickContextItem("Delete…");
  assert.deepEqual(calls.at(-1), ["delete", "feature/x"]);

  await openPanel();
  await openRowMenu(branchRow("feature/x"));
  await clickContextItem("Merge into main");
  assert.deepEqual(calls.at(-1), ["merge", "feature/x"]);

  // The checked-out branch cannot check itself out, delete itself or merge
  // into itself — each says so.
  await openPanel();
  await openRowMenu(branchRow("main"));
  for (const [label, reason] of [
    ["Checkout", /already checked out/],
    ["Delete…", /cannot be deleted/],
  ]) {
    const item = contextItem(label);
    assert.equal(item.disabled, true, `${label} is refused on the current branch`);
    assert.match(item.title, reason);
  }
  assert.equal(contextItem("Merge into main").disabled, true,
    "a branch cannot be merged into itself");
});

// The commit split menu is deleted; its entries moved where the reference
// keeps them: the stash pair on the changed-files header
// (filter-changes-list.tsx:549-556) and Amend / Undo on the history rows
// (commit-list.tsx:754-771).
test("the deleted commit menu's items live in the file-list header and the history rows", async () => {
  installDom();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  const calls = [];
  window.confirm = () => true;
  window.prompt = () => "wip";
  window.mixdogDesktop = {
    gitStatus: async () => repoStatus(),
    gitLog: async () => historyEntries,
    gitStash: async (_cwd, message) => { calls.push(["stash", message]); return ""; },
    gitStashPop: async () => { calls.push(["stash-pop"]); return ""; },
    gitAmend: async (_cwd, message) => { calls.push(["amend", message]); return ""; },
    gitUndoLastCommit: async () => { calls.push(["undo-commit"]); return ""; },
    gitPush: async () => { calls.push(["push"]); return ""; },
  };
  await mountDock(repoStatus());

  assert.equal(document.querySelector('[aria-label="More commit actions"]'), null,
    "the split trigger that carried them is deleted");
  assert.equal(document.querySelector(".dock-scm-commit-menu"), null);

  // Stash Changes / Pop Stash — the changed-files header's own actions.
  const headerAction = (label) => {
    const button = document.querySelector(`.dock-scm-list-actions [aria-label="${label}"]`);
    assert.ok(button, `the changed-files header must carry ${label}`);
    return button;
  };
  assert.equal(headerAction("Stash Changes").disabled, false);
  await act(async () => {
    headerAction("Stash Changes").click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(calls.at(-1), ["stash", "wip"]);
  assert.equal(headerAction("Pop Stash").disabled, false);
  await act(async () => {
    headerAction("Pop Stash").click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(calls.at(-1), ["stash-pop"]);

  // Amend / Undo — the MOST RECENT history row's context menu.
  await selectHistoryTab();
  const historyRow = (index) =>
    [...document.querySelectorAll(".dock-scm-history .dock-scm-commit-row")][index];
  await openRowMenu(historyRow(0));
  await clickContextItem("Amend commit…");
  assert.deepEqual(calls.at(-1), ["amend", undefined],
    "Amend keeps the reference's message semantics (no draft = keep the message)");
  await openRowMenu(historyRow(0));
  await clickContextItem("Undo commit…");
  assert.deepEqual(calls.at(-1), ["undo-commit"]);

  // Older commits still SEE both entries and are told why they are refused.
  await openRowMenu(historyRow(1));
  for (const [label, reason] of [
    ["Amend commit…", /most recent commit can be amended/],
    ["Undo commit…", /most recent commit can be undone/],
  ]) {
    assert.equal(contextItem(label).disabled, true, `${label} is refused off the tip`);
    assert.match(contextItem(label).title, reason);
  }
});

// gitLog now carries per-entry `tags` (contract.ts:975-981), so the two
// tag-reading entries name a real tag instead of waiting on the main side.
test("the history tag actions name the tag gitLog now carries", async () => {
  installDom();
  const calls = [];
  const copied = [];
  window.confirm = () => true;
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => { copied.push(text); } },
  });
  const tagged = historyEntries.map((entry, index) => index === 0
    ? { ...entry, tags: ["v1.2.0"], branches: ["main"], remotes: ["origin/main"] }
    : { ...entry, tags: [], branches: [], remotes: [] });
  window.mixdogDesktop = {
    gitStatus: async () => historyStatus,
    gitLog: async () => tagged,
    gitDeleteTag: async (_cwd, tag) => { calls.push(["delete-tag", tag]); return ""; },
  };
  await mountDock(historyStatus);
  await selectHistoryTab();
  const historyRow = (index) =>
    [...document.querySelectorAll(".dock-scm-history .dock-scm-commit-row")][index];

  await openRowMenu(historyRow(0));
  assert.ok(contextMenuLabels().includes("Delete tag v1.2.0"),
    "the entry NAMES the tag, exactly like commit-list.tsx:901-908");
  await clickContextItem("Copy tag");
  assert.deepEqual(copied.at(-1), "v1.2.0");
  await openRowMenu(historyRow(0));
  await clickContextItem("Delete tag v1.2.0");
  assert.deepEqual(calls.at(-1), ["delete-tag", "v1.2.0"]);

  // A commit whose tag list is EMPTY says so — that is not the older-host case.
  await openRowMenu(historyRow(1));
  assert.equal(contextItem("Delete tag").disabled, true);
  assert.match(contextItem("Delete tag").title, /no tag to delete/);
  assert.equal(contextItem("Copy tag").disabled, true);
  assert.match(contextItem("Copy tag").title, /no tag to copy/);
});

test("the panel header pins the Fetch the toolbar's rung cannot always offer", async () => {
  installDom();
  const headerSlot = document.createElement("span");
  document.body.append(headerSlot);
  window.mixdogDesktop = { gitStatus: async () => repoStatus(), gitFetch: async () => "" };
  await mountDock(repoStatus({ remote: false, upstream: false, upstreamName: "" }), { headerSlot });
  const headerButtons = [...headerSlot.querySelectorAll("button")];
  assert.equal(headerButtons.length, 1,
    "the header row carries exactly ONE action, the always-available Fetch");
  assert.equal(headerButtons[0].className, "dock-scm-header-fetch");
  assert.equal(headerButtons[0].disabled, true,
    "without a remote there is nothing to fetch from");
  assert.match(headerButtons[0].title, /Add a remote before fetching/);
  assert.equal(headerSlot.querySelector(".row-overflow-trigger"), null,
    "and no overflow menu came back with it");
  // The toolbar rung still explains itself instead of disappearing.
  const remote = document.querySelector(".dock-scm-remote-button");
  assert.equal(remote.getAttribute("aria-label"), "Publish repository");
  assert.equal(remote.disabled, true, "without a remote there is nothing to publish or fetch");
  assert.match(remote.title, /Add a remote/);
});

// The morphing rung only OFFERS Fetch on a level branch, so the header's Fetch
// is the one that is always there: same action, always the same verb, refused
// with a reason instead of disappearing.
test("the header Fetch fires the toolbar's fetch action and says why when it cannot", async () => {
  installDom();
  const calls = [];
  const headerSlot = document.createElement("span");
  headerSlot.className = "utility-dock-header-actions";
  document.body.append(headerSlot);
  let releaseFetch = () => {};
  window.mixdogDesktop = {
    gitStatus: async () => repoStatus(),
    gitFetch: async () => {
      calls.push(["fetch"]);
      await new Promise((resolve) => { releaseFetch = resolve; });
      return "";
    },
  };
  const headerFetch = () => headerSlot.querySelector(".dock-scm-header-fetch");

  // Behind AND ahead: the toolbar rung is Pull, so the header is the ONLY Fetch.
  await mountDock(repoStatus({ ahead: 2, behind: 3 }), { headerSlot });
  assert.equal(document.querySelector(".dock-scm-remote-button").getAttribute("aria-label"),
    "Pull origin", "the rung has morphed away from Fetch");
  const button = headerFetch();
  assert.ok(button, "the header keeps its Fetch whatever rung the ladder shows");
  assert.equal(button.tagName, "BUTTON", "it is a real, keyboard-reachable button");
  assert.equal(button.getAttribute("aria-label"), "Fetch from origin",
    "with an accessible name of its own, distinct from the toolbar rung's");
  assert.equal(button.disabled, false);
  await act(async () => {
    button.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(calls, [["fetch"]], "the header Fetch runs the toolbar's fetch action");
  // While that fetch is in flight a second one is refused, with the reason.
  assert.equal(headerFetch().disabled, true);
  assert.match(headerFetch().title, /Another Git action is running/);
  await act(async () => {
    releaseFetch();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(headerFetch().disabled, false, "and it comes back when the fetch lands");

  // The remaining refusals, each naming its own cause.
  for (const [overrides, reason] of [
    [{ remote: false, upstream: false, upstreamName: "" }, /Add a remote before fetching/],
    [{ operation: "cherry-pick" }, /Finish the in-progress cherry pick first/],
  ]) {
    await mountDock(repoStatus(overrides), { headerSlot });
    assert.equal(headerFetch().disabled, true);
    assert.match(headerFetch().title, reason);
    await act(async () => {
      headerFetch().click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  assert.deepEqual(calls, [["fetch"]], "a refused header Fetch never reaches git");
  assert.equal(headerSlot.querySelector(".row-overflow-trigger"), null,
    "and no … overflow menu came back with the control");
});

// The lists are WINDOWED (SourceControlDock.tsx `useRowWindow`): every entry is
// reached by SCROLLING, never by a `Show N more` / `Load more` button. jsdom has
// no layout engine, so the scroll containers' viewport is stubbed here — the
// same geometry scripts/scm-geometry-probe measures in real Chromium.
const SCM_FILE_ROW = 29;
const SCM_COMMIT_ROW = 46;

const stubScrollGeometry = ({ changes = 290, history = 300 } = {}) => {
  const tops = new WeakMap();
  Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      if (this.classList?.contains("dock-scm-scroll")) return changes;
      if (this.classList?.contains("dock-scm-history")) return history;
      return 0;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return tops.get(this) || 0; },
    set(value) { tops.set(this, Math.max(0, Number(value) || 0)); },
  });
  return async (node, top) => {
    await act(async () => {
      node.scrollTop = top;
      node.dispatchEvent(new window.Event("scroll"));
      await Promise.resolve();
    });
  };
};

const generatedFiles = (count) => Array.from({ length: count }, (_, index) =>
  file(`src/generated/file-${String(index).padStart(4, "0")}.ts`));
const fileRowFor = (path) => document
  .querySelector(`.dock-scm-file-main[title="${path}"]`)?.closest(".dock-scm-file");
const spacerHeight = (edge) => Number.parseFloat(
  document.querySelector(`.dock-scm-scroll [data-scm-spacer="${edge}"], `
    + `.dock-scm-history [data-scm-spacer="${edge}"]`)?.style.height || "0") || 0;
const loadMoreControls = () => [...document.querySelectorAll("button")]
  .filter((button) => /^(Show \d+ more|Load more)$/.test((button.textContent || "").trim()));

test("a large changed-file list scrolls to every row with only a window in the DOM", async () => {
  installDom();
  const scrollTo = stubScrollGeometry();
  window.mixdogDesktop = {};
  const files = generatedFiles(2_000);
  await mountDock(repoStatus({ files }));

  const list = document.querySelector(".dock-scm-scroll");
  const rowCount = () => document.querySelectorAll(".dock-scm-file").length;
  // Leading spacer + mounted rows + trailing spacer = the WHOLE list, so the
  // scrollbar length and every scroll position describe all 2000 files.
  const scrollHeight = () =>
    spacerHeight("leading") + rowCount() * SCM_FILE_ROW + spacerHeight("trailing");

  assert.equal(document.querySelector(".dock-scm-load-more"), null,
    "the paged `Show N more` control is gone");
  assert.deepEqual(loadMoreControls().map((button) => button.textContent), [],
    "no button stands between the user and the rest of the list");
  assert.equal(document.querySelector(".dock-scm-check-all span")?.textContent,
    "2000 changed files", "the select-all header still counts the whole set");
  assert.ok(rowCount() > 0 && rowCount() <= 40,
    `only a window of rows is mounted (${rowCount()} rows for 2000 files)`);
  assert.equal(scrollHeight(), 2_000 * SCM_FILE_ROW,
    "the spacers carry the height of every row that is not mounted");
  assert.ok(fileRowFor("src/generated/file-0000.ts"), "the list starts at its first row");

  await scrollTo(list, 1_000 * SCM_FILE_ROW);
  assert.ok(fileRowFor("src/generated/file-1000.ts"),
    "scrolling into the middle mounts the rows the viewport reaches");
  assert.equal(fileRowFor("src/generated/file-0000.ts"), undefined,
    "and unmounts the ones it left behind");
  assert.ok(rowCount() <= 40, `the window stays bounded while scrolling (${rowCount()})`);
  assert.equal(scrollHeight(), 2_000 * SCM_FILE_ROW);

  await scrollTo(list, 2_000 * SCM_FILE_ROW - 290);
  assert.ok(fileRowFor("src/generated/file-1999.ts"),
    "the LAST changed file is reachable by scrolling alone");
  assert.ok(rowCount() <= 40, `the end of the list is a window too (${rowCount()})`);
  assert.equal(scrollHeight(), 2_000 * SCM_FILE_ROW);
  assert.deepEqual(loadMoreControls().map((button) => button.textContent), []);

  // The filter still works on the whole set, and returns the list to its top.
  const filter = document.querySelector('input[aria-label="Filter changed files"]');
  await act(async () => {
    filter.value = "file-1234";
    filter.dispatchEvent(new window.Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  assert.deepEqual([...document.querySelectorAll(".dock-scm-file-main")]
    .map((row) => row.getAttribute("title")), ["src/generated/file-1234.ts"],
    "the filter searches every file, not just the mounted window");
  assert.equal(list.scrollTop, 0, "a new filter returns the list to its top");
});

test("selection, focus and the context menu survive row recycling", async () => {
  installDom();
  const calls = [];
  window.confirm = () => true;
  const scrollTo = stubScrollGeometry();
  const files = generatedFiles(500);
  window.mixdogDesktop = {
    gitStatus: async () => repoStatus({ files }),
    gitRevert: async (_cwd, path) => { calls.push(["discard", path]); },
    gitIgnore: async () => {},
    revealFile: async () => {},
    openFilePath: async () => {},
  };
  await mountDock(repoStatus({ files }));
  const list = document.querySelector(".dock-scm-scroll");
  await scrollTo(list, 400 * SCM_FILE_ROW);

  const path = "src/generated/file-0405.ts";
  const row = fileRowFor(path);
  assert.ok(row, "a row deep in the list is mounted once scrolled to");

  // Checkbox selection on a RECYCLED row drives the same tri-state header.
  const box = row.querySelector(".dock-scm-file-check");
  assert.equal(box.checked, true, "changed files start included");
  await act(async () => {
    box.click();
    await Promise.resolve();
  });
  assert.equal(fileRowFor(path).querySelector(".dock-scm-file-check").checked, false);
  const checkAll = document.querySelector('.dock-scm-check-all input[type="checkbox"]');
  assert.equal(checkAll.checked, false);
  assert.equal(checkAll.indeterminate, true,
    "unchecking one recycled row leaves the select-all row MIXED");
  assert.match(document.querySelector(".dock-scm-commit-button").textContent,
    /Commit 499 files to/, "the commit button counts the whole set, not the window");

  // Focus does not move when the window slides under it.
  const main = fileRowFor(path).querySelector(".dock-scm-file-main");
  main.focus();
  await scrollTo(list, 400 * SCM_FILE_ROW + SCM_FILE_ROW * 2);
  assert.equal(document.activeElement, main,
    "recycling never steals focus from the row the user is on");
  assert.equal(document.activeElement.getAttribute("title"), path,
    "and the focused row still describes the same file");

  // Right-click AND the keyboard's context key still open the row's menu.
  const menu = await openRowMenu(fileRowFor(path));
  assert.equal(menu.getAttribute("aria-label"), `Actions for ${path}`);
  assert.ok(contextMenuLabels().includes("Discard changes…"));
  await clickContextItem("Discard changes…");
  assert.deepEqual(calls, [["discard", path]],
    "the menu acts on the recycled row's own file");

  await act(async () => {
    fileRowFor(path).dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "ContextMenu", bubbles: true, cancelable: true,
    }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector('.dock-scm-context-menu[role="menu"]')
    ?.getAttribute("aria-label"), `Actions for ${path}`,
    "keyboard invocation opens the same menu on a recycled row");
});

test("the history list fetches its next page from the scroll position", async () => {
  installDom();
  const scrollTo = stubScrollGeometry();
  const requests = [];
  const commits = Array.from({ length: 120 }, (_, index) => ({
    hash: `${String(index).padStart(4, "0")}aaaaaaaaaaaa`,
    shortHash: `${String(index).padStart(4, "0")}aaa`,
    subject: `Commit number ${index}`,
    author: "Mixdog",
    when: `${index + 1} minutes ago`,
    parents: [],
    refs: [],
    tags: [],
    pushed: true,
  }));
  window.mixdogDesktop = {
    gitLog: async (_cwd, _query, skip = 0, limit = 40) => {
      requests.push([skip, limit]);
      return commits.slice(skip, skip + limit);
    },
  };
  await mountDock(historyStatus);
  await selectHistoryTab();

  const list = document.querySelector(".dock-scm-history");
  const rows = () => [...document.querySelectorAll(".dock-scm-history .dock-scm-commit-row")];
  const historyScrollHeight = (loaded) =>
    spacerHeight("leading") + rows().length * SCM_COMMIT_ROW + spacerHeight("trailing")
      === loaded * SCM_COMMIT_ROW;

  assert.deepEqual(requests, [[0, 40]], "the first page is one gitLog call");
  assert.deepEqual(loadMoreControls().map((button) => button.textContent), [],
    "the `Load more` button is gone");
  assert.ok(rows().length > 0 && rows().length <= 20,
    `only a window of commits is mounted (${rows().length} of 40)`);
  assert.ok(historyScrollHeight(40), "the spacers carry the loaded commits' height");

  // Scrolling towards the end — not a button — asks for the next page.
  await scrollTo(list, 40 * SCM_COMMIT_ROW - 300);
  await flush();
  assert.deepEqual(requests, [[0, 40], [40, 40]],
    "the next page is fetched from the scroll position");
  assert.equal(rows().length <= 20, true, "the window stays bounded as pages arrive");
  assert.ok(historyScrollHeight(80), "and the spacers grow with the loaded set");
  assert.deepEqual(loadMoreControls().map((button) => button.textContent), []);

  await scrollTo(list, 80 * SCM_COMMIT_ROW - 300);
  await flush();
  assert.deepEqual(requests, [[0, 40], [40, 40], [80, 40]]);

  // The end of the loaded set is reachable by scrolling alone, and asking one
  // page past it settles the list.
  await scrollTo(list, 120 * SCM_COMMIT_ROW - 300);
  await flush();
  assert.ok(rows().some((row) => (row.getAttribute("title") || "") === "Commit number 119"),
    "the last loaded commit is reachable by scrolling");
  assert.deepEqual(requests, [[0, 40], [40, 40], [80, 40], [120, 40]],
    "one request past the end settles it; an exhausted history never loops");
  // The exhausted list stops asking, however far it is scrolled.
  await scrollTo(list, 120 * SCM_COMMIT_ROW);
  await flush();
  assert.deepEqual(requests, [[0, 40], [40, 40], [80, 40], [120, 40]],
    "an exhausted history never asks again");

  // The search box still resets the list, on the same 180ms debounce.
  const search = document.querySelector('input[aria-label="Search commits"]');
  await act(async () => {
    search.value = "number 1";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  assert.deepEqual(requests.at(-1), [120, 40], "the search waits out its debounce");
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  });
  await flush();
  assert.deepEqual(requests.at(-1), [0, 40],
    "a settled search re-reads the history from the top");
  assert.equal(list.scrollTop, 0, "and returns the list to its first commit");
});
