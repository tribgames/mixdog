// ABB (Android back button) contract for the phone surface. Every transient
// layer registers here, so these are the rules the whole renderer depends on:
// back closes the TOPMOST layer only, a layer that closes itself consumes its
// own sentinel silently, and desktop surfaces never touch history at all.
import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://mixdog.test/",
});
dom.window.document.documentElement.setAttribute("data-mixdog-mobile-tabs", "");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.history = dom.window.history;

const { registerMobileBack } = await import("./mobile-back.ts");

/** jsdom traverses history on its own event loop, so a fixed tick is not a
 *  synchronisation point: wait for the popstate the traversal actually
 *  delivers, one more tick so the module's own listener runs first. */
function afterPopState(trigger) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dom.window.removeEventListener("popstate", once);
      reject(new Error("popstate never arrived"));
    }, 2_000);
    function once() {
      clearTimeout(timer);
      dom.window.removeEventListener("popstate", once);
      setTimeout(resolve, 0);
    }
    dom.window.addEventListener("popstate", once);
    trigger();
  });
}

/** No traversal is expected: give one a chance to arrive and report it. */
function quietWindow(trigger) {
  return new Promise((resolve) => {
    let seen = 0;
    const count = () => { seen += 1; };
    dom.window.addEventListener("popstate", count);
    trigger();
    setTimeout(() => {
      dom.window.removeEventListener("popstate", count);
      resolve(seen);
    }, 200);
  });
}

test("hardware back closes the topmost layer, one layer per press", async () => {
  const closed = [];
  registerMobileBack(() => closed.push("sheet"));
  registerMobileBack(() => closed.push("pane"));

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ["pane"]);

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ["pane", "sheet"]);
});

test("a layer that closes itself consumes only its own sentinel", async () => {
  const closed = [];
  registerMobileBack(() => closed.push("dialog"));
  const releaseMenu = registerMobileBack(() => closed.push("menu"));

  // The select inside the dialog closed through the UI: its sentinel must go
  // away quietly instead of closing the dialog underneath it.
  await afterPopState(() => releaseMenu());
  assert.deepEqual(closed, []);

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ["dialog"]);
});

test("a replacement layer opened before the cleanup pop keeps its sentinel", async () => {
  const closed = [];
  const releaseMenu = registerMobileBack(() => closed.push("menu"));

  await afterPopState(() => {
    releaseMenu();
    registerMobileBack(() => closed.push("settings"));
  });
  assert.deepEqual(closed, []);

  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ["settings"]);
});

test("releasing an entry the back button already consumed is a no-op", async () => {
  const closed = [];
  const release = registerMobileBack(() => closed.push("sheet"));
  await afterPopState(() => dom.window.history.back());
  assert.deepEqual(closed, ["sheet"]);

  const length = dom.window.history.length;
  assert.equal(await quietWindow(() => release()), 0);
  assert.equal(dom.window.history.length, length);
});

test("desktop surfaces never arm a sentinel", () => {
  const root = dom.window.document.documentElement;
  root.removeAttribute("data-mixdog-mobile-tabs");
  try {
    const length = dom.window.history.length;
    const release = registerMobileBack(() => {
      throw new Error("a desktop layer must never be closed by history");
    });
    assert.equal(dom.window.history.length, length);
    release();
  } finally {
    root.setAttribute("data-mixdog-mobile-tabs", "");
  }
});
