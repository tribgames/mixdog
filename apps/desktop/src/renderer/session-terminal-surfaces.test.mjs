import assert from "node:assert/strict";
import test from "node:test";

import React, { act } from "react";
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
  const visible = this.classList.contains("session-terminal-slot");
  return {
    x: visible ? 40 : 0,
    y: visible ? 20 : 0,
    left: visible ? 40 : 0,
    top: visible ? 20 : 0,
    right: visible ? 760 : 0,
    bottom: visible ? 500 : 0,
    width: visible ? 720 : 0,
    height: visible ? 480 : 0,
    toJSON() { return this; },
  };
};

const {
  SessionTerminalParkingHost,
  SessionTerminalSlot,
  sessionTerminalId,
  useSessionTerminalSurfaces,
} = await import("./session-terminal-surfaces.tsx");
const {
  applyTerminalActivity,
  StableTerminalFitScheduler,
} = await import("./terminal-fit.ts");

const renderFixture = (props) => React.createElement("div", {
  className: "terminal-surface-fixture",
  "data-cwd": props.cwd,
  "data-active": props.active ? "true" : "false",
  "data-parked": props.parked ? "true" : "false",
});

function Harness({ sessionId, active, cwd, disposeTerminal, onController }) {
  const controller = useSessionTerminalSurfaces(renderFixture, disposeTerminal);
  React.useEffect(() => {
    onController?.(controller);
  }, [controller, onController]);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(SessionTerminalParkingHost, { controller }),
    React.createElement(SessionTerminalSlot, {
      controller,
      sessionId,
      active,
      foreground: active,
      cwd,
    }),
  );
}

test("one session terminal root parks and restores at Browser Use width", async () => {
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Harness, {
      sessionId: "alpha",
      active: true,
      cwd: "C:/alpha",
    })));
    const container = document.querySelector(".session-terminal-surface-container");
    assert.ok(container);
    assert.equal(container.style.width, "720px");
    assert.equal(container.style.height, "480px");
    assert.equal(container.querySelector(".terminal-surface-fixture").dataset.cwd, "C:/alpha");
    assert.equal(container.querySelector(".terminal-surface-fixture").dataset.active, "true");

    await act(async () => root.render(React.createElement(Harness, {
      sessionId: "alpha",
      active: false,
      cwd: "C:/alpha",
    })));
    assert.equal(document.querySelector(".session-terminal-surface-container"), container);
    assert.equal(container.dataset.parked, "true");
    assert.equal(container.style.width, "720px");
    assert.equal(container.style.height, "480px");
    assert.equal(container.querySelector(".terminal-surface-fixture").dataset.parked, "true");

    await act(async () => root.render(React.createElement(Harness, {
      sessionId: "alpha",
      active: true,
      cwd: "C:/alpha",
    })));
    assert.equal(document.querySelector(".session-terminal-surface-container"), container);
    assert.equal(container.dataset.parked, "false");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("releasing a session removes its surface and disposes its terminal identity", async () => {
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  const disposed = [];
  let controller = null;
  try {
    await act(async () => root.render(React.createElement(Harness, {
      sessionId: "alpha",
      active: true,
      cwd: "C:/alpha",
      disposeTerminal: (terminalId) => disposed.push(terminalId),
      onController: (value) => { controller = value; },
    })));
    assert.ok(document.querySelector(".session-terminal-surface-container"));
    assert.ok(controller);

    await act(async () => controller.release("alpha"));

    assert.equal(document.querySelector(".session-terminal-surface-container"), null);
    assert.deepEqual(disposed, [sessionTerminalId("alpha")]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("parked terminal activity releases its renderer and pauses fitting", () => {
  const calls = [];
  const handlers = {
    enableRenderer: () => calls.push("enable"),
    releaseRenderer: () => calls.push("release"),
    scheduleFit: () => calls.push("schedule"),
    pauseFit: () => calls.push("pause"),
    focus: () => calls.push("focus"),
  };

  applyTerminalActivity(false, handlers);
  applyTerminalActivity(true, handlers);

  assert.deepEqual(calls, ["pause", "release", "enable", "schedule", "focus"]);
});

test("stable fitting coalesces changing grids and suppresses duplicate PTY resizes", () => {
  const frames = [];
  const emitted = [];
  const fitCalls = [];
  let current = { cols: 80, rows: 24 };
  let proposed = { cols: 100, rows: 30 };
  const scheduler = new StableTerminalFitScheduler({
    isActive: () => true,
    isMeasurable: () => true,
    currentGrid: () => current,
    proposeGrid: () => proposed,
    fit: (restore) => {
      fitCalls.push(restore);
      current = { ...proposed };
    },
    emitResize: (grid) => emitted.push({ ...grid }),
    onSettled: () => {},
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {},
  });
  const flushFrame = () => frames.shift()?.(0);

  scheduler.schedule({ scrollY: 12 });
  flushFrame();
  assert.equal(fitCalls.length, 0);
  flushFrame();
  assert.deepEqual(fitCalls, [{ scrollY: 12 }]);
  assert.deepEqual(emitted, [{ cols: 100, rows: 30 }]);

  scheduler.schedule();
  flushFrame();
  assert.equal(fitCalls.length, 2);
  assert.deepEqual(emitted, [{ cols: 100, rows: 30 }]);

  proposed = { cols: 101, rows: 30 };
  scheduler.schedule();
  flushFrame();
  assert.equal(fitCalls.length, 2);
  scheduler.pause();
  flushFrame();
  assert.equal(fitCalls.length, 2);
});
