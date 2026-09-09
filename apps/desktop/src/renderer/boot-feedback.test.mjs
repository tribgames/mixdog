import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";

const source = readFileSync(new URL("./public/boot.js", import.meta.url), "utf8");

function harness(installed = false) {
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
