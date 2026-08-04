import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React, { act } from "react";

import {
  cleanupDom,
  installDom,
  root,
} from "./renderer-dom-test-harness.mjs";

const {
  PullRequestEditor,
  PullRequestsPane,
  buildPullRequestCategories,
  buildPullRequestViews,
  pullRequestsWebUrl,
} = await import("./PullRequestsPane.tsx");
const { PR_CATEGORIES } = await import("../main/gh-cli.ts");

afterEach(cleanupDom);

const checks = { total: 0, passing: 0, failing: 0, pending: 0 };
const pullRequest = {
  number: 42,
  title: "Match the pull request view",
  author: "octocat",
  headRefName: "feature/pr-view",
  baseRefName: "main",
  isDraft: false,
  state: "OPEN",
  url: "https://github.com/example/project/pull/42",
  updatedAt: "2026-01-01T00:00:00Z",
  reviewDecision: "",
  checks,
};

test("PR categories follow the current VS Code extension order", () => {
  assert.deepEqual(PR_CATEGORIES.map((category) => category.label), [
    "Copilot on My Behalf",
    "Waiting For My Review",
    "Created By Me",
    "All Open",
  ]);
  const categories = PR_CATEGORIES.map((category) => ({
    key: category.key,
    label: category.label,
    prs: category.key === "all" ? [pullRequest] : [],
  }));
  const display = buildPullRequestCategories(categories, new Set(["feature/pr-view"]));
  assert.deepEqual(display.map((category) => category.label), [
    "Copilot on My Behalf",
    "Local Pull Request Branches",
    "Waiting For My Review",
    "Created By Me",
    "All Open",
  ]);
  assert.equal(display[1].prs[0]?.number, 42);
  const views = buildPullRequestViews(categories, new Set(["feature/pr-view"]));
  assert.deepEqual(views.open.map((entry) => entry.number), [42]);
  assert.deepEqual(views.mine.map((entry) => entry.number), [42],
    "local, authored, and Copilot categories collapse into one deduplicated Mine list");
  assert.deepEqual(views.review, []);
  assert.equal(pullRequestsWebUrl("https://github.com/example/project"), "https://github.com/example/project/pulls");
  assert.deepEqual(
    buildPullRequestCategories(categories.slice(1), new Set()).slice(0, 2).map((category) => category.label),
    ["Copilot on My Behalf", "Local Pull Request Branches"],
  );
});

