import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

import React, { act, useLayoutEffect } from "react";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://mixdog.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// React DOM detects input-event support at import time.
const { createRoot } = await import("react-dom/client");
dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  if (this.classList.contains("main-panel")) {
    return { x: 0, y: 20, left: 0, top: 20, right: 1000, bottom: 720, width: 1000, height: 700 };
  }
  if (this.classList.contains("session-browser-slot")) {
    return {
      x: 80,
      y: 40,
      left: 80,
      top: 40,
      right: 720,
      bottom: 520,
      width: 640,
      height: 480,
      toJSON() { return this; },
    };
  }
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON() { return this; },
  };
};

// Apply styles when their owning module imports them, not by preloading the
// lazy browser stylesheet. This exercises the cold host's real CSS boundary.
const cssLoader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.endsWith(".css")) return nextResolve(specifier, context);
    const css = readFileSync(new URL(specifier, context.parentURL), "utf8");
    const source = `const style = document.createElement("style");
      style.textContent = ${JSON.stringify(css)};
      document.head.append(style);`;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});
const {
  SessionBrowserParkingHost,
  SessionBrowserSlot,
  useSessionBrowserSurfaces,
} = await import("./session-browser-surfaces.tsx");
cssLoader.deregister();
const { sessionSideDockEntryForSession } =
  await import("./session-side-surface-policy.ts");

const renderFixture = (props) => React.createElement("div", {
  className: "browser-surface-fixture",
  "data-active": props.active ? "true" : "false",
  "data-foreground": props.foreground ? "true" : "false",
  "data-parked": props.parked ? "true" : "false",
}, React.createElement("button", {
  onClick: props.onToggleExpanded,
  "aria-label": props.expanded ? "Restore browser" : "Expand browser",
}, "size"));

let browserController;

