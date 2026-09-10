import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { SUPPORTED_UI_LANGUAGES, UI_LANGUAGE_STORAGE_KEY } from "../shared/ui-language";
import { generatedCatalogs } from "../../scripts/i18n/native-catalogs.mjs";

const source = readFileSync(new URL("./public/boot.js", import.meta.url), "utf8");

test("inlined recovery catalogs cannot break out of their script element", async () => {
  const payload = '</script><script>window.translationInjected = true</script>';
  const state = {
    catalogs: new Map([["en", { Recovery: payload }]]), nativeKeys: [], bootKeys: ["Recovery"],
  };
  const boot = [...generatedCatalogs(state)].find(([url]) => url.pathname.endsWith("/boot.js"))[1];
  const dom = new JSDOM(`<!doctype html><html><head><script>${boot}</script></head><body><div id="root"><main></main></div></body></html>`, {
    url: "https://mixdog.test", runScripts: "dangerously",
  });
  try {
    assert.equal(dom.window.translationInjected, undefined);
    assert.equal(dom.window.bootT("Recovery"), payload);
    // Let boot observe the mounted root and disconnect before closing its window.
    await Promise.resolve();
  } finally { dom.window.close(); }
});

function harness(installed = false, { language, systemLanguages } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    runScripts: "outside-only",
    url: "https://mixdog.test/",
  });
  const timers = [];
  const observers = [];
  const NativeMutationObserver = dom.window.MutationObserver;
  dom.window.MutationObserver = class extends NativeMutationObserver {
    constructor(callback) {
      super(callback);
      observers.push(this);
    }
  };
  const close = dom.window.close.bind(dom.window);
  dom.window.close = () => {
    for (const observer of observers) observer.disconnect();
    close();
  };
  if (installed) {
    Object.defineProperty(dom.window.navigator, "userAgent", { value: "iPhone" });
    Object.defineProperty(dom.window.navigator, "standalone", { value: true });
  }
  if (language) dom.window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language);
  if (systemLanguages) {
    Object.defineProperty(dom.window.navigator, "languages", { value: systemLanguages });
    Object.defineProperty(dom.window.navigator, "language", { value: systemLanguages[0] });
  }
  dom.window.setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  };
  dom.window.eval(source);
  return {
    dom,
    document: dom.window.document,
    run(delay) {
      const pending = timers.filter((timer) => timer.delay === delay);
      for (const timer of pending) {
        timers.splice(timers.indexOf(timer), 1);
        timer.callback();
      }
    },
  };
}

test("startup waits thirty seconds before offering retry and a later mount clears the dialog", async () => {
  const h = harness();
  try {
    h.run(7000);
    h.run(8000);
    assert.equal(h.document.querySelector('[role="alertdialog"]'), null);
    h.run(30000);
    const dialog = h.document.querySelector('[role="alertdialog"]');
    assert.match(dialog.textContent, /30 seconds/);
    assert.equal(dialog.querySelector("button").textContent, "Try again");
    assert.equal(dialog.querySelector("details").hidden, true);
    h.document.getElementById("root").append(h.document.createElement("main"));
    await Promise.resolve();
    assert.equal(h.document.querySelector('[role="alertdialog"]'), null);
  } finally { h.dom.window.close(); }
});

test("startup errors wait for the deadline, remain in collapsed details, and clear on recovery", async () => {
  const h = harness();
  try {
    h.dom.window.dispatchEvent(new h.dom.window.ErrorEvent("error", {
      message: "Failed to fetch dynamically imported module",
    }));
    h.run(400);
    assert.equal(h.document.querySelector('[role="alertdialog"]'), null);
    h.run(30000);
    const details = h.document.querySelector("details");
    assert.equal(details.hidden, false);
    assert.equal(details.open, false);
    assert.match(details.textContent, /Failed to fetch dynamically imported module/);
    h.document.getElementById("root").append(h.document.createElement("main"));
    await Promise.resolve();
    assert.equal(h.document.querySelector('[role="alertdialog"]'), null);
  } finally { h.dom.window.close(); }
});

test("late pairing UI replaces the timeout dialog without being covered again", async () => {
  const h = harness();
  try {
    h.run(30000);
    const pairing = h.document.createElement("section");
    pairing.id = "mixdog-remote-pairing";
    h.document.body.append(pairing);
    await Promise.resolve();
    assert.equal(h.document.querySelector('[role="alertdialog"]'), null);
    h.dom.window.dispatchEvent(new h.dom.window.ErrorEvent("error", { message: "offline" }));
    h.run(400);
    assert.equal(h.document.querySelector('[role="alertdialog"]'), null);
    assert.equal(pairing.isConnected, true);
  } finally { h.dom.window.close(); }
});

