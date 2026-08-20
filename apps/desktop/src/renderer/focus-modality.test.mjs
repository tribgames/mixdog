// A focus frame belongs to the keyboard. The root carries the modality of the
// last interaction, so the stylesheet can drop button rings that a mouse press
// would otherwise leave behind once the window hands focus back.
import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><button>tool</button></body></html>", {
  url: "https://mixdog.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { focusModality, installFocusModality } = await import("./focus-modality.ts");

const root = dom.window.document.documentElement;
const button = dom.window.document.querySelector("button");
const press = () => button.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
const key = (init) => button.dispatchEvent(
  new dom.window.KeyboardEvent("keydown", { bubbles: true, ...init }),
);

test("the pointer owns the quiet state and the keyboard restores the ring", () => {
  const uninstall = installFocusModality();
  try {
    assert.equal(root.getAttribute("data-mx-input"), "pointer");

    key({ key: "Tab" });
    assert.equal(focusModality(), "keyboard");
    assert.equal(root.getAttribute("data-mx-input"), "keyboard");

    press();
    assert.equal(focusModality(), "pointer");
    assert.equal(root.getAttribute("data-mx-input"), "pointer");

    // Typing prose is not focus navigation, and a chord is a shortcut: neither
    // may re-arm a ring on the control the pointer just used.
    key({ key: "a" });
    key({ key: "Tab", ctrlKey: true });
    assert.equal(root.getAttribute("data-mx-input"), "pointer");

    key({ key: "ArrowDown" });
    assert.equal(root.getAttribute("data-mx-input"), "keyboard");
  } finally {
    uninstall();
  }
  assert.equal(root.hasAttribute("data-mx-input"), false);
});

test("an uninstalled tracker stops marking the root", () => {
  installFocusModality()();
  press();
  key({ key: "Tab" });
  assert.equal(root.hasAttribute("data-mx-input"), false);
});
