import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { attachTranscriptSelectionDrag } from "./transcript-selection-drag.ts";

function selectionFixture(t) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root">'
    + '<div class="transcript-virtual-row" data-index="0">top</div>'
    + '<div class="transcript-virtual-row" data-index="1">middle</div>'
    + '<div class="transcript-virtual-row" data-index="2">bottom</div>'
    + '</div><p id="other">other text</p></body></html>');
  const { window } = dom;
  const { document } = window;
  const globals = ["window", "document", "Element", "HTMLElement", "DOMRect"];
  const previous = new Map(globals.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
  }
  const frames = new Map();
  let nextFrame = 0;
  window.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  const flushFrame = () => {
    for (const [id, callback] of [...frames]) {
      if (frames.delete(id)) callback(0);
    }
  };
  const root = document.getElementById("root");
  root.getBoundingClientRect = () => new window.DOMRect(100, 100, 400, 400);
  Object.defineProperties(root, {
    clientWidth: { value: 384 }, // The rightmost 16px is the scrollbar gutter.
    clientHeight: { value: 400 },
  });
  const rows = [...root.children];
  const boxes = [
    new window.DOMRect(112, 112, 372, 60),
    new window.DOMRect(112, 210, 372, 100),
    new window.DOMRect(112, 400, 372, 98),
  ];
  rows.forEach((row, index) => { row.getBoundingClientRect = () => boxes[index]; });
  const hitRow = (x, y) => rows.find((_, index) => {
    const box = boxes[index];
    return x >= box.left && x < box.right && y >= box.top && y < box.bottom;
  });
  document.elementFromPoint = (x, y) =>
    hitRow(x, y) ?? (x >= 100 && x < 500 && y >= 100 && y < 500 ? root : null);
  const caretReads = [];
  document.caretPositionFromPoint = (x, y) => {
    caretReads.push({ x, y });
    const row = hitRow(x, y);
    if (!row) return { offsetNode: root, offset: 0 };
    const box = row.getBoundingClientRect();
    return {
      offsetNode: row.firstChild,
      offset: x < (box.left + box.right) / 2 ? 0 : row.textContent.length,
    };
  };
  const pins = [];
  const scrolls = [];
  let detach = attachTranscriptSelectionDrag({
    root,
    rowKeyAt: (index) => rows[index] ? `row-${index}` : undefined,
    setPin: (pin) => pins.push(pin),
    onAutoScroll: (delta) => scrolls.push(delta),
  });
  const dispose = () => {
    detach?.();
    detach = null;
  };
  t.after(() => {
    dispose();
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const selection = window.getSelection();
  const emit = (type, x, y, buttons = 1, target = document, button = 0) => {
    target.dispatchEvent(new window.MouseEvent(type, {
      bubbles: true, clientX: x, clientY: y, buttons, button,
    }));
  };
  const begin = () => {
    emit("pointerdown", 200, 240, 1, rows[1]);
    // Native selection runs after the capture listener.
    selection.collapse(rows[1].firstChild, 2);
  };
  const nativeFallback = () => selection.extend(rows[0].firstChild, 0);
  const snapshot = () => ({
    anchorRow: selection.anchorNode?.parentElement?.dataset.index ?? null,
    anchorOffset: selection.anchorOffset,
    focusRow: selection.focusNode?.parentElement?.dataset.index ?? null,
    focusOffset: selection.focusOffset,
    text: selection.toString(),
  });
  return {
    window, document, root, rows, selection, frames, flushFrame, caretReads,
    pins, scrolls, emit, begin, nativeFallback, snapshot, dispose,
  };
}

const bottomSelection = {
  anchorRow: "1", anchorOffset: 2,
  focusRow: "2", focusOffset: 6,
  text: "ddlebottom",
};

for (const correctedBeforeRelease of [false, true]) {
  test(`bottom-right release settles after the native write (prior frame: ${correctedBeforeRelease})`, (t) => {
    const f = selectionFixture(t);
    f.begin();
    f.emit("pointermove", 900, 700);
    f.nativeFallback();
    if (correctedBeforeRelease) {
      f.flushFrame();
      assert.deepEqual(f.snapshot(), bottomSelection);
    }
    f.emit("pointerup", 900, 700, 0);
    // Model Chromium's final write AFTER the capture-phase pointerup listener.
    f.nativeFallback();
    const pinsBeforeCorrection = f.pins.length;
    f.document.dispatchEvent(new f.window.Event("selectionchange"));
    assert.equal(f.pins.length, pinsBeforeCorrection);
    f.flushFrame();
    assert.deepEqual(f.snapshot(), bottomSelection);
    assert.deepEqual(f.pins.at(-1), {
      anchor: { key: "row-1", index: 1 },
      focus: { key: "row-2", index: 2 },
    });
    assert.equal(f.root.dataset.transcriptSelectionRoot, undefined);
    assert.equal(f.document.documentElement.dataset.transcriptSelecting, undefined);
    assert.equal(f.frames.size, 0);

    f.emit("pointermove", 110, 110, 0);
    f.root.scrollTop = 40;
    f.root.dispatchEvent(new f.window.Event("scroll"));
    f.flushFrame();
    assert.deepEqual(f.snapshot(), bottomSelection);
    assert.deepEqual(f.scrolls, []);
  });
}

test("release coordinates win even without a final pointermove", (t) => {
  const f = selectionFixture(t);
  f.begin();
  f.emit("pointermove", 900, 150);
  f.flushFrame();
  f.emit("pointerup", 900, 700, 0);
  f.nativeFallback();
  f.flushFrame();
  assert.deepEqual(f.snapshot(), bottomSelection);
});

for (const signal of ["released-move", "pointercancel", "blur"]) {
  test(`${signal} settles at the last held coordinate, not a returning hover or zero point`, (t) => {
    const f = selectionFixture(t);
    f.begin();
    f.emit("pointermove", 900, 700);
    if (signal === "released-move") f.emit("pointermove", 120, 120, 0);
    else if (signal === "pointercancel") f.emit("pointercancel", 0, 0, 0);
    else f.window.dispatchEvent(new f.window.Event("blur"));
    f.nativeFallback();
    f.emit("pointermove", 120, 120, 0);
    f.flushFrame();
    assert.deepEqual(f.snapshot(), bottomSelection);
    assert.equal(f.frames.size, 0);
  });
}

test("an upward exit remains a backward selection after release", (t) => {
  const f = selectionFixture(t);
  f.begin();
  f.emit("pointerup", -100, -100, 0);
  f.selection.extend(f.rows[2].firstChild, 6);
  f.flushFrame();
  assert.deepEqual(f.snapshot(), {
    anchorRow: "1", anchorOffset: 2,
    focusRow: "0", focusOffset: 0,
    text: "topmi",
  });
});

test("an in-row release leaves Chromium's exact text boundary untouched", (t) => {
  const f = selectionFixture(t);
  f.begin();
  f.emit("pointermove", 250, 250);
  f.emit("pointerup", 250, 250, 0);
  f.selection.extend(f.rows[1].firstChild, 4);
  f.flushFrame();
  assert.deepEqual(f.snapshot(), {
    anchorRow: "1", anchorOffset: 2,
    focusRow: "1", focusOffset: 4,
    text: "dd",
  });
  assert.deepEqual(f.caretReads, []);
  assert.equal(f.frames.size, 0);
});

test("a new press supersedes a pending outside release without rewriting the new selection", (t) => {
  const f = selectionFixture(t);
  f.begin();
  f.emit("pointerup", 900, 700, 0);
  f.nativeFallback();
  f.emit("pointerdown", 200, 140, 1, f.rows[0]);
  f.selection.collapse(f.rows[0].firstChild, 1);
  f.selection.extend(f.rows[0].firstChild, 2);
  f.flushFrame();
  assert.equal(f.selection.toString(), "o");
  assert.deepEqual(f.caretReads, []);
  f.emit("pointerup", 250, 140, 0);
  f.flushFrame();
  assert.equal(f.selection.toString(), "o");
  assert.equal(f.frames.size, 0);
});

test("a deferred finish never extends a new selection on another surface", (t) => {
  const f = selectionFixture(t);
  f.begin();
  f.emit("pointerup", 900, 700, 0);
  const other = f.document.getElementById("other").firstChild;
  f.selection.collapse(other, 0);
  f.selection.extend(other, 5);
  f.flushFrame();
  assert.equal(f.selection.toString(), "other");
  assert.deepEqual(f.caretReads, []);
  assert.equal(f.pins.at(-1), null);
});

test("detaching cancels a pending final correction and clears the selection fence", (t) => {
  const f = selectionFixture(t);
  f.begin();
  f.emit("pointerup", 900, 700, 0);
  f.nativeFallback();
  const before = f.snapshot();
  f.dispose();
  f.flushFrame();
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.frames.size, 0);
  assert.equal(f.pins.at(-1), null);
  assert.equal(f.document.documentElement.dataset.transcriptSelecting, undefined);
  assert.equal(f.root.dataset.transcriptSelectionRoot, undefined);
});