test("PR view renders a shared search, compact scope selector, Desktop-style rows, and title actions", async () => {
  installDom();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  const headerSlot = document.createElement("span");
  headerSlot.className = "utility-dock-header-actions";
  document.body.append(headerSlot);
  window.mixdogDesktop = {
    ghPrList: async () => [
      { key: "copilot", label: "Copilot on My Behalf", prs: [] },
      { key: "review-requested", label: "Waiting For My Review", prs: [] },
      { key: "created", label: "Created By Me", prs: [] },
      { key: "all", label: "All Open", prs: [pullRequest] },
    ],
    ghPrDefaultBranch: async () => "main",
    gitBranches: async () => [{
      name: "feature/pr-view",
      current: false,
      remote: false,
      upstream: "",
    }],
    openExternal: async () => {},
    ghPrCheckout: async () => "",
  };
  const opened = [];
  await act(async () => {
    root.render(React.createElement(PullRequestsPane, {
      projectPath: "C:\\work\\project",
      prUrl: "https://github.com/example/project/compare/feature/pr-view?expand=1",
      repositoryUrl: "https://github.com/example/project",
      currentBranch: "main",
      createHint: "",
      headerSlot,
      onOpenPullRequest: (...args) => opened.push(args),
    }));
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.ok(headerSlot.querySelector('[aria-label="Create pull request"]'));
  assert.ok(headerSlot.querySelector('[aria-label="Refresh pull requests"]'));
  assert.ok(headerSlot.querySelector('[aria-label="More pull request actions"]'));
  assert.equal(document.querySelector(".dock-pr-toolbar"), null);
  const filterField = document.querySelector(
    '.dock-pr-view-controls .workbench-search-input input[aria-label="Filter pull requests"]');
  assert.ok(filterField, "Pull Requests reuses the workbench Search/SCM field grammar");
  const scopeField = document.querySelector('button[role="combobox"][aria-label="Pull request list"]');
  assert.ok(scopeField, "Open/Mine/Review use the shared portal selector");
  assert.equal(document.querySelector('select[aria-label="Pull request list"]'), null,
    "the panel never exposes Chromium's native select popup");
  assert.match(scopeField.textContent, /Open pull requests · 1/);
  assert.ok(document.querySelector(".dock-pr-results .dock-pr-row-icon .dock-pr-state-open"));
  assert.match(
    document.querySelector(".dock-pr-results .dock-pr-row-label small")?.textContent || "",
    /^#42\s+·.+· @octocat$/,
  );

  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
      .set.call(filterField, "does-not-exist");
    filterField.dispatchEvent(new window.Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".dock-pr-row"), null);
  assert.match(document.querySelector(".dock-pr-empty")?.textContent || "", /No matching pull requests/);
  await act(async () => {
    document.querySelector('[aria-label="Clear pull request filter"]').click();
    scopeField.click();
    await Promise.resolve();
    [...document.querySelectorAll('[role="option"]')]
      .find((option) => option.textContent.includes("Mine (1)")).click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".dock-pr-row-label b")?.textContent, pullRequest.title,
    "a local PR appears once in the deduplicated Mine list");
  await act(async () => {
    scopeField.click();
    await Promise.resolve();
    [...document.querySelectorAll('[role="option"]')]
      .find((option) => option.textContent.includes("Review (0)")).click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".dock-pr-row"), null);
  assert.match(document.querySelector(".dock-pr-empty")?.textContent || "",
    /No pull requests awaiting your review/);
  await act(async () => {
    scopeField.click();
    await Promise.resolve();
    [...document.querySelectorAll('[role="option"]')]
      .find((option) => option.textContent.includes("Open (1)")).click();
    await Promise.resolve();
  });

  await act(async () => {
    document.querySelector(".dock-pr-row-main")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.querySelector('[aria-label="Open changes for pull request 42"]')
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  assert.equal(opened.length, 2);
  assert.equal(opened[0][1].number, 42);
  assert.equal(opened[0][2], "overview");
  assert.equal(opened[1][2], "changes");
  assert.equal(document.querySelector(".dock-pr-detail"), null);
});

test("PR composer follows the Orca harness payload and never opens creation in a browser", async () => {
  installDom();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false }) });
  const headerSlot = document.createElement("span");
  document.body.append(headerSlot);
  const calls = [];
  const external = [];
  const created = { ...pullRequest, number: 73, title: "E2e secondary", headRefName: "e2e-secondary" };
  window.mixdogDesktop = {
    ghPrList: async () => [
      { key: "review-requested", label: "Waiting For My Review", prs: [] },
      { key: "created", label: "Created By Me", prs: [] },
      { key: "all", label: "All Open", prs: [] },
    ],
    ghPrDefaultBranch: async () => "main",
    gitBranches: async () => [
      { name: "main", current: false, remote: false, upstream: "" },
      { name: "e2e-secondary", current: true, remote: false, upstream: "" },
    ],
    gitPush: async () => { calls.push(["push"]); return ""; },
    ghPrCreate: async (_cwd, input) => { calls.push(["create", input]); return created; },
    openExternal: async (url) => { external.push(url); },
  };
  const opened = [];
  await act(async () => {
    root.render(React.createElement(PullRequestsPane, {
      projectPath: "C:\\work\\project",
      prUrl: "",
      repositoryUrl: "https://github.com/example/project",
      currentBranch: "e2e-secondary",
      createHint: "Publish the branch first.",
      headerSlot,
      onOpenPullRequest: (...args) => opened.push(args),
    }));
    await Promise.resolve();
    await Promise.resolve();
  });

  await act(async () => {
    headerSlot.querySelector('[aria-label="Create pull request"]').click();
    await Promise.resolve();
  });
  const title = document.querySelector('input[aria-label="Pull request title"]');
  const description = document.querySelector('textarea[aria-label="Pull request description"]');
  assert.equal(title.value, "E2e secondary");
  assert.equal(document.querySelector('button[aria-label="Pull request base branch"]')?.textContent.trim(), "main");
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")
      .set.call(description, "- Initial commit for E2E");
    description.dispatchEvent(new window.Event("input", { bubbles: true }));
    await Promise.resolve();
    document.querySelector('.dock-pr-create button[type="submit"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(calls, [
    ["push"],
    ["create", {
      base: "main",
      head: "e2e-secondary",
      title: "E2e secondary",
      body: "- Initial commit for E2E",
      draft: false,
    }],
  ]);
  assert.deepEqual(external, []);
  assert.equal(opened[0][1].number, 73);
  assert.equal(opened[0][2], "overview");
});

