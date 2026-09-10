import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import i18n, { initUiLanguage, getUiLanguagePreference, setUiLanguagePreference, t, tExisting, uiFormatLocale } from "./i18n";
import { installAutoDomI18n } from "./auto-dom-i18n";
import { SourceControlViewControls } from "./SourceControlViewControls";
import { SourceControlCommitForm } from "./SourceControlCommitForm";
import { createAppSideViewDescriptors } from "./app-side-view-descriptors";
import { desktopSlashCommandDescription, SLASH_COMMANDS } from "./slash-commands";
import { partialStagingWarning, resetModePrompt } from "./source-control-confirmations";
import { translateNativeUi } from "../shared/native-ui";
import { SUPPORTED_UI_LANGUAGES, UI_LANGUAGE_STORAGE_KEY, uiLanguageForLocale, selectUiLanguage } from "../shared/ui-language";
import { formatTokenCount, formatWorkElapsed } from "./transcript-primitives";
import { goalCompletedTimeLabel } from "./session-goal-presentation";
import { uiCurrency } from "./ui-format";
import { memoryCacheStorage } from "./sw-test-harness.mjs";
import { UI_LANGUAGE_ENTRY, APP_STATE_CACHE_NAME } from "./push-notification-bridge";

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
          branch: "feature/Changes", busy: "", commitBlocked: true,
          conflictCount: 0, description: "",
          detached: false, fileCount: 3, selectedFileCount: 3, summary: "",
          onCommit: noop, onDescriptionChange: noop, onSummaryChange: noop,
        }),
      ));
      assert.equal(document.querySelectorAll(".dock-scm-tab-label")[1].textContent, catalog.History, language);
      assert.equal(document.querySelector("input[type=search]").placeholder, catalog.Filter, language);
      assert.equal(document.querySelector(".dock-scm-commit-summary").placeholder, catalog["Summary (required)"], language);
      const commit = document.querySelector("button[type=submit]");
      const category = new Intl.PluralRules(language).select(3);
      assert.equal(commit.textContent, catalog[`Commit {{count}} files to {{branch}}_${category}`]
        .replace("{{count}}", "3").replace("{{branch}}", "feature/Changes"), language);
      assert.equal(commit.title, catalog["Summary (required)"], language);
      assert.equal(createAppSideViewDescriptors(noop).get("source-control").label, catalog["Source Control"], language);
      assert.equal(createAppSideViewDescriptors(noop).get("session-diff").label, catalog.Changes, language);
      assert.equal(desktopSlashCommandDescription(SLASH_COMMANDS[0]), catalog["Start a fresh chat"], language);
    }
  } finally { close(); }
});

