import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranscriptEndPin } from './transcript-end-pin.ts';

function fixture() {
  let top = 400;
  let gesture = false;
  const writes = [];
  const frames = new Map();
  let frameId = 0;
  const reported = [];
  const viewport = {
    isConnected: true,
    scrollHeight: 1200,
    clientHeight: 400,
    get scrollTop() {
      return top;
    },
    set scrollTop(value) {
      writes.push(value);
      top = value;
    },
  };
  const virtualizer = {
    options: { anchorTo: 'end', followOnAppend: true },
    getTotalSize: () => viewport.scrollHeight,
    targetWindow: {
      requestAnimationFrame(callback) {
        frames.set(++frameId, callback);
        return frameId;
      },
      cancelAnimationFrame(id) {
        frames.delete(id);
      },
    },
  };
  const pin = createTranscriptEndPin({
    getVirtualizer: () => virtualizer,
    getViewport: () => viewport,
    getSpacer: () => null,
    getMaxScrollTop: () => Math.max(0, virtualizer.getTotalSize() - viewport.clientHeight),
    hasReaderGesture: () => gesture,
    markProgrammaticScroll: (top, intended) => reported.push({ top, intended }),
  });
  return {
    pin,
    viewport,
    virtualizer,
    writes,
    reported,
    frames,
    frame() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => {
        callback();
      });
    },
    gesture: (active = true) => {
      gesture = active;
    },
    nativeClamp: (value) => {
      top = value;
    },
  };
}

test('a queued transcript end correction yields when the reader takes ownership', async () => {
  for (const leave of [
    ({ gesture }) => gesture(),
    ({ virtualizer }) => {
      virtualizer.options.anchorTo = 'start';
      virtualizer.options.followOnAppend = false;
    },
  ]) {
    const state = fixture();
    state.pin.request();
    leave(state);
    await Promise.resolve();
    assert.equal(state.viewport.scrollTop, 400);
    assert.deepEqual(state.writes, [], 'a reader leave cannot be followed by a stale bottom write');
  }
});

test('cancelled transcript corrections cannot scroll a replacement surface', async () => {
  const { pin, viewport, writes } = fixture();
  pin.request();
  pin.cancel();
  viewport.scrollHeight = 2000;
  await Promise.resolve();
  assert.equal(viewport.scrollTop, 400);
  assert.deepEqual(writes, []);
  pin.request();
  await Promise.resolve();
  assert.equal(viewport.scrollTop, 1600, 'effect reattachment can request a fresh correction');
});

test('a native clamp during replacement is repaired even when the final extent is unchanged', async () => {
  const state = fixture();
  state.pin.request();
  await Promise.resolve();
  assert.equal(state.viewport.scrollTop, 800);
  state.nativeClamp(790);
  state.pin.request();
  state.pin.request();
  await Promise.resolve();
  assert.equal(state.viewport.scrollTop, 800);
  assert.deepEqual(state.writes, [800, 800], 'the replacement needs one coalesced correction');
  state.pin.request();
  await Promise.resolve();
  assert.equal(state.writes.length, 2, 'an already-held native end needs no write');
  assert.deepEqual(state.reported.at(-1), { top: 800, intended: 800 });
});

test('a height change held by a gesture is pinned on idle without another mutation', async () => {
  const state = fixture();
  state.gesture();
  state.pin.request();
  await Promise.resolve();
  state.viewport.clientHeight = 300;
  state.frame();
  await Promise.resolve();
  assert.deepEqual(state.writes, []);
  state.gesture(false);
  state.frame();
  await Promise.resolve();
  assert.equal(state.viewport.scrollTop, 900);
  assert.equal(state.frames.size, 0);
});

test('a deferred height pin cannot reclaim a released or replacement viewport', async () => {
  for (const cancel of [false, true]) {
    const state = fixture();
    state.gesture();
    state.pin.request();
    await Promise.resolve();
    if (cancel) state.pin.cancel();
    else {
      state.virtualizer.options.anchorTo = 'start';
      state.virtualizer.options.followOnAppend = false;
    }
    state.gesture(false);
    state.frame();
    await Promise.resolve();
    assert.deepEqual(state.writes, []);
    assert.equal(state.frames.size, 0);
  }
});
