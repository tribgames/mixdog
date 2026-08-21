import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://mixdog.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;

let visibilityState = "visible";
Object.defineProperty(dom.window.document, "visibilityState", {
  configurable: true,
  get: () => visibilityState,
});

const { installMotionVisibility } = await import("./motion-visibility.ts");
const root = dom.window.document.documentElement;

test("foreground lifecycle signals release a missed mobile animation pause", () => {
  const uninstall = installMotionVisibility();
  try {
    assert.equal(root.dataset.mixdogMotion, "running");

    visibilityState = "hidden";
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    assert.equal(root.dataset.mixdogMotion, "paused");

    visibilityState = "visible";
    window.dispatchEvent(new dom.window.Event("pageshow"));
    assert.equal(root.dataset.mixdogMotion, "running");

    visibilityState = "hidden";
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    visibilityState = "visible";
    window.dispatchEvent(new dom.window.Event("focus"));
    assert.equal(root.dataset.mixdogMotion, "running");
  } finally {
    uninstall();
  }
  assert.equal(root.dataset.mixdogMotion, undefined);
});

test("an uninstalled tracker no longer changes the motion state", () => {
  installMotionVisibility()();
  visibilityState = "hidden";
  document.dispatchEvent(new dom.window.Event("visibilitychange"));
  assert.equal(root.dataset.mixdogMotion, undefined);
});