test("a cold background browser is outside shell flow before its lazy body loads", async () => {
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  let controller;
  const renderColdBody = () => null;
  function ColdHarness() {
    controller = useSessionBrowserSurfaces(renderColdBody);
    return React.createElement(React.Fragment, null,
      React.createElement("textarea", { "aria-label": "Foreground composer", defaultValue: "draft" }),
      React.createElement(SessionBrowserParkingHost, { controller }));
  }
  try {
    await act(async () => root.render(React.createElement(ColdHarness)));
    const composer = host.querySelector("textarea");
    composer.focus();
    composer.setSelectionRange(2, 4);
    await act(async () => controller.ensure("background"));
    const surface = host.querySelector(".session-browser-surface-container");
    const style = window.getComputedStyle(surface);
    assert.equal(surface.childElementCount, 0, "the lazy browser body has not mounted");
    assert.equal(window.getComputedStyle(surface.parentElement).display, "contents");
    assert.equal(style.position, "fixed", "the parked page must not consume foreground layout space");
    assert.equal(style.pointerEvents, "none");
    assert.equal(style.zIndex, "-1");
    assert.equal(surface.style.width, "1280px", "background pages retain their own viewport");
    assert.equal(surface.style.height, "900px");
    await act(async () => controller.setRemoteViewed("background", true));
    assert.equal(window.getComputedStyle(surface).position, "fixed");
    assert.equal(window.getComputedStyle(surface).opacity, "0.02");
    assert.equal(document.activeElement, composer);
    assert.equal(composer.value, "draft");
    assert.deepEqual([composer.selectionStart, composer.selectionEnd], [2, 4]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

function Harness({ show }) {
  const controller = useSessionBrowserSurfaces(renderFixture);
  browserController = controller;
  useLayoutEffect(() => {
    controller.ensure("alpha");
  }, [controller]);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(SessionBrowserParkingHost, { controller }),
    show
      ? React.createElement(SessionBrowserSlot, {
          controller,
          sessionId: "alpha",
          active: true,
          foreground: true,
        })
      : null,
  );
}

test("an unloaded parked browser drops its display and recreates only when its slot becomes active", async () => {
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Harness, { show: true })));
    const old = host.querySelector(".session-browser-surface-container");
    assert.ok(old);
    await act(async () => root.render(React.createElement(Harness, { show: false })));
    await act(async () => browserController.release("alpha"));
    assert.equal(host.querySelector(".session-browser-surface-container"), null);
    await act(async () => root.render(React.createElement(Harness, { show: true })));
    const restored = host.querySelector(".session-browser-surface-container");
    assert.ok(restored);
    assert.notEqual(restored, old);
    assert.equal(restored.dataset.parked, "false");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

const paneBrowserEntry = {
  open: true,
  view: "sourceControl",
  surface: "browser",
  diff: null,
};

function SessionSwitchHarness({ sessionId, revealedSessions }) {
  const controller = useSessionBrowserSurfaces(renderFixture);
  const entry = sessionSideDockEntryForSession(
    paneBrowserEntry,
    sessionId,
    revealedSessions ? "browser" : null,
  );
  const browserActive = entry.open && entry.surface === "browser";
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(SessionBrowserParkingHost, { controller }),
    React.createElement(SessionBrowserSlot, {
      controller,
      sessionId,
      active: browserActive,
      foreground: browserActive,
    }),
  );
}

test("one session browser root moves between parking and dock without replacement", async () => {
  const host = document.createElement("main");
  host.className = "main-panel";
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Harness, { show: false })));
    const container = document.querySelector(".session-browser-surface-container");
    assert.ok(container);
    assert.ok(container.parentElement.classList.contains("session-browser-parking-host"));
    assert.equal(container.querySelector(".browser-surface-fixture").dataset.parked, "true");

    await act(async () => root.render(React.createElement(Harness, { show: true })));
    assert.equal(document.querySelector(".session-browser-surface-container"), container);
    assert.ok(container.parentElement.classList.contains("session-browser-parking-host"));
    assert.equal(container.dataset.parked, "false");
    assert.equal(container.style.left, "80px");
    assert.equal(container.style.width, "640px");
    assert.equal(container.querySelector(".browser-surface-fixture").dataset.active, "true");
    assert.equal(container.querySelector(".browser-surface-fixture").dataset.foreground, "true");
    const page = container.querySelector(".browser-surface-fixture");
    await act(async () => container.querySelector("button").click());
    assert.equal(container.style.width, "1000px");
    assert.equal(container.style.height, "700px");
    assert.equal(container.style.top, "20px");
    assert.equal(container.querySelector(".browser-surface-fixture"), page);
    assert.equal(container.querySelector("button").getAttribute("aria-label"), "Restore browser");
    await act(async () => container.querySelector("button").click());
    assert.equal(container.style.width, "640px");
    assert.equal(container.style.height, "480px");
    await act(async () => container.querySelector("button").click());

    await act(async () => root.render(React.createElement(Harness, { show: false })));
    assert.equal(document.querySelector(".session-browser-surface-container"), container);
    assert.ok(container.parentElement.classList.contains("session-browser-parking-host"));
    assert.equal(container.querySelector(".browser-surface-fixture").dataset.parked, "true");
    await act(async () => root.render(React.createElement(Harness, { show: true })));
    assert.equal(container.style.width, "640px", "reopening a folded browser restores its dock size");

    await act(async () => browserController.release("alpha"));
    assert.equal(document.querySelector(".session-browser-surface-container"), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("switching sessions parks the old Browser without creating one for the new session", async () => {
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(SessionSwitchHarness, {
      sessionId: "alpha",
      revealedSessions: true,
    })));
    const alpha = document.querySelector(
      '.session-browser-surface-container[data-browser-session-id="alpha"]',
    );
    assert.ok(alpha);
    assert.ok(alpha.parentElement.classList.contains("session-browser-parking-host"));
    assert.equal(alpha.dataset.parked, "false");

    await act(async () => root.render(React.createElement(SessionSwitchHarness, {
      sessionId: "beta",
      revealedSessions: false,
    })));
    assert.ok(alpha.parentElement.classList.contains("session-browser-parking-host"));
    assert.equal(alpha.dataset.parked, "true");
    assert.equal(document.querySelector(
      '.session-browser-surface-container[data-browser-session-id="beta"]',
    ), null);

    await act(async () => root.render(React.createElement(SessionSwitchHarness, {
      sessionId: "alpha",
      revealedSessions: true,
    })));
    assert.equal(document.querySelector(
      '.session-browser-surface-container[data-browser-session-id="alpha"]',
    ), alpha);
    assert.ok(alpha.parentElement.classList.contains("session-browser-parking-host"));
    assert.equal(alpha.dataset.parked, "false");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