test("startup completing before the deadline never shows the timeout dialog", async () => {
  const h = harness();
  try {
    h.document.getElementById("root").append(h.document.createElement("main"));
    await Promise.resolve();
    h.run(30000);
    assert.equal(h.document.querySelector('[role="alertdialog"]'), null);
  } finally { h.dom.window.close(); }
});

test("installed iOS keeps the first-paint gate until the thirty-second fallback", () => {
  const h = harness(true);
  try {
    h.run(8000);
    assert.equal(h.document.documentElement.hasAttribute("data-mixdog-booting"), true);
    assert.equal(h.document.querySelector('[role="alertdialog"]'), null);
    h.run(30000);
    assert.equal(h.document.documentElement.hasAttribute("data-mixdog-booting"), false);
    assert.ok(h.document.querySelector('[role="alertdialog"]'));
  } finally { h.dom.window.close(); }
});

test("retry requests a page reload and Korean users receive a Korean dialog", () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  try {
    const timers = [];
    let reloads = 0;
    runInNewContext(source, {
      window: {
        addEventListener() {},
        location: { reload() { reloads += 1; } },
      },
      document: dom.window.document,
      navigator: { userAgent: "test", language: "ko-KR" },
      MutationObserver: dom.window.MutationObserver,
      setTimeout(callback, delay) { timers.push({ callback, delay }); },
    });
    timers.find((timer) => timer.delay === 30000).callback();
    const dialog = dom.window.document.querySelector('[role="alertdialog"]');
    assert.match(dialog.textContent, /연결이 지연되고 있습니다/);
    const retry = dialog.querySelector("button");
    assert.equal(retry.textContent, "다시 시도");
    retry.click();
    assert.equal(reloads, 1);
  } finally { dom.window.close(); }
});

test("recovery works in every selected language before application modules load", () => {
  for (const { value: language } of SUPPORTED_UI_LANGUAGES) {
    const catalog = language === "en" ? {} : JSON.parse(readFileSync(new URL(`./locales/${language}.json`, import.meta.url)));
    const h = harness(false, { language, systemLanguages: ["ko-KR"] });
    try {
      h.run(30000);
      const title = "Connection is taking longer than expected";
      assert.equal(h.document.documentElement.lang, language);
      assert.equal(h.document.querySelector("h2").textContent, catalog[title] || title, language);
      assert.equal(h.document.querySelector("button").textContent, catalog["Try again"] || "Try again", language);
    } finally { h.dom.window.close(); }
  }
});

test("boot ignores invalid saved preferences and honors explicit Chinese scripts", () => {
  for (const [systemLanguages, language] of [
    [["xx-ZZ", "ja-JP"], "ja"],
    [["zh-Hans-HK"], "zh-CN"],
    [["zh-Hant-CN"], "zh-TW"],
  ]) {
    const h = harness(false, { language: "invalid", systemLanguages });
    try {
      assert.equal(h.document.documentElement.lang, language);
    } finally { h.dom.window.close(); }
  }
});

test("the real pre-React installation guide uses early catalogs and treats translations as text", () => {
  const remoteSource = buildSync({
    entryPoints: [fileURLToPath(new URL("./remote-shim.ts", import.meta.url))],
    bundle: true, platform: "browser", format: "iife", write: false, logLevel: "silent",
  }).outputFiles[0].text;
  for (const { value: language } of SUPPORTED_UI_LANGUAGES) {
    const catalog = language === "en" ? {} : JSON.parse(readFileSync(new URL(`./locales/${language}.json`, import.meta.url)));
    const h = harness(false, { language });
    try {
      h.dom.window.TextEncoder = TextEncoder;
      h.dom.window.TextDecoder = TextDecoder;
      h.dom.window.eval(remoteSource);
      const heading = h.document.querySelector('[data-role="heading"]');
      const key = "Install Mixdog on your phone";
      assert.equal(heading?.textContent, catalog[key] || key, language);
      assert.equal(h.document.querySelector('[data-role="step-one"]').textContent,
        catalog["Open this page on your phone or tablet"] || "Open this page on your phone or tablet", language);
    } finally { h.dom.window.close(); }
  }
  const h = harness();
  try {
    h.dom.window.bootT = () => '<img src=x onerror="throw 1">';
    h.dom.window.eval(remoteSource);
    assert.equal(h.document.querySelector('[data-role="heading"]').textContent, '<img src=x onerror="throw 1">');
    assert.equal(h.document.querySelector("img[onerror]"), null);
  } finally { h.dom.window.close(); }
});
