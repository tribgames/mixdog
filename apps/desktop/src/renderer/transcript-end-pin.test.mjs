import assert from "node:assert/strict";
import test from "node:test";
import { createTranscriptEndPin } from "./transcript-end-pin.ts";

function fixture() {
  let top = 400;
  let gesture = false;
  const writes = [];
  const viewport = {
    isConnected: true, scrollHeight: 1200, clientHeight: 400,
    get scrollTop() { return top; },
    set scrollTop(value) { writes.push(value); top = value; },
  };
  const virtualizer = {
    options: { anchorTo: "end", followOnAppend: true },
    getTotalSize: () => viewport.scrollHeight,
  };
  const pin = createTranscriptEndPin({
    getVirtualizer: () => virtualizer,
    getViewport: () => viewport,
    getSpacer: () => null,
    hasReaderGesture: () => gesture,
    markProgrammaticScroll() {},
  });
  return { pin, viewport, virtualizer, writes, gesture: () => { gesture = true; } };
}

test("a queued transcript end correction yields when the reader takes ownership", async () => {
  for (const leave of [
    ({ gesture }) => gesture(),
    ({ virtualizer }) => {
      virtualizer.options.anchorTo = "start";
      virtualizer.options.followOnAppend = false;
    },
  ]) {
    const state = fixture();
    state.pin.request();
    leave(state);
    await Promise.resolve();
    assert.equal(state.viewport.scrollTop, 400);
    assert.deepEqual(state.writes, [], "a reader leave cannot be followed by a stale bottom write");
  }
});

test("cancelled transcript corrections cannot scroll a replacement surface", async () => {
  const { pin, viewport, writes } = fixture();
  pin.request();
  pin.cancel();
  viewport.scrollHeight = 2000;
  await Promise.resolve();
  assert.equal(viewport.scrollTop, 400);
  assert.deepEqual(writes, []);
  pin.request();
  await Promise.resolve();
  assert.equal(viewport.scrollTop, 1600, "effect reattachment can request a fresh correction");
});
