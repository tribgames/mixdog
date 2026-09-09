import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useComposerFocus } from "./use-composer-focus.ts";

test("native window restoration focuses the active composer without stealing other input or dialog focus", async () => {
  const dom = new JSDOM("<!doctype html><body><input id='user'><main></main></body>", { url: "https://mixdog.test/" });
  const saved = { window: globalThis.window, document: globalThis.document,
    HTMLElement: globalThis.HTMLElement, Element: globalThis.Element,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Electron", maxTouchPoints: 0 } });
  window.mixdogDesktop = {};
  window.matchMedia = () => ({ matches: false });
  dom.window.HTMLElement.prototype.attachEvent = () => {};
  dom.window.HTMLElement.prototype.detachEvent = () => {};
  let focused = true;
  document.hasFocus = () => focused;
  const root = createRoot(document.querySelector("main"));
  function Harness(props) {
    const textarea = useRef(null);
    useComposerFocus({ textarea, ...props });
    return React.createElement("textarea", { ref: textarea });
  }
  const render = async (props) => {
    await act(async () => { root.render(React.createElement(Harness, props)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  };
  try {
    const user = document.getElementById("user");
    user.focus();
    await render({ paneActive: false, transitioning: false, focusRequest: 1 });
    assert.equal(document.activeElement, user);
    await render({ paneActive: true, transitioning: false, focusRequest: 1 });
    assert.equal(document.activeElement, user);
    focused = false;
    await render({ paneActive: true, transitioning: false, focusRequest: 2 });
    assert.equal(document.activeElement, user);
    focused = true;
    window.dispatchEvent(new dom.window.Event("focus"));
    await render({ paneActive: true, transitioning: false, focusRequest: 2 });
    assert.equal(document.activeElement, user);
    await render({ paneActive: true, transitioning: false, focusRequest: 3 });
    assert.equal(document.activeElement.tagName, "TEXTAREA");
    const composer = document.activeElement;
    composer.blur();
    window.dispatchEvent(new dom.window.Event("focus"));
    await render({ paneActive: true, transitioning: false, focusRequest: 3 });
    assert.equal(document.activeElement, composer);

    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    composer.blur();
    window.dispatchEvent(new dom.window.Event("focus"));
    await render({ paneActive: true, transitioning: false, focusRequest: 3 });
    assert.equal(document.activeElement, document.body);
    dialog.remove();

    await render({ paneActive: false, transitioning: false, focusRequest: 3 });
    window.dispatchEvent(new dom.window.Event("focus"));
    await render({ paneActive: false, transitioning: false, focusRequest: 3 });
    assert.equal(document.activeElement, document.body);

    await render({ paneActive: true, transitioning: true, focusRequest: 3 });
    composer.blur();
    window.dispatchEvent(new dom.window.Event("focus"));
    await render({ paneActive: true, transitioning: true, focusRequest: 3 });
    assert.equal(document.activeElement, document.body);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, saved);
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  }
});
