// Hover-intent contract for the status-slot cards (context gauge, work card).
// The card hangs a few px off its control, so the pointer ALWAYS leaves the
// control before it reaches the card: a close on that first frame is the bug
// this contract exists to prevent (user: 위로 마우스 올라가기 전에 계속 창이
// 닫혀버리네).
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
globalThis.history = dom.window.history;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { useHoverPopover } = await import("./hover-popover.ts");

const CLOSE_DELAY_MS = 30;
const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, CLOSE_DELAY_MS * 4));
});

function mount(props = {}) {
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  const seen = { popover: null, slot: null };
  function Harness(componentProps) {
    const popover = useHoverPopover({ closeDelayMs: CLOSE_DELAY_MS, ...componentProps });
    seen.popover = popover;
    seen.slot = popover.host.current;
    return React.createElement(
      "div",
      { className: "slot", ...popover.hostProps },
      React.createElement("button", { type: "button", ...popover.triggerProps }),
      React.createElement("div", { className: "card" }, "card"),
    );
  }
  return {
    seen,
    render: (next = props) => act(async () => {
      root.render(React.createElement(Harness, next));
    }),
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("the card survives the trip from the control to the card", async () => {
  const harness = mount();
  await harness.render();
  await act(async () => harness.seen.popover.hostProps.onMouseEnter());
  assert.equal(harness.seen.popover.open, true);

  // Leaving the control is the START of the trip, not a dismissal.
  await act(async () => harness.seen.popover.hostProps.onMouseLeave());
  assert.equal(harness.seen.popover.open, true, "closed on the frame the pointer left");

  // The pointer landed on the card, which lives inside the slot, so the slot
  // still reads as hovered when the grace window expires.
  harness.seen.slot.matches = (selector) => selector === ":hover";
  await settle();
  assert.equal(harness.seen.popover.open, true, "closed while the pointer sat on the card");
  await harness.cleanup();
});

test("a pointer that never comes back closes the card after the grace window", async () => {
  const harness = mount();
  await harness.render();
  await act(async () => harness.seen.popover.hostProps.onMouseEnter());
  await act(async () => harness.seen.popover.hostProps.onMouseLeave());
  await settle();
  assert.equal(harness.seen.popover.open, false);
  await harness.cleanup();
});

test("a pending close is cancelled by re-entering the slot", async () => {
  const harness = mount();
  await harness.render();
  await act(async () => harness.seen.popover.hostProps.onMouseEnter());
  await act(async () => harness.seen.popover.hostProps.onMouseLeave());
  await act(async () => harness.seen.popover.hostProps.onMouseEnter());
  await settle();
  assert.equal(harness.seen.popover.open, true);
  await harness.cleanup();
});

test("a pinned card ignores the pointer leaving, and Escape puts it away", async () => {
  const harness = mount();
  await harness.render();
  await act(async () => harness.seen.popover.triggerProps.onClick());
  assert.equal(harness.seen.popover.pinned, true);
  assert.equal(harness.seen.popover.open, true);

  await act(async () => harness.seen.popover.hostProps.onMouseLeave());
  await settle();
  assert.equal(harness.seen.popover.open, true, "a pinned card closed on its own");

  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
  });
  assert.equal(harness.seen.popover.open, false);
  assert.equal(harness.seen.popover.pinned, false);
  await harness.cleanup();
});

test("a controlled card reports every open change to its owner", async () => {
  const changes = [];
  const harness = mount({ open: false, onOpenChange: (next) => changes.push(next) });
  await harness.render({ open: false, onOpenChange: (next) => changes.push(next) });
  await act(async () => harness.seen.popover.hostProps.onMouseEnter());
  assert.deepEqual(changes, [true]);

  // The owner still holds it closed, so nothing paints until it says so.
  assert.equal(harness.seen.popover.open, false);
  await act(async () => harness.seen.popover.hostProps.onMouseLeave());
  await settle();
  assert.deepEqual(changes, [true, false]);
  await harness.cleanup();
});