test("project names remain literal in lists and editor titles during automatic translation", async () => {
  const close = browser();
  let stop;
  try {
    await i18n.changeLanguage("ko");
    document.body.innerHTML = `
      <div class="projects-row-label"><b>Homepage</b><small>C:\\Project\\Homepage</small></div>
      <section class="projects-edit-dialog"><h2>Homepage</h2><button>Save</button></section>
      <label>Homepage</label>`;
    stop = installAutoDomI18n();
    assert.equal(document.querySelector(".projects-row-label b").textContent, "Homepage");
    assert.equal(document.querySelector("h2").textContent, "Homepage");
    assert.equal(document.querySelector("button").textContent, "저장");
    assert.equal(document.querySelector("label").textContent, "홈페이지");
    document.querySelector(".projects-row-label b").textContent = "Settings";
    document.querySelector("h2").textContent = "Settings";
    await tick();
    assert.equal(document.querySelector(".projects-row-label b").textContent, "Settings");
    assert.equal(document.querySelector("h2").textContent, "Settings");
  } finally {
    stop?.();
    close();
  }
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

test("locale selection honors scripts, preference validity and the ordered system languages", () => {
  for (const [locale, expected] of [
    ["zh-Hans-HK", "zh-CN"], ["zh_Hant_CN", "zh-TW"], ["zh-MO", "zh-TW"],
    ["  pt_PT  ", "pt-BR"], ["de-CH", "de"], ["unsupported", null],
  ]) assert.equal(uiLanguageForLocale(locale), expected, locale);
  assert.equal(selectUiLanguage("ja", ["ko-KR"]), "ja");
  assert.equal(selectUiLanguage("broken", ["xx-ZZ", "fr-CA", "ko"]), "fr");
  assert.equal(selectUiLanguage("system", ["xx"]), "en");
});

test("a failed catalog load resets a previous language and publishes the actual English fallback", async (context) => {
  const close = browser();
  const previousCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const caches = memoryCacheStorage();
  Object.defineProperty(globalThis, "caches", { value: caches, configurable: true });
  context.mock.method(console, "warn", () => {});
  try {
    await i18n.changeLanguage("ko");
    setUiLanguagePreference("de");
    await initUiLanguage(async () => { throw new Error("offline catalog"); });
    assert.equal(t("History"), "History");
    assert.equal(document.documentElement.lang, "en");
    assert.equal(uiFormatLocale(), "en");
    assert.equal(await (await caches.peek(APP_STATE_CACHE_NAME).match(UI_LANGUAGE_ENTRY)).text(), "en");
    assert.equal(getUiLanguagePreference(), "de", "the saved choice survives a transient network failure");
  } finally {
    if (previousCaches) Object.defineProperty(globalThis, "caches", previousCaches);
    else delete globalThis.caches;
    close();
  }
});

test("blocked preference storage reports failure rather than pretending a reload will retain the choice", () => {
  const close = browser();
  try {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, "ja");
    window.Storage.prototype.setItem = () => { throw new Error("storage denied"); };
    assert.equal(setUiLanguagePreference("ko"), false);
    assert.equal(getUiLanguagePreference(), "ja");
  } finally { close(); }
});

test("all UI languages format tokens, timestamps, durations and currency using the active catalog", async () => {
  const completedAt = Date.parse("2026-09-01T13:42:00Z");
  try {
    for (const { value: language } of SUPPORTED_UI_LANGUAGES) {
      await i18n.changeLanguage(language);
      const tokens = new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: 1 }).format(12_345);
      assert.equal(formatTokenCount(12_345), language === "en" ? tokens.toUpperCase() : tokens, language);
      assert.equal(goalCompletedTimeLabel({ status: "complete", completedAt }),
        new Date(completedAt).toLocaleTimeString(language, { timeStyle: "short" }), language);
      assert.equal(formatWorkElapsed(5000),
        new Intl.NumberFormat(language, { style: "unit", unit: "second", unitDisplay: "narrow", useGrouping: false }).format(5), language);
      assert.equal(uiCurrency(1234.5, 2), new Intl.NumberFormat(language, {
        style: "currency", currency: "USD", currencyDisplay: "narrowSymbol",
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      }).format(1234.5), language);
    }
  } finally { await i18n.changeLanguage("en"); }
});

test("counted UI text follows locale plural categories while preserving interpolated identifiers", async () => {
  try {
    await i18n.changeLanguage("en");
    assert.equal(t("{{count}} files", { count: 1 }), "1 file");
    assert.equal(t("{{count}} files", { count: 2 }), "2 files");
    assert.equal(tExisting("{{count}} lines", "1 line", { count: 1 }), "1 line");
    for (const [language, catalog] of catalogs) {
      await i18n.changeLanguage(language);
      for (const count of [0, 1, 2, 5, 21, 1.5]) {
        const category = new Intl.PluralRules(language).select(count);
        const key = "Commit {{count}} files to {{branch}}";
        assert.equal(t(key, { count, branch: "feature/History<&>" }),
          catalog[`${key}_${category}`].replace("{{count}}", String(count)).replace("{{branch}}", "feature/History<&>"),
          `${language}/${count}`);
      }
    }
  } finally { await i18n.changeLanguage("en"); }
});

test("legacy accessibility attributes translate but queued user text and tooltips stay untouched", async () => {
  const close = browser();
  let stop;
  try {
    await i18n.changeLanguage("ko");
    document.body.innerHTML = '<img alt="History" aria-description="History">'
      + '<span class="queue-item-text" data-i18n-skip title="History">History</span>';
    stop = installAutoDomI18n();
    assert.equal(document.querySelector("img").alt, t("History"));
    assert.equal(document.querySelector("img").getAttribute("aria-description"), t("History"));
    const queued = document.querySelector("span");
    assert.equal(queued.title, "History");
    assert.equal(queued.textContent, "History");
  } finally { stop?.(); close(); await i18n.changeLanguage("en"); }
});
