import assert from "node:assert/strict";
import test from "node:test";

import React, { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://mixdog.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
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

const {
  SessionBrowserParkingHost,
  SessionBrowserSlot,
  useSessionBrowserSurfaces,
} = await import("./session-browser-surfaces.tsx");
const { browserDockEntryForSession } = await import("./session-browser-policy.ts");

const renderFixture = (props) => React.createElement("div", {
  className: "browser-surface-fixture",
  "data-active": props.active ? "true" : "false",
  "data-foreground": props.foreground ? "true" : "false",
  "data-parked": props.parked ? "true" : "false",
});

let browserController;

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

const paneBrowserEntry = {
  open: true,
  view: "sourceControl",
  surface: "browser",
  diff: null,
};

function SessionSwitchHarness({ sessionId, revealedSessions }) {
  const controller = useSessionBrowserSurfaces(renderFixture);
  const entry = browserDockEntryForSession(
    paneBrowserEntry,
    sessionId,
    revealedSessions,
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

    await act(async () => root.render(React.createElement(Harness, { show: false })));
    assert.equal(document.querySelector(".session-browser-surface-container"), container);
    assert.ok(container.parentElement.classList.contains("session-browser-parking-host"));
    assert.equal(container.querySelector(".browser-surface-fixture").dataset.parked, "true");

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