test("PR composer preserves fields and surfaces a create failure", async () => {
  installDom();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false }) });
  const headerSlot = document.createElement("span");
  document.body.append(headerSlot);
  window.mixdogDesktop = {
    ghPrList: async () => [{ key: "all", label: "All Open", prs: [] }],
    ghPrDefaultBranch: async () => "main",
    gitBranches: async () => [
      { name: "main", current: false, remote: false, upstream: "" },
      { name: "failure-branch", current: true, remote: false, upstream: "origin/failure-branch" },
    ],
    ghPrCreate: async () => { throw new Error("GitHub API rate limit exceeded"); },
  };
  await act(async () => {
    root.render(React.createElement(PullRequestsPane, {
      projectPath: "C:\\work\\project",
      prUrl: "https://github.com/example/project/compare/failure-branch",
      repositoryUrl: "https://github.com/example/project",
      currentBranch: "failure-branch",
      createHint: "",
      headerSlot,
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    headerSlot.querySelector('[aria-label="Create pull request"]').click();
    await Promise.resolve();
  });
  const title = document.querySelector('input[aria-label="Pull request title"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
      .set.call(title, "Failing PR from E2E");
    title.dispatchEvent(new window.Event("input", { bubbles: true }));
    await Promise.resolve();
    document.querySelector('.dock-pr-create button[type="submit"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(document.querySelector(".dock-pr-create-error")?.textContent || "", /rate limit exceeded/);
  assert.equal(title.value, "Failing PR from E2E");
  assert.ok(document.querySelector(".dock-pr-create"), "the failed draft remains mounted");
});

test("PR editor renders Orca-style metadata and Conversation/Checks/Files tabs", async () => {
  installDom();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  let viewCalls = 0;
  const opened = [];
  window.mixdogDesktop = {
    ghPrView: async () => {
      viewCalls += 1;
      return {
        ...pullRequest,
        body: "## Description\n\nEditor-style pull request overview.",
        additions: 8,
        deletions: 2,
        changedFiles: 1,
        files: [{ path: "src/pull-request.ts", additions: 8, deletions: 2 }],
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        createdAt: "2026-01-01T00:00:00Z",
        labels: ["ui"],
        timeline: [{
          author: "reviewer",
          body: "Looks good.",
          createdAt: "2026-01-02T00:00:00Z",
          state: "APPROVED",
        }],
        reviewers: [{ login: "reviewer", state: "APPROVED" }],
      };
    },
    ghPrDiff: async () => [
      "diff --git a/src/pull-request.ts b/src/pull-request.ts",
      "--- a/src/pull-request.ts",
      "+++ b/src/pull-request.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"),
    gitBranches: async () => [{ name: "main", current: true, remote: false, upstream: "" }],
    ghPrCheckout: async () => "",
    ghPrMerge: async () => "",
    openExternal: async (url) => { opened.push(url); },
  };
  await act(async () => {
    root.render(React.createElement(PullRequestEditor, {
      projectPath: "C:\\work\\project",
      number: 42,
      mode: "overview",
    }));
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.match(document.querySelector(".workspace-pr-editor-title-row h1")?.textContent || "",
    new RegExp(`${pullRequest.title}#42`));
  assert.equal(document.querySelector(".dock-pr-editor-meta .dock-pr-badge")?.textContent, "Open");
  assert.equal(document.querySelector(".dock-pr-editor-meta .dock-pr-refs")?.textContent,
    "main ← feature/pr-view");
  assert.deepEqual(
    [...document.querySelectorAll('[role="tablist"][aria-label="Pull request details"] [role="tab"]')]
      .map((tab) => [tab.dataset.prDetailTab, tab.getAttribute("aria-selected")]),
    [["conversation", "true"], ["checks", "false"], ["files", "false"]],
  );
  assert.equal(document.querySelector(".dock-pr-section > header b")?.textContent, "Conversation");
  assert.ok(document.querySelector(".dock-pr-body")?.textContent.includes("Description"));
  assert.ok(document.querySelector('button[aria-label="Refresh pull request"]'));

  await act(async () => {
    document.querySelector('[data-pr-detail-tab="checks"]').click();
    await Promise.resolve();
  });
  assert.ok(document.querySelector(".dock-pr-reviewer"));
  assert.equal(document.querySelector(".dock-pr-check-card > header b")?.textContent,
    "No checks reported");

  await act(async () => {
    document.querySelector('[data-pr-detail-tab="files"]').click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".dock-pr-files-summary b")?.textContent, "Files changed");
  // The changed-file rows carry the SAME status icon grammar as the Source
  // Control dock's two other file lists (iconForStatus, status.ts:16-37): a
  // patch with no `new file`/`deleted file`/`rename from` header is Modified.
  const prStatus = document.querySelector('[data-pr-detail-panel="files"] .dock-scm-status');
  assert.equal(prStatus?.getAttribute("data-status"), "modified");
  assert.equal(prStatus?.getAttribute("aria-label"), "Modified");
  assert.ok(prStatus?.querySelector("svg"), "the PR file status is an icon, not a letter");

  await act(async () => {
    document.querySelector(".dock-scm-commit-file-row")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  assert.ok(document.querySelector(".dock-scm-commit-diff"));

  await act(async () => {
    document.querySelector('button[aria-label="Open pull request on GitHub"]')
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.querySelector('button[aria-label="Refresh pull request"]')
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(opened, [pullRequest.url]);
  assert.equal(viewCalls, 2);
});
