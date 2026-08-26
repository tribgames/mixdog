import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

test("pane drag commits only on drop and cancels an unfinished native drag", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div class=\"app-shell\"><div id=\"source\"></div><div id=\"target\"></div></div></body></html>");
  const globals = ["window", "document", "Element"];
  const previous = new Map(globals.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: dom.window.Element });

  const {
    beginPaneDrag,
    currentPaneDrag,
    dropPaneDrag,
    finishPaneDrag,
    movePaneDrag,
    subscribePaneDrag,
  } = await import("./pane-drag-session.ts");
  const source = document.getElementById("source");
  const target = document.getElementById("target");
  const frames = [];
  const unsubscribe = subscribePaneDrag((frame) => frames.push(frame));
  const data = new Map();
  const dataTransfer = {
    effectAllowed: "none",
    dropEffect: "none",
    setData(type, value) { data.set(type, value); },
    getData(type) { return data.get(type) ?? ""; },
    setDragImage() {},
  };
  const dragEvent = (x, y) => ({
    clientX: x,
    clientY: y,
    dataTransfer,
    target,
    preventDefault() {},
  });
  const session = {
    kind: "tab",
    key: "session:one",
    title: "One",
    selection: { kind: "session", id: "one", title: "One" },
    sourceLeafId: "leaf-a",
  };

  try {
    beginPaneDrag({ dataTransfer }, session, source);
    assert.equal(currentPaneDrag(), session);
    movePaneDrag(dragEvent(20, 40));
    finishPaneDrag();
    assert.deepEqual(frames.map((frame) => frame.phase), ["move", "cancel"]);

    frames.length = 0;
    beginPaneDrag({ dataTransfer }, session, source);
    movePaneDrag(dragEvent(30, 50));
    dropPaneDrag(dragEvent(30, 50));
    finishPaneDrag();
    assert.deepEqual(frames.map((frame) => frame.phase), ["move", "drop"]);
    assert.equal(frames[1].target, target);
    assert.equal(currentPaneDrag(), null);
  } finally {
    finishPaneDrag();
    unsubscribe();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
