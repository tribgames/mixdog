import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import i18n, { initUiLanguage, setUiLanguagePreference, t } from "./i18n";
import { installAutoDomI18n } from "./auto-dom-i18n";
import { SourceControlViewControls } from "./SourceControlViewControls";
import { SourceControlCommitForm } from "./SourceControlCommitForm";
import { createAppSideViewDescriptors } from "./app-side-view-descriptors";
import { desktopSlashCommandDescription, SLASH_COMMANDS } from "./slash-commands";
import { partialStagingWarning, resetModePrompt } from "./source-control-confirmations";
import { translateNativeUi } from "../shared/native-ui";
import { SUPPORTED_UI_LANGUAGES, uiLanguageForLocale } from "../shared/ui-language";

const catalogs = new Map(SUPPORTED_UI_LANGUAGES.filter(({ value }) => value !== "en").map(({ value }) => [
  value, JSON.parse(readFileSync(new URL(`./locales/${value}.json`, import.meta.url), "utf8")),
]));
for (const [language, catalog] of catalogs) i18n.addResourceBundle(language, "translation", catalog);
const noop = () => {};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function browser() {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://mixdog.test" });
  const globals = ["window", "document", "Node", "Element", "HTMLElement", "MutationObserver", "navigator", "React"];
  const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) Object.defineProperty(globalThis, key, {
    value: key === "React" ? React : dom.window[key], configurable: true, writable: true,
  });
  return () => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
}

test("all selectable languages render source control and slash labels without a DOM translation pass", async () => {
  const close = browser();
  try {
    for (const [language, catalog] of catalogs) {
      await i18n.changeLanguage(language);
      document.body.innerHTML = renderToStaticMarkup(React.createElement(React.Fragment, null,
        React.createElement(SourceControlViewControls, {
          fileCount: 3, fileFilter: "", historyQuery: "", view: "changes",
          onFileFilterChange: noop, onHistoryQueryChange: noop, onViewChange: noop,
        }),
        React.createElement(SourceControlCommitForm, {
          autoCommitMessage: true, branch: "feature/Changes", busy: "", commitBlocked: false,
          conflictCount: 0, conventionalWarning: false, description: "", descriptionPlaceholder: t("Description"),
          detached: false, fileCount: 3, selectedFileCount: 3, summary: "", summaryPlaceholder: t("Summary (required)"),
          onCommit: noop, onDescriptionChange: noop, onSummaryChange: noop,
        }),
      ));
      assert.equal(document.querySelectorAll(".dock-scm-tab-label")[1].textContent, catalog.History, language);
      assert.equal(document.querySelector("input[type=search]").placeholder, catalog.Filter, language);
      assert.equal(document.querySelector(".dock-scm-commit-summary").placeholder, catalog["Summary (required)"], language);
      const commit = document.querySelector("button[type=submit]");
      assert.equal(commit.textContent, catalog["Commit {{count}} files to {{branch}}"]
        .replace("{{count}}", "3").replace("{{branch}}", "feature/Changes"), language);
      assert.equal(commit.title, catalog["Commit with an auto-generated message"], language);
      assert.equal(createAppSideViewDescriptors(noop).get("source-control").label, catalog["Source Control"], language);
      assert.equal(createAppSideViewDescriptors(noop).get("session-diff").label, catalog.Changes, language);
      assert.equal(desktopSlashCommandDescription(SLASH_COMMANDS[0]), catalog["Start a fresh chat"], language);
    }
  } finally { close(); }
});

test("legacy translation handles dynamic text and subsequent React changes without touching user content", async () => {
  const close = browser();
  let stop;
  let root;
  try {
    await i18n.changeLanguage("ko");
    document.body.innerHTML = "<div id=root></div>";
    root = createRoot(document.querySelector("#root"));
    stop = installAutoDomI18n();
    const view = (line) => React.createElement(React.Fragment, null,
      React.createElement("span", { id: "line" }, `Ln ${line}`),
      React.createElement("span", { id: "partial" }, "Callers of ''"),
      React.createElement("span", { id: "template" }, "Pull feature/Changes"),
      React.createElement("code", { id: "code" }, "History"),
      React.createElement("span", { "data-i18n-skip": "", id: "name", title: "History" }, "History"),
      React.createElement("textarea", { placeholder: "Description", defaultValue: "Changes" }),
      React.createElement("div", { className: "transcript" }, "History"),
    );
    flushSync(() => root.render(view(42)));
    await tick();
    assert.equal(document.querySelector("#line").textContent, "42행");
    assert.equal(document.querySelector("#template").textContent, "feature/Changes Pull");
    assert.equal(document.querySelector("#partial").textContent, "'' 호출자");
    assert.equal(document.querySelector("#code").textContent, "History");
    assert.equal(document.querySelector("#name").textContent, "History");
    assert.equal(document.querySelector("#name").title, "History");
    assert.equal(document.querySelector("textarea").value, "Changes");
    assert.equal(document.querySelector("textarea").placeholder, "설명");
    assert.equal(document.querySelector(".transcript").textContent, "History");
    flushSync(() => root.render(view(43)));
    await tick();
    assert.equal(document.querySelector("#line").textContent, "43행");
  } finally {
    stop?.();
    if (root) flushSync(() => root.unmount());
    // React's scheduler can finish cleanup after the synchronous unmount.
    // Keep the isolated browser globals alive until that queue has drained.
    await new Promise((resolve) => setImmediate(resolve));
    await tick();
    close();
  }
});

test("selected language and regional aliases also resolve for native UI", async () => {
  const close = browser();
  try {
    setUiLanguagePreference("ja");
    await initUiLanguage();
    assert.equal(document.documentElement.lang, "ja");
    assert.equal(t("Sort by Status"), "状態で並べ替え");
    assert.equal(translateNativeUi("ja", "Browser Use approval"), "Browser Use の承認");
    assert.equal(uiLanguageForLocale("zh-Hant-HK"), "zh-TW");
    assert.equal(uiLanguageForLocale("pt-PT"), "pt-BR");
    assert.equal(translateNativeUi("en", "Allow this action once?"), "Allow this action once?");
    setUiLanguagePreference("en");
    await initUiLanguage();
    assert.equal(document.documentElement.lang, "en");
    assert.equal(t("History"), "History");
  } finally { close(); }
});

test("destructive-action warnings preserve paths, Git modes, and target identifiers", async () => {
  await i18n.changeLanguage("ko");
  const warning = partialStagingWarning([{ path: "History/Changes.ts" }]);
  assert.ok(warning.includes("History/Changes.ts"));
  assert.ok(warning.includes(t("Committing replaces that staged content with the full working-tree version. Continue?")));
  const reset = resetModePrompt("abc123");
  assert.ok(reset.includes("abc123"));
  for (const token of ["soft", "mixed", "hard"]) assert.ok(reset.includes(token));
  assert.ok(reset.includes(t("Move HEAD and DISCARD every change made after this commit.")));
});
