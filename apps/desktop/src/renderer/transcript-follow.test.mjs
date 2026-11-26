import assert from 'node:assert/strict';
import test from 'node:test';

import { nextTranscriptHistoryLimit } from './transcript-history.ts';
import { shouldDeferTranscriptScrollAdjustment } from './TranscriptList.tsx';
import { installTestDom } from './test-support/test-dom.mjs';
import {
  clampTranscriptSelectionPoint,
  nearestTranscriptSelectionRow,
  transcriptSelectionPrimaryButtonDown,
  transcriptSelectionPointerRegion,
} from './transcript-selection-drag.ts';
import { boundaryGestureReached, touchScrollLatchOpen } from './use-transcript-follow.ts';

/** The end of the touch the helpers below start (contact 0). */
const lift = () => ({ touches: [], changedTouches: [{ identifier: 0 }] });

test('transcript history grows in bounded pages only at a full window', () => {
  assert.equal(nextTranscriptHistoryLimit(120, 512), null);
  assert.equal(nextTranscriptHistoryLimit(512, 512), 1024);
  assert.equal(nextTranscriptHistoryLimit(1300, 1024), 1812);
  // No item ceiling: a full window pages on to the first message.
  assert.equal(nextTranscriptHistoryLimit(8192, 8192), 8704);
});

test('every active reader gesture defers corrective transcript scroll writes', () => {
  assert.equal(shouldDeferTranscriptScrollAdjustment(true), true);
  // The core sets isScrolling for its own corrective writes, so treating that
  // as ownership left an untouched transcript bouncing on the deferred flush.
  assert.equal(shouldDeferTranscriptScrollAdjustment(false), false);
});

test('a touch scroll owns the viewport through the finger and its whole fling', () => {
  // A slow phone frame must never hand the viewport back mid-gesture.
  assert.equal(touchScrollLatchOpen({ latched: true, touchDown: true, sinceScrollMs: 5_000 }), true);
  assert.equal(touchScrollLatchOpen({ latched: true, touchDown: false, sinceScrollMs: 400 }), true);
  assert.equal(touchScrollLatchOpen({ latched: true, touchDown: false, sinceScrollMs: 900 }), false);
  // A tap that never scrolled the transcript is not ownership.
  assert.equal(touchScrollLatchOpen({ latched: false, touchDown: true, sinceScrollMs: 0 }), false);
});

test('an unscrollable nested target hands the gesture straight to the transcript', () => {
  assert.equal(boundaryGestureReached({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 }, -50), true);
  assert.equal(boundaryGestureReached({ scrollTop: 0, scrollHeight: 900, clientHeight: 300 }, 0), false);
});

test('selection remains active outside the viewport only while the primary button is held', () => {
  assert.equal(transcriptSelectionPrimaryButtonDown(1), true);
  assert.equal(transcriptSelectionPrimaryButtonDown(3), true);
  assert.equal(transcriptSelectionPrimaryButtonDown(0), false);
  assert.equal(transcriptSelectionPrimaryButtonDown(2), false);
});

test('selection outside the transcript stays on one stable boundary', () => {
  const region = (x, y) => transcriptSelectionPointerRegion(x, y, 100, 100, 500, 500);
  assert.equal(region(300, 99), 'above');
  assert.equal(region(101, -900), 'above');
  assert.equal(region(300, 501), 'below');
  assert.equal(region(499, 1_400), 'below');
  assert.equal(region(99, 300), 'side');
  assert.equal(region(501, 300), 'side');
  assert.equal(region(300, 300), 'inside');
});

test('a pointer outside the transcript extends to the caret at the nearest edge', () => {
  const clamp = (x, y) => clampTranscriptSelectionPoint(x, y, 100, 100, 500, 500);
  // Below (through the composer): keep the column, land on the last visible line.
  assert.deepEqual(clamp(300, 900), { x: 300, y: 498 });
  // Above the window: keep the column, land on the first visible line.
  assert.deepEqual(clamp(300, -160), { x: 300, y: 102 });
  // Beside the window: keep the line, land on the row's near edge — the
  // range must not flip to the first mounted row (user: 드래그가 뒤집힘).
  assert.deepEqual(clamp(-160, 300), { x: 102, y: 300 });
  assert.deepEqual(clamp(2_000, 300), { x: 498, y: 300 });
  // Inside stays where it is.
  assert.deepEqual(clamp(300, 300), { x: 300, y: 300 });
});

test('a pointer off any row extends into the nearest row, never a boundary row', () => {
  const rows = [
    { id: 'first', top: 100, bottom: 140 },
    { id: 'middle', top: 156, bottom: 300 },
    { id: 'last', top: 316, bottom: 360 },
  ];
  const nearest = (y) => nearestTranscriptSelectionRow(rows, y)?.id;
  // Over a row: that row.
  assert.equal(nearest(200), 'middle');
  // In the gap between rows: the closer one on either side.
  assert.equal(nearest(146), 'first');
  assert.equal(nearest(152), 'middle');
  // In the scroller's padding past the last row, or clamped above the first.
  assert.equal(nearest(420), 'last');
  assert.equal(nearest(90), 'first');
  assert.equal(nearestTranscriptSelectionRow([], 200), null);
});

async function mountFollowHook({
  sessionKey,
  leafTag = 'p',
  leafId = 'row',
  clock,
  navigator,
  mutationObserver = false,
  hookOptions = {},
  globals = {},
  pane = '',
}) {
  const [React, { createRoot }, followModule, { PaneKeyContext }] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./use-transcript-follow.ts'),
    import('./pane-key-context.ts'),
  ]);
  const { restore } = installTestDom(null, {
    html: "<div id='root'></div>",
    jsdom: { url: 'http://localhost/', pretendToBeVisual: true },
    expose: mutationObserver ? ['Element', 'MutationObserver'] : ['Element'],
    globals: { ...globals, ...(navigator ? { navigator } : {}) },
  });
  const realNow = Date.now;
  if (clock) Date.now = () => clock.now;
  const root = createRoot(document.getElementById('root'));
  let follow = null;
  let session = sessionKey;
  function Harness() {
    const viewport = React.useRef(null);
    const content = React.useRef(null);
    follow = followModule.useTranscriptFollow({ viewport, content, sessionKey: session, ...hookOptions });
    return React.createElement(
      'div',
      { ref: viewport },
      React.createElement('div', { ref: content }, React.createElement(leafTag, { id: leafId }, 'rows'))
    );
  }
  const render = () =>
    React.act(async () =>
      root.render(React.createElement(PaneKeyContext.Provider, { value: pane }, React.createElement(Harness)))
    );
  await render();
  const leaf = document.getElementById(leafId);
  return {
    React,
    leaf,
    viewport: leaf.parentElement.parentElement,
    registerGeometry: followModule.registerTranscriptScrollGeometry,
    get follow() {
      return follow;
    },
    /** The pane goes on to show another session. */
    enter: (next) => {
      session = next;
      return render();
    },
    frame: () => React.act(() => new Promise((resolve) => window.requestAnimationFrame(() => resolve()))),
    async dispose() {
      Date.now = realNow;
      await React.act(async () => root.unmount());
      restore();
    },
  };
}

test('a finger on the glass holds the end pin off and its upward scroll releases follow', async () => {
  const clock = { now: 100_000 };
  const mount = await mountFollowHook({ sessionKey: 'finger-down', clock });
  const { React, viewport, leaf: row } = mount;
  let native = 2000;
  try {
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => native, set: () => {} });
    const release = mount.registerGeometry(viewport, {
      viewportHeight: () => 400,
      contentHeight: () => 2400,
      scrollTop: () => native,
      deviation: () => 0,
    });
    await React.act(async () => mount.follow.handleScroll());
    clock.now += 1_000;
    assert.equal(mount.follow.followingRef.current, true, 'the reader starts at the tail');
    assert.equal(mount.follow.hasScrollGesture(), false, 'no reader owns the idle tail');
    const touch = (clientY) => ({
      target: row,
      currentTarget: viewport,
      touches: [{ clientY }],
      changedTouches: [{ identifier: 0, clientY }],
    });
    mount.follow.handleTouchStart(touch(100));
    assert.equal(mount.follow.hasScrollGesture(), true, 'a resting finger holds the end pin off');
    assert.equal(mount.follow.followingRef.current, true, 'resting is not a leave');
    mount.follow.handleTouchEnd(lift());
    assert.equal(mount.follow.hasScrollGesture(), false, 'a tap that never scrolled hands the tail back');
    mount.follow.handleTouchStart(touch(100));
    // A resting finger moved nothing: an upward move under it (a clamp) is not the reader's.
    native = 1990;
    await React.act(async () => mount.follow.handleScroll());
    assert.equal(mount.follow.followingRef.current, true, 'a resting finger does not vouch for a move it did not make');
    mount.follow.handleTouchMove(touch(140));
    native = 1950;
    await React.act(async () => mount.follow.handleScroll());
    assert.equal(mount.follow.followingRef.current, false, 'the upward move under the finger releases follow');
    release();
  } finally {
    await mount.dispose();
  }
});

test('a touch whose row is virtualized away stops owning the transcript once its fling idles', async () => {
  const clock = { now: 100_000 };
  const mount = await mountFollowHook({ sessionKey: 'touch', clock });
  const { viewport, leaf: row } = mount;
  try {
    const touch = (clientY) => ({
      target: row,
      currentTarget: viewport,
      touches: [{ clientY }],
      changedTouches: [{ identifier: 0, clientY }],
    });
    mount.follow.handleTouchStart(touch(100));
    mount.follow.handleTouchMove(touch(160));
    clock.now += 5_000;
    assert.equal(mount.follow.hasScrollGesture(), true, 'a finger resting on the glass keeps ownership');
    row.remove();
    assert.equal(mount.follow.hasScrollGesture(), false, 'its lost touchend cannot hold ownership forever');
  } finally {
    await mount.dispose();
  }
});

test('a drag whose pressed word left the document still releases follow and owns the scroll', async () => {
  const mount = await mountFollowHook({ sessionKey: 'touch-detached', leafTag: 'mx-fade', leafId: 'word' });
  const { React, viewport, leaf: word } = mount;
  const touchEvent = (type, clientY) => {
    const event = new window.Event(type, { bubbles: true });
    Object.defineProperty(event, 'touches', { value: clientY === undefined ? [] : [{ clientY }] });
    Object.defineProperty(event, 'changedTouches', { value: [{ identifier: 0, clientY }] });
    return event;
  };
  let native = 2000;
  try {
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => native, set: () => {} });
    const release = mount.registerGeometry(viewport, {
      viewportHeight: () => 400,
      contentHeight: () => 2400,
      scrollTop: () => native,
      deviation: () => 0,
    });
    await React.act(async () => mount.follow.handleScroll());
    assert.equal(mount.follow.followingRef.current, true, 'the reader starts at the followed tail');
    mount.follow.handleTouchStart({
      target: word,
      currentTarget: viewport,
      touches: [{ clientY: 100 }],
      changedTouches: [{ identifier: 0, clientY: 100 }],
    });
    word.remove();
    await React.act(async () => word.dispatchEvent(touchEvent('touchmove', 140)));
    assert.equal(mount.follow.hasTouchScroll(), true, 'the drag owns the transcript');
    native = 1960;
    await React.act(async () => mount.follow.handleScroll());
    assert.equal(mount.follow.followingRef.current, false, 'the scroll under the finger releases follow');
    word.dispatchEvent(touchEvent('touchend'));
    viewport.dispatchEvent(new window.Event('scrollend'));
    assert.equal(mount.follow.hasTouchScroll(), false, 'its lift and scrollend end the touch scroll');
    release();
  } finally {
    await mount.dispose();
  }
});

test('a held touch correction growing between scroll events is not read as a return to the tail', async () => {
  const mount = await mountFollowHook({ sessionKey: 'touch-hold' });
  const { React, viewport, leaf: row } = mount;
  let native = 2000;
  let held = 0;
  let content = 2400;
  try {
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => native, set: () => {} });
    const release = mount.registerGeometry(viewport, {
      viewportHeight: () => 400,
      contentHeight: () => content,
      scrollTop: () => native + held,
      deviation: () => held,
    });
    await React.act(async () => mount.follow.handleScroll());
    assert.equal(mount.follow.followingRef.current, true, 'the reader starts at the tail');
    const touch = (clientY) => ({
      target: row,
      currentTarget: viewport,
      touches: [{ clientY }],
      changedTouches: [{ identifier: 0, clientY }],
    });
    mount.follow.handleTouchStart(touch(100));
    await React.act(async () => mount.follow.handleTouchMove(touch(140)));
    native = 1990;
    await React.act(async () => mount.follow.handleScroll());
    assert.equal(mount.follow.followingRef.current, false, 'the upward drag releases follow');
    native = 1980;
    held = 400;
    content = 2800;
    await React.act(async () => mount.follow.handleScroll());
    assert.equal(mount.follow.followingRef.current, false, 'a growing hold is not the reader arriving at the tail');
    release();
  } finally {
    await mount.dispose();
  }
});

async function mountFollowRig({ sessionKey, startedAt }) {
  const { createTranscriptEndPin } = await import('./transcript-end-pin.ts');
  const VIEWPORT = 400;
  const clock = { now: startedAt };
  const state = { content: 2400, native: 2000 };
  const writes = [];
  const instance = {
    options: { anchorTo: 'end', followOnAppend: false },
    get targetWindow() {
      return window;
    },
    getTotalSize: () => state.content,
  };
  const setAnchorBottomRef = { current: (bottom) => (instance.options.anchorTo = bottom ? 'end' : 'start') };
  let pin = null;
  const scrollToEndRef = { current: () => pin.request() };
  const mount = await mountFollowHook({ sessionKey, clock, hookOptions: { setAnchorBottomRef, scrollToEndRef } });
  const { React, viewport } = mount;
  const flush = () => React.act(async () => {});
  let release = () => {};
  const cleanup = async () => {
    release();
    await mount.dispose();
  };
  try {
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => state.native,
      set: (value) => {
        writes.push(value);
        state.native = Math.min(Math.max(0, value), state.content - VIEWPORT);
      },
    });
    release = mount.registerGeometry(viewport, {
      viewportHeight: () => VIEWPORT,
      contentHeight: () => state.content,
      scrollTop: () => state.native,
      deviation: () => 0,
    });
    pin = createTranscriptEndPin({
      getVirtualizer: () => instance,
      getViewport: () => viewport,
      getSpacer: () => null,
      getMaxScrollTop: () => state.content - VIEWPORT,
      hasReaderGesture: () => mount.follow.hasScrollGesture(),
      markProgrammaticScroll: (top, intended) => mount.follow.markProgrammaticScroll(top, intended),
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    React,
    viewport,
    VIEWPORT,
    state,
    writes,
    flush,
    frame: mount.frame,
    get follow() {
      return mount.follow;
    },
    enter: (next) => mount.enter(next),
    advance: (ms) => {
      clock.now += ms;
    },
    /** A streamed token grows the tail; a following timeline asks for the end. */
    grow: async (px) => {
      state.content += px;
      if (instance.options.anchorTo === 'end') pin.request();
      await flush();
    },
    cleanup,
  };
}

test('streaming growth never writes scrollTop while the reader scrolls, and follow resumes at the bottom', async () => {
  const rig = await mountFollowRig({ sessionKey: 'stream-reader', startedAt: 200_000 });
  const { React, viewport, VIEWPORT, state, writes, flush, frame, grow, advance } = rig;
  try {
    await React.act(async () => rig.follow.handleScroll());
    advance(1_000);
    await grow(40);
    assert.equal(writes.length, 1, 'a following, idle tail is pinned on growth');
    assert.equal(state.native, state.content - VIEWPORT);
    writes.length = 0;

    // A downward wheel at the kept end moves nothing: growth meanwhile is pinned as it comes.
    await React.act(async () => rig.follow.handleWheel({ deltaY: 100, target: viewport, currentTarget: viewport }));
    await grow(40);
    await grow(40);
    assert.equal(writes.length, 2, 'a wheel down at the end holds nothing');
    assert.equal(rig.follow.followingRef.current, true);
    assert.equal(state.native, state.content - VIEWPORT);
    writes.length = 0;

    // Scrolling up releases follow: the tail keeps growing without a single write.
    await React.act(async () => rig.follow.handleWheel({ deltaY: -100, target: viewport, currentTarget: viewport }));
    state.native -= 300;
    await React.act(async () => rig.follow.handleScroll());
    assert.equal(rig.follow.followingRef.current, false, 'an upward wheel releases follow');
    const reading = state.native;
    for (let index = 0; index < 5; index += 1) {
      advance(50);
      await grow(40);
    }
    advance(1_000);
    await frame();
    await flush();
    assert.equal(writes.length, 0, 'no write while the reader reads above the tail');
    assert.equal(state.native, reading, 'the reading offset is never moved');

    // Back at the bottom, follow re-attaches and the next growth is pinned.
    state.native = state.content - VIEWPORT;
    advance(1_000);
    await React.act(async () => rig.follow.handleScroll());
    assert.equal(rig.follow.followingRef.current, true, 'the bottom re-attaches follow');
    advance(1_000);
    await grow(40);
    assert.equal(writes.length, 1, 'following resumes on the next growth');
    assert.equal(state.native, state.content - VIEWPORT);
  } finally {
    await rig.cleanup();
  }
});

/** The follow rig with the reader released, 600px up. */
async function mountReturningReader() {
  const rig = await mountFollowRig({ sessionKey: 'returning-reader', startedAt: 400_000 });
  const { React, viewport, VIEWPORT, state, writes, flush, frame, grow, advance } = rig;
  const scroll = (to) => {
    state.native = to;
    return React.act(async () => rig.follow.handleScroll());
  };
  const wheel = (deltaY) =>
    React.act(async () => rig.follow.handleWheel({ deltaY, target: viewport, currentTarget: viewport }));
  const touch = {
    start: (clientY) =>
      React.act(async () =>
        rig.follow.handleTouchStart({
          target: viewport,
          currentTarget: viewport,
          touches: [{ clientY }],
          changedTouches: [{ identifier: 0, clientY }],
        })
      ),
    move: (clientY) =>
      React.act(async () =>
        rig.follow.handleTouchMove({
          target: viewport,
          currentTarget: viewport,
          touches: [{ clientY }],
          changedTouches: [{ identifier: 0, clientY }],
        })
      ),
    end: () => React.act(async () => rig.follow.handleTouchEnd(lift())),
    scrollend: () => React.act(async () => viewport.dispatchEvent(new window.Event('scrollend'))),
  };
  /** Time passes with no input: the reader's scroll is over. */
  const idle = async (ms = 1_000) => {
    advance(ms);
    await frame();
    await frame();
    await flush();
  };
  // The reader scrolls 600px up from the end: released.
  await scroll(state.native);
  await wheel(-100);
  await scroll(state.native - 600);
  assert.equal(rig.follow.followingRef.current, false, 'an upward wheel releases follow');
  await idle();
  writes.length = 0;
  return {
    follow: rig.follow,
    writes,
    VIEWPORT,
    max: () => state.content - VIEWPORT,
    native: () => state.native,
    scroll,
    wheel,
    touch,
    idle,
    grow,
    cleanup: rig.cleanup,
  };
}

// Stopping 150px above the end keeps follow off (no early snap); reaching the bottom takes follow back.
test('a reader scrolling back down only follows again once reaching the bottom, not 150px above it', async () => {
  for (const input of ['wheel', 'touch']) {
    const reader = await mountReturningReader();
    try {
      const above = reader.max() - 150;
      const bottom = reader.max();
      if (input === 'wheel') {
        await reader.wheel(100);
        await reader.scroll(above);
        assert.equal(reader.follow.followingRef.current, false, `${input}: 150px above the end stays unpinned`);
        await reader.wheel(150);
        await reader.scroll(bottom);
        assert.equal(reader.follow.followingRef.current, true, `${input}: reaching the bottom takes follow back`);
      } else {
        await reader.touch.start(300);
        await reader.touch.move(200);
        await reader.scroll(above);
        await reader.touch.end();
        assert.equal(reader.follow.followingRef.current, false, `${input}: lifting 150px above the end stays unpinned`);
        await reader.touch.start(300);
        await reader.touch.move(100);
        await reader.scroll(bottom);
        assert.equal(reader.follow.followingRef.current, false, `${input}: not while the finger is down`);
        await reader.touch.end();
        assert.equal(reader.follow.followingRef.current, true, `${input}: lifting at the bottom takes follow back`);
      }
      await reader.grow(40);
      assert.deepEqual(reader.writes, [], `${input}: nothing is written under the reader's hand`);
      if (input === 'touch') await reader.touch.scrollend();
      await reader.idle();
      assert.equal(reader.native(), reader.max(), `${input}: the end is pinned once the reader is done`);
      await reader.grow(40);
      assert.equal(reader.native(), reader.max(), `${input}: and new output follows`);
    } finally {
      await reader.cleanup();
    }
  }
});

test("an arrival at the end made in one session is not the next session's: its place stands", async () => {
  const rig = await mountFollowRig({ sessionKey: 'arrival-a', startedAt: 450_000 });
  const { React, viewport, state, writes, flush, frame, advance } = rig;
  const scroll = (to) => {
    state.native = to;
    return React.act(async () => rig.follow.handleScroll());
  };
  const touch = (type, clientY) =>
    React.act(async () =>
      rig.follow[type]({
        target: viewport,
        currentTarget: viewport,
        touches: [{ clientY }],
        changedTouches: [{ identifier: 0, clientY }],
      })
    );
  try {
    await scroll(state.native);
    advance(1_000);
    await React.act(async () => rig.follow.handleWheel({ deltaY: -100, target: viewport, currentTarget: viewport }));
    await scroll(1400);
    assert.equal(rig.follow.followingRef.current, false, 'the reader left the end of A');
    advance(1_000);
    // A finger drags A back down to its end: follow waits for the lift.
    await touch('handleTouchStart', 300);
    await touch('handleTouchMove', 200);
    await scroll(state.content - rig.VIEWPORT);
    await frame();
    await flush();
    assert.equal(rig.follow.followingRef.current, false, 'not while the finger is down');
    // The pane goes on to B, whose reader is far above its end.
    writes.length = 0;
    state.content = 5000;
    state.native = 3000;
    await rig.enter('arrival-b');
    await React.act(async () => rig.follow.handleScroll());
    for (let step = 0; step < 3; step += 1) {
      await frame();
      await flush();
    }
    assert.equal(rig.follow.followingRef.current, false, "A's arrival does not take follow back in B");
    assert.deepEqual(writes, [], "B's place is not overwritten with its end");
    assert.equal(state.native, 3000);
  } finally {
    await rig.cleanup();
  }
});

test('a scroll up into the band, or one resting there, does not take follow back', async () => {
  const rig = await mountFollowRig({ sessionKey: 'band-upward', startedAt: 500_000 });
  const { React, viewport, state, writes, flush, frame, grow, advance } = rig;
  const scroll = (to) => {
    state.native = to;
    return React.act(async () => rig.follow.handleScroll());
  };
  try {
    await scroll(state.native);
    advance(1_000);
    // One notch up from the end: the reader leaves, 100px above it.
    await React.act(async () => rig.follow.handleWheel({ deltaY: -100, target: viewport, currentTarget: viewport }));
    await scroll(state.native - 100);
    assert.equal(rig.follow.followingRef.current, false, 'a single upward notch at the end releases follow');
    const reading = state.native;
    advance(1_000);
    await frame();
    await flush();
    // A scroll event with no move (a layout pass) while the view rests in the band.
    await scroll(reading);
    await grow(40);
    advance(1_000);
    await frame();
    await flush();
    assert.equal(rig.follow.followingRef.current, false, 'resting in the band without moving down keeps it released');
    assert.deepEqual(writes, [], 'nothing is written');
    assert.equal(state.native, reading, "the reader's offset is untouched");
  } finally {
    await rig.cleanup();
  }
});

test('arriving at the true bottom re-engages follow at once (a wheel) or at the lift (a finger)', async () => {
  for (const input of ['wheel', 'touch']) {
    const reader = await mountReturningReader();
    try {
      if (input === 'wheel') {
        await reader.wheel(100);
        await reader.scroll(reader.max());
        assert.equal(reader.follow.followingRef.current, true, `${input}: the arrival itself re-engages`);
      } else {
        await reader.touch.start(300);
        await reader.touch.move(200);
        await reader.scroll(reader.max());
        assert.equal(reader.follow.followingRef.current, false, `${input}: not while the finger is down`);
        await reader.touch.end();
        assert.equal(reader.follow.followingRef.current, true, `${input}: the lift at the end re-engages`);
        await reader.touch.scrollend();
      }
      // The timeline still waits out the reader's gesture before it writes.
      await reader.grow(40);
      assert.deepEqual(reader.writes, [], `${input}: nothing pushes the content under the reader's hand`);
      await reader.idle();
      await reader.grow(40);
      assert.equal(reader.native(), reader.max(), `${input}: growth is pinned once the reader is done`);
      await reader.grow(40);
      assert.equal(reader.native(), reader.max(), `${input}: and stays there`);
    } finally {
      await reader.cleanup();
    }
  }
});

test('a wheel ramp holds measured-size corrections off scrollTop until its scrolls go quiet', async () => {
  const { createTouchScrollDeviation } = await import('./transcript-list-touch-deviation.ts');
  const VIEWPORT = 400;
  const content = 4000;
  const clock = { now: 300_000 };
  let native = 2000;
  const writes = [];
  const mount = await mountFollowHook({ sessionKey: 'wheel-hold', leafTag: 'div', leafId: 'space', clock });
  const { React, viewport, leaf: space, frame } = mount;
  let deviation = null;
  let release = null;
  try {
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => VIEWPORT });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => content });
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => native,
      set: (value) => {
        writes.push(value);
        native = value;
      },
    });
    deviation = createTouchScrollDeviation({
      getViewport: () => viewport,
      getSpacer: () => space,
      hasTouchScroll: () => mount.follow.holdsScrollCorrections(),
      clampAtEdge: () => mount.follow.touchHoldsCorrections(),
      markProgrammaticScroll: (top, intended) => mount.follow.markProgrammaticScroll(top, intended),
    });
    release = mount.registerGeometry(viewport, {
      viewportHeight: () => VIEWPORT,
      contentHeight: () => content,
      scrollTop: () => native,
      deviation: () => deviation.amount(),
    });
    await React.act(async () => mount.follow.handleScroll());
    // The reader wheels up; a row measured into view above grows by 30px.
    clock.now += 1_000;
    await React.act(async () => mount.follow.handleWheel({ deltaY: -100, target: viewport, currentTarget: viewport }));
    assert.equal(mount.follow.holdsScrollCorrections(), true, 'the wheel owns the viewport');
    native -= 60;
    await React.act(async () => mount.follow.handleScroll());
    assert.equal(deviation.hold(native + 30), true, 'its correction is held');
    assert.equal(space.style.transform, 'translateY(-30px)', 'as a row offset');
    assert.equal(space.style.marginBottom, '-30px', 'and the native end moves up with the lifted rows');
    // The ramp keeps scrolling past the wheel window; it still owns the viewport.
    for (let step = 0; step < 4; step += 1) {
      clock.now += 120;
      native -= 20;
      await React.act(async () => mount.follow.handleScroll());
      await frame();
    }
    assert.equal(mount.follow.holdsScrollCorrections(), true, 'scrolls of the ramp extend the hold');
    assert.deepEqual(writes, [], 'no scrollTop write during the wheel scroll');
    // Quiet: the held correction lands as one write.
    const settledAt = native + 30;
    clock.now += 300;
    assert.equal(mount.follow.holdsScrollCorrections(), false, 'the hold ends once the ramp is quiet');
    await frame();
    assert.deepEqual(writes, [settledAt], 'one write lands the held correction');
    assert.equal(space.style.transform, '');
    assert.equal(space.style.marginBottom, '');
    // A later scroll that is no wheel (scrollbar, keyboard) holds nothing.
    clock.now += 50;
    native -= 40;
    await React.act(async () => mount.follow.handleScroll());
    assert.equal(mount.follow.holdsScrollCorrections(), false, 'a later non-wheel scroll does not revive the hold');
  } finally {
    release?.();
    deviation?.cancel();
    await mount.dispose();
  }
});

test('a wheel that keeps turning at the top lands the history held above it', async () => {
  const { createTouchScrollDeviation } = await import('./transcript-list-touch-deviation.ts');
  const clock = { now: 300_000 };
  let native = 40;
  const writes = [];
  const mount = await mountFollowHook({ sessionKey: 'wheel-top', leafTag: 'div', leafId: 'space', clock });
  const { React, viewport, leaf: space, frame } = mount;
  let deviation = null;
  try {
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 400 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => 4000 });
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => native,
      set: (value) => {
        writes.push(value);
        native = value;
      },
    });
    deviation = createTouchScrollDeviation({
      getViewport: () => viewport,
      getSpacer: () => space,
      hasTouchScroll: () => mount.follow.holdsScrollCorrections(),
      clampAtEdge: () => mount.follow.touchHoldsCorrections(),
      markProgrammaticScroll: (top, intended) => mount.follow.markProgrammaticScroll(top, intended),
    });
    const wheelUp = () =>
      React.act(async () => mount.follow.handleWheel({ deltaY: -100, target: viewport, currentTarget: viewport }));
    await React.act(async () => mount.follow.handleScroll());
    clock.now += 1_000;
    await wheelUp();
    // A page of history arrives above the reader while the wheel scrolls: its 900px are held as a row offset.
    assert.equal(deviation.hold(native + 900), true);
    await frame();
    assert.deepEqual(writes, [], 'held while the wheel still has room to scroll');
    // The wheel reaches native 0 and keeps turning there: no scroll event comes any more.
    native = 0;
    for (let notch = 0; notch < 3; notch += 1) {
      clock.now += 40;
      await wheelUp();
    }
    assert.equal(mount.follow.holdsScrollCorrections(), true, 'the wheel still owns the viewport');
    await frame();
    assert.deepEqual(writes, [900], 'the held history lands, so the wheel can scroll into it');
    assert.equal(space.style.transform, '');
  } finally {
    deviation?.cancel();
    await mount.dispose();
  }
});

test('a touch scroll owns the transcript from its drag until scrollend ends the fling, and off iOS holds no corrections', async () => {
  const mount = await mountFollowHook({ sessionKey: 'touch-latch' });
  const { viewport, leaf: row } = mount;
  try {
    const touch = (clientY) => ({
      target: row,
      currentTarget: viewport,
      touches: [{ clientY }],
      changedTouches: [{ identifier: 0, clientY }],
    });
    mount.follow.handleTouchStart(touch(100));
    assert.equal(mount.follow.hasTouchScroll(), false, 'a tap alone owns nothing');
    mount.follow.handleTouchMove(touch(160));
    assert.equal(mount.follow.hasTouchScroll(), true, 'the drag owns the transcript');
    // Off iOS WebKit (Android, a desktop touchscreen) a touch fling keeps its
    // momentum through a scrollTop write: nothing is held off the native
    // offset, so the scroll range always includes history landed above.
    assert.equal(mount.follow.holdsScrollCorrections(), false, 'the drag holds no corrections');
    assert.equal(mount.follow.touchHoldsCorrections(), false, 'no touch hold');
    mount.follow.handleTouchEnd(lift());
    assert.equal(mount.follow.hasTouchScroll(), true, 'the fling keeps it after the finger lifts');
    assert.equal(mount.follow.holdsScrollCorrections(), false, 'and its fling holds nothing either');
    viewport.dispatchEvent(new window.Event('scrollend'));
    assert.equal(mount.follow.hasTouchScroll(), false, 'scrollend ends it');
  } finally {
    await mount.dispose();
  }
});

test('a tap after a drag that got no scrollend owns the transcript only while the finger is down', async () => {
  const clock = { now: 100_000 };
  const mount = await mountFollowHook({ sessionKey: 'touch-edge-drag', clock });
  const { viewport, leaf: row } = mount;
  try {
    const touch = (clientY) => ({
      target: row,
      currentTarget: viewport,
      touches: [{ clientY }],
      changedTouches: [{ identifier: 0, clientY }],
    });
    // A drag against the tail: nothing scrolls, so no scrollend ever closes it.
    mount.follow.handleTouchStart(touch(300));
    mount.follow.handleTouchMove(touch(200));
    mount.follow.handleTouchEnd(lift());
    clock.now += 2_000;
    assert.equal(mount.follow.hasScrollGesture(), false, 'the drag has idled out');
    // A tap on an expander: the fold it starts must reach the end pin at once.
    mount.follow.handleTouchStart(touch(300));
    assert.equal(mount.follow.hasScrollGesture(), true, 'the finger on the glass owns the transcript');
    mount.follow.handleTouchEnd(lift());
    clock.now += 16;
    assert.equal(mount.follow.hasScrollGesture(), false, 'the lift hands the tail back');
  } finally {
    await mount.dispose();
  }
});

/** A touch event on the transcript: `touches` lists every contact on the page,
 *  `changedTouches` the ones this event started or ended. */
const contactEvent = (target, viewport, touches, changed) => ({
  target,
  currentTarget: viewport,
  touches: touches.map(([identifier, clientY]) => ({ identifier, clientY })),
  changedTouches: changed.map(([identifier, clientY]) => ({ identifier, clientY })),
});

test('a transcript finger lifted while a composer finger stays down ends the reader gesture', async () => {
  const clock = { now: 100_000 };
  const mount = await mountFollowHook({ sessionKey: 'touch-composer-finger', clock });
  const { viewport, leaf: row } = mount;
  try {
    mount.follow.handleTouchStart(contactEvent(row, viewport, [[0, 300]], [[0, 300]]));
    // The composer finger (1) lands outside the transcript: none of its events reach it.
    assert.equal(mount.follow.hasScrollGesture(), true, 'the transcript finger owns the transcript');
    mount.follow.handleTouchEnd(contactEvent(row, viewport, [[1, 800]], [[0, 300]]));
    clock.now += 16;
    assert.equal(mount.follow.hasScrollGesture(), false, "the transcript's own last lift ends it");
  } finally {
    await mount.dispose();
  }
});

test('two transcript fingers on different rows: one lifted keeps the reader gesture, the second ends it', async () => {
  const clock = { now: 100_000 };
  const mount = await mountFollowHook({ sessionKey: 'touch-two-rows', clock });
  const { viewport, leaf: row } = mount;
  const other = row.ownerDocument.createElement('p');
  row.parentElement.append(other);
  try {
    mount.follow.handleTouchStart(contactEvent(row, viewport, [[0, 300]], [[0, 300]]));
    mount.follow.handleTouchStart(
      contactEvent(
        other,
        viewport,
        [
          [0, 300],
          [1, 400],
        ],
        [[1, 400]]
      )
    );
    mount.follow.handleTouchEnd(contactEvent(row, viewport, [[1, 400]], [[0, 300]]));
    clock.now += 2_000;
    assert.equal(mount.follow.hasScrollGesture(), true, 'the finger still on the transcript owns it');
    mount.follow.handleTouchEnd(contactEvent(other, viewport, [], [[1, 400]]));
    clock.now += 16;
    assert.equal(mount.follow.hasScrollGesture(), false, 'the second lift ends it');
  } finally {
    await mount.dispose();
  }
});

const IPHONE = {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
  maxTouchPoints: 5,
};

/** The follow hook over a 400 px viewport whose native offset the test owns,
 *  with the list's correction hold wired to it as TranscriptList wires it.
 *  `navigator` sets the engine (a touch hold exists on iOS WebKit only). */
async function touchHoldHarness(sessionKey, startTop, navigator) {
  const { createTouchScrollDeviation } = await import('./transcript-list-touch-deviation.ts');
  const state = {
    now: 700_000,
    native: startTop,
    writes: [],
    get follow() {
      return mount.follow;
    },
  };
  const mount = await mountFollowHook({ sessionKey, leafTag: 'div', leafId: 'space', clock: state, navigator });
  const { React, leaf: space, viewport, frame } = mount;
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => 40_400 });
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => state.native,
    set: (value) => {
      state.writes.push(value);
      state.native = Math.max(0, value);
    },
  });
  const deviation = createTouchScrollDeviation({
    getViewport: () => viewport,
    getSpacer: () => space,
    hasTouchScroll: () => state.follow.holdsScrollCorrections(),
    clampAtEdge: () => state.follow.touchHoldsCorrections(),
    markProgrammaticScroll: (top, intended) => state.follow.markProgrammaticScroll(top, intended),
  });
  const release = mount.registerGeometry(viewport, {
    viewportHeight: () => 400,
    contentHeight: () => 40_000,
    scrollTop: () => state.native,
    deviation: () => deviation.amount(),
  });
  const touch = (clientY) => ({
    target: space,
    currentTarget: viewport,
    touches: [{ clientY }],
    changedTouches: [{ identifier: 0, clientY }],
  });
  /** One momentum frame: the native offset moves, its scroll event runs
   *  (the list's offset observer lands an edge hold first), a frame passes. */
  const scroll = async (delta) => {
    state.now += 16;
    state.native += delta;
    deviation.landAtEdge();
    await React.act(async () => state.follow.handleScroll());
    await frame();
  };
  await React.act(async () => state.follow.handleScroll());
  return {
    state,
    space,
    viewport,
    deviation,
    frame,
    scroll,
    drag: async () => {
      await React.act(async () => {
        state.follow.handleTouchStart(touch(100));
        state.follow.handleTouchMove(touch(160));
      });
      await scroll(-60);
      state.follow.handleTouchEnd(lift());
    },
    touchStart: () => React.act(async () => state.follow.handleTouchStart(touch(300))),
    async dispose() {
      release();
      deviation.cancel();
      await mount.dispose();
    },
  };
}

// Chromium keeps a touch fling's momentum through a scrollTop write, so off iOS WebKit a landing page is written
// at once and the fling carries on into it.
test('an Android touch fling writes a page landed above it at once and flings on into the page', async () => {
  const harness = await touchHoldHarness('android-edge', 1_400);
  const { state, space, deviation } = harness;
  try {
    await harness.drag();
    // Older history (5,000 px) lands above the reader mid-fling.
    assert.equal(deviation.hold(state.native + 5_000), false, 'the landing is not held under the fling');
    // The list's scroll writer lands it natively (transcriptScrollTo).
    harness.viewport.scrollTop = state.native + 5_000;
    assert.equal(space.style.transform, '', 'no row offset');
    // The same momentum keeps going: it passes the old first row (5,000).
    for (let step = 0; step < 30; step += 1) await harness.scroll(-80);
    assert.equal(state.native, 3_940, 'the fling carries on past the old top into the page');
    assert.equal(deviation.amount(), 0);
    // A row measured into view mid-fling is written at once too.
    assert.equal(deviation.hold(state.native + 30), false, 'a measured-size correction is not held either');
  } finally {
    await harness.dispose();
  }
});

// iOS WebKit: a touch while a hold is pending keeps holding (away from native
// 0), and so does the finger's release for a moment — a lifted finger may
// still start a fling.
test('a touch after the fling stopped keeps a pending hold until the finger has been off for a moment', async () => {
  const harness = await touchHoldHarness('ios-retouch', 8_000, IPHONE);
  const { state, space, viewport, deviation } = harness;
  try {
    await harness.drag();
    for (let step = 0; step < 12; step += 1) await harness.scroll(-80);
    assert.equal(deviation.hold(state.native + 30), true);
    const settledAt = state.native + 30;
    viewport.dispatchEvent(new window.Event('scrollend'));
    await harness.touchStart();
    for (let step = 0; step < 3; step += 1) await harness.frame();
    assert.deepEqual(state.writes, [], 'the new touch postpones the landing');
    state.now += 2_000;
    await harness.frame();
    assert.deepEqual(state.writes, [], 'a resting finger keeps holding');
    state.follow.handleTouchEnd(lift());
    await harness.frame();
    assert.deepEqual(state.writes, [], 'a finger lifted a moment ago keeps holding');
    assert.equal(space.style.transform, 'translateY(-30px)');
    state.now += 160;
    await harness.frame();
    assert.deepEqual(state.writes, [settledAt], 'then the hold lands as one write');
  } finally {
    await harness.dispose();
  }
});

test('a hold waits out a rubber-band overscroll before it lands', async () => {
  const harness = await touchHoldHarness('touch-bounce', 39_600, IPHONE);
  const { state, viewport, deviation } = harness;
  try {
    await harness.drag();
    for (let step = 0; step < 12; step += 1) await harness.scroll(-10);
    // A row above shrinks mid-fling, then the fling bounces past the end.
    assert.equal(deviation.hold(state.native - 30), true);
    state.native = 40_060;
    state.now += 1_000;
    viewport.dispatchEvent(new window.Event('scrollend'));
    for (let step = 0; step < 3; step += 1) await harness.frame();
    assert.deepEqual(state.writes, [], 'nothing lands while the offset is past the end');
    state.native = 40_000;
    await harness.frame();
    assert.deepEqual(state.writes, [39_970], 'the bounce settled: the hold lands');
  } finally {
    await harness.dispose();
  }
});

/** A followed tail in jsdom: 2400px of content in a 400px viewport. */
async function tailHarness(sessionKey) {
  const state = {
    native: 2000,
    content: 2400,
    now: 200_000,
    restores: 0,
    get hook() {
      return mount.follow;
    },
  };
  const scrollToEndRef = { current: () => (state.restores += 1) };
  const mount = await mountFollowHook({
    sessionKey,
    clock: state,
    mutationObserver: true,
    hookOptions: { scrollToEndRef },
  });
  const { React, leaf: row, viewport } = mount;
  Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => state.native, set: () => {} });
  // A 400px box whose right 12px are its scrollbar's track.
  Object.defineProperty(viewport, 'offsetWidth', { configurable: true, value: 400 });
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 388 });
  viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400 });
  const release = mount.registerGeometry(viewport, {
    viewportHeight: () => 400,
    contentHeight: () => state.content,
    scrollTop: () => state.native,
    deviation: () => 0,
  });
  await React.act(async () => state.hook.handleScroll());
  state.now += 1_000;
  const pointerDown = (target, extra = {}) =>
    React.act(async () => state.hook.handlePointerDown({ target, currentTarget: viewport, button: 0, ...extra }));
  return {
    state,
    row,
    viewport,
    wheel: (event) =>
      React.act(() => {
        state.hook.handleWheel({ target: row, currentTarget: viewport, ...event });
      }),
    key: (event) =>
      React.act(() => {
        state.hook.handleKeyDown({ target: row, currentTarget: viewport, ...event });
      }),
    rearm: async () => {
      await React.act(async () => state.hook.arm());
      state.now += 1_000;
    },
    scroll: (top) => {
      state.native = top;
      return React.act(async () => state.hook.handleScroll());
    },
    /** The page changes under the reader: a node lands in the transcript. */
    mutate: () =>
      React.act(async () => {
        const node = document.createElement('span');
        viewport.appendChild(node);
        await Promise.resolve();
      }),
    pointerDown,
    /** A mouse press on the scrollbar's track. */
    pressBar: (extra = {}) => pointerDown(viewport, { pointerType: 'mouse', clientX: 394, ...extra }),
    act: (callback) => React.act(callback),
    frame: mount.frame,
    dispose: async () => {
      release();
      await mount.dispose();
    },
  };
}

test('a wheel releases follow only through the scroll its vertical upward notch makes the transcript itself take, not one a scroller inside it with room takes', async () => {
  const harness = await tailHarness('wheel-intent');
  const { state } = harness;
  try {
    // Pinch-zoom and a mostly-sideways swipe are not a scroll toward older rows: a move after them is put back.
    harness.wheel({ deltaY: -3, ctrlKey: true });
    harness.wheel({ deltaY: -3, deltaX: 12 });
    await harness.scroll(1900);
    assert.equal(state.hook.followingRef.current, true, 'neither a zoom nor a sideways swipe leaves the tail');
    await harness.scroll(2000);
    // A notch alone moves nothing: only the scroll it makes leaves.
    harness.wheel({ deltaY: -3 });
    assert.equal(state.hook.followingRef.current, true, 'a notch that scrolled nothing is not a leave');
    // A tick that moves the view no further than the end tolerance keeps the end.
    await harness.scroll(1999);
    assert.equal(state.hook.followingRef.current, true, 'a one-pixel tick keeps the end');
    await harness.scroll(2000);
    state.now += 1_000;
    // A diff frame that scrolls on its own (overflow auto, no marker) with room above takes the notch: the transcript
    // does not move. The notch lands on a field inside it that scrolls too but has nothing to scroll.
    let blockTop = 400;
    const block = document.createElement('div');
    block.className = 'tool-diff-frame';
    block.style.overflowY = 'auto';
    Object.defineProperty(block, 'scrollHeight', { value: 900 });
    Object.defineProperty(block, 'clientHeight', { value: 300 });
    Object.defineProperty(block, 'scrollTop', { get: () => blockTop });
    const field = document.createElement('dd');
    field.style.overflowY = 'auto';
    Object.defineProperty(field, 'scrollHeight', { value: 96 });
    Object.defineProperty(field, 'clientHeight', { value: 96 });
    block.appendChild(field);
    harness.viewport.appendChild(block);
    harness.wheel({ deltaY: -120, target: field });
    assert.equal(state.hook.followingRef.current, true, 'the diff frame scrolls; follow is kept');
    // Nor does that notch vouch for a move of the transcript the page makes right after it.
    await harness.mutate();
    state.now += 50;
    await harness.scroll(1990);
    assert.equal(state.hook.followingRef.current, true, "a layout move after the block's notch is put back");
    await harness.scroll(2000);
    state.now += 1_000;
    // At its top the block hands the notch to the transcript, which moves up: that leaves.
    blockTop = 0;
    harness.wheel({ deltaY: -120, target: block });
    await harness.scroll(1880);
    assert.equal(state.hook.followingRef.current, false, 'a notch the block cannot take leaves');
    // A box that overflows without scrolling takes nothing.
    await harness.rearm();
    await harness.scroll(2000);
    state.now += 1_000;
    const clipped = document.createElement('div');
    clipped.style.overflowY = 'hidden';
    Object.defineProperty(clipped, 'scrollHeight', { value: 900 });
    Object.defineProperty(clipped, 'clientHeight', { value: 300 });
    Object.defineProperty(clipped, 'scrollTop', { value: 400 });
    harness.viewport.appendChild(clipped);
    harness.wheel({ deltaY: -120, target: clipped });
    await harness.scroll(1880);
    assert.equal(state.hook.followingRef.current, false, 'a notch over a clipped box leaves');
    // A single upward notch on the text at the end leaves too.
    await harness.rearm();
    await harness.scroll(2000);
    state.now += 1_000;
    harness.wheel({ deltaY: -100 });
    await harness.scroll(1900);
    assert.equal(state.hook.followingRef.current, false, 'a single upward notch at the end leaves');
  } finally {
    await harness.dispose();
  }
});

test('a release is recorded where the scroll that let go took the view, with the input behind it', async () => {
  const harness = await tailHarness('release-record');
  const lines = [];
  window.mixdogDesktop = { perfLog: (line) => lines.push(line) };
  try {
    harness.wheel({ deltaY: -100 });
    await harness.scroll(1900);
    assert.equal(harness.state.hook.followingRef.current, false);
    assert.deepEqual(
      lines.filter((line) => line.startsWith('transcript-follow-release')),
      ['transcript-follow-release reason=scroll input=wheel top=1900 delta=-100 distance=100']
    );
  } finally {
    delete window.mixdogDesktop;
    await harness.dispose();
  }
});

test('a selection dragged out on a row holds follow: no end is written under it while output streams, and its collapse pins the end', async () => {
  const rig = await mountFollowRig({ sessionKey: 'selection-hold', startedAt: 600_000 });
  const { React, viewport, VIEWPORT, state, writes, flush, grow, advance } = rig;
  const hold = (held) => React.act(async () => rig.follow.handleSelectionHold(held));
  try {
    await React.act(async () => rig.follow.handleScroll());
    advance(1_000);
    await grow(40);
    assert.deepEqual(writes, [state.content - VIEWPORT], 'a following tail is pinned on growth');
    writes.length = 0;
    // The press on the reply's text and the selection it drags out (TranscriptList reports the selection's rows).
    const prose = document.createElement('p');
    prose.className = 'transcript-virtual-row-content';
    prose.textContent = 'A streamed reply the reader selects.';
    viewport.appendChild(prose);
    await React.act(async () =>
      rig.follow.handlePointerDown({ target: prose, currentTarget: viewport, button: 0, pointerType: 'mouse' })
    );
    await hold(true);
    const selectedAt = state.native;
    for (let token = 0; token < 4; token += 1) {
      advance(50);
      await grow(40);
    }
    assert.equal(rig.follow.followingRef.current, true, 'the selection never releases follow');
    assert.deepEqual(writes, [], 'no end is written under the selected text');
    assert.equal(state.native, selectedAt, 'the selected text does not move');
    // The selection collapses: the end is pinned again, and new output follows.
    await hold(false);
    await flush();
    assert.deepEqual(writes, [state.content - VIEWPORT], 'its collapse pins the end');
    advance(1_000);
    await grow(40);
    assert.equal(state.native, state.content - VIEWPORT, 'and new output follows');
    assert.equal(rig.follow.followingRef.current, true);
    // A selection made after the reader left holds nothing to take back.
    writes.length = 0;
    await React.act(async () => rig.follow.handleWheel({ deltaY: -100, target: viewport, currentTarget: viewport }));
    state.native -= 600;
    await React.act(async () => rig.follow.handleScroll());
    assert.equal(rig.follow.followingRef.current, false);
    await hold(true);
    await hold(false);
    advance(1_000);
    await grow(40);
    assert.deepEqual(writes, [], 'a released transcript is not pinned when its selection collapses');
  } finally {
    await rig.cleanup();
  }
});

test('a thumb dragged to the end and back up in one press holds corrections through the re-arm, until the press ends', async () => {
  const harness = await tailHarness('thumb-drag-rearm');
  const { state } = harness;
  try {
    await harness.pressBar();
    assert.equal(state.hook.holdsScrollCorrections(), true, 'held while the thumb is');
    // The thumb reaches the end: following re-arms under the press.
    await harness.act(async () => state.hook.arm());
    state.now += 5_000;
    assert.equal(
      state.hook.holdsScrollCorrections(),
      true,
      'the press is still down: no offset is written under the thumb'
    );
    // Dragged back up in the same press.
    await harness.scroll(1700);
    assert.equal(state.hook.holdsScrollCorrections(), true);
    await harness.act(async () => window.dispatchEvent(new window.Event('pointerup')));
    state.now += 1_100;
    assert.equal(state.hook.holdsScrollCorrections(), false, 'the hold ends with its press');
  } finally {
    await harness.dispose();
  }
});

test('a thumb dragged up lets go of the end whatever the content did before the press', async () => {
  const harness = await tailHarness('thumb-after-shrink');
  const { state, viewport } = harness;
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => state.content });
  try {
    // The reader reads above the end, at the full extent.
    harness.wheel({ deltaY: -100 });
    await harness.scroll(1500);
    assert.equal(state.hook.followingRef.current, false);
    // A card closes meanwhile, far from the view: the content shrinks with no scroll event.
    state.content = 2200;
    await harness.rearm();
    await harness.scroll(1800);
    assert.equal(state.hook.followingRef.current, true, 'back at the end');
    // The thumb is pressed and dragged up: the move is the press's own.
    await harness.pressBar();
    await harness.scroll(1600);
    assert.equal(state.hook.followingRef.current, false, 'the drag lets go of the end');
    await harness.act(async () => window.dispatchEvent(new window.Event('pointerup')));
    // Under a held press, a shrink still clamps the offset up by itself: that move is not the press's.
    await harness.rearm();
    await harness.scroll(1800);
    await harness.pressBar();
    state.content = 2100;
    await harness.scroll(1700);
    assert.equal(state.hook.followingRef.current, true, 'a clamp under the press keeps the end');
  } finally {
    await harness.dispose();
  }
});

test('a scroll key and a pressed scrollbar hold corrections off the native offset until their scrolls go quiet', async () => {
  const harness = await tailHarness('native-gesture-hold');
  const { state, row } = harness;
  try {
    assert.equal(state.hook.holdsScrollCorrections(), false);
    harness.key({ key: 'PageUp', target: row });
    assert.equal(state.hook.holdsScrollCorrections(), true, 'the key owns the scroll it causes');
    state.now += 100;
    await harness.scroll(1700);
    state.now += 100;
    assert.equal(state.hook.holdsScrollCorrections(), true, 'its scrolls extend the hold');
    state.now += 1_100;
    assert.equal(state.hook.holdsScrollCorrections(), false, 'quiet ends it');
    // The scrollbar: its track is pressed, and held however long the thumb rests.
    await harness.pressBar();
    state.now += 5_000;
    assert.equal(state.hook.holdsScrollCorrections(), true, 'held while the thumb is');
    await harness.act(async () => state.hook.handlePointerUp());
    assert.equal(state.hook.holdsScrollCorrections(), true, 'and through the scroll it leaves');
    state.now += 1_100;
    assert.equal(state.hook.holdsScrollCorrections(), false);
  } finally {
    await harness.dispose();
  }
});

test('an up key opens a window: the scroll it causes leaves, a key that scrolls nothing does not', async () => {
  const harness = await tailHarness('key-window');
  const { state, row, viewport } = harness;
  try {
    const field = document.createElement('input');
    viewport.appendChild(field);
    harness.key({ key: 'PageUp', ctrlKey: true });
    harness.key({ key: 'ArrowUp', target: field });
    assert.equal(state.hook.hasScrollGesture(), false, 'a shortcut and a field caret open no window');
    // The timeline just wrote: without a vouching key the move is its own.
    state.hook.markProgrammaticScroll(1500);
    state.now += 50;
    await harness.scroll(1900);
    assert.equal(state.hook.followingRef.current, true, 'inside the write window an unvouched move is put back');
    await harness.rearm();
    harness.key({ key: 'ArrowUp', target: row });
    assert.equal(state.hook.followingRef.current, true, 'the key alone does not leave');
    assert.equal(state.hook.hasScrollGesture(), true, 'but it keeps the end pin off while the scroll lands');
    state.hook.markProgrammaticScroll(1500);
    state.now += 50;
    await harness.scroll(1800);
    assert.equal(state.hook.followingRef.current, false, 'the scroll it caused leaves, write window or not');
    await harness.rearm();
    harness.key({ key: ' ', shiftKey: true, target: row });
    state.now += 1_100;
    assert.equal(state.hook.hasScrollGesture(), false, 'the window passes');
    state.hook.markProgrammaticScroll(1500);
    state.now += 50;
    await harness.scroll(1700);
    assert.equal(state.hook.followingRef.current, true, 'a Shift+Space that scrolled nothing never left');
  } finally {
    await harness.dispose();
  }
});

test('an upward move no input of the reader explains is put back, however long the page was quiet', async () => {
  const harness = await tailHarness('streaming-mutation');
  const { state } = harness;
  try {
    // Streaming: nodes land and the page shifts under the reader (typing during
    // parallel work). The move is not intent.
    await harness.mutate();
    state.now += 100;
    const before = state.restores;
    await harness.scroll(1990);
    assert.equal(state.hook.followingRef.current, true, 'a layout-driven move up keeps follow');
    assert.equal(state.restores, before + 1, 'and puts the viewport back at the end');
    // The same move with the page quiet for long: a clamp to a shrunken extent is no input either.
    state.now += 5_000;
    await harness.scroll(1930);
    assert.equal(state.hook.followingRef.current, true, 'nothing of the reader explains it: it is put back');
    assert.equal(state.restores, before + 2);
  } finally {
    await harness.dispose();
  }
});

test('a delayed upward event on the exact written offset stays pinned', async () => {
  const harness = await tailHarness('exact-write-unpin');
  const { state } = harness;
  try {
    state.hook.markProgrammaticScroll(1500);
    state.now += 5_000;
    await harness.scroll(1500);
    assert.equal(state.hook.followingRef.current, true, "no reader input: the timeline's own landing");
    harness.wheel({ deltaY: -100 });
    await harness.scroll(1400);
    assert.equal(state.hook.followingRef.current, false, "a spent value excuses nothing the reader's notch moved");
  } finally {
    await harness.dispose();
  }
});

test('a question card brought into view as it takes focus moves a followed transcript as the app, not as its reader', async () => {
  const { focusCardWhenIdle } = await import('./question-card-keys.ts');
  const harness = await tailHarness('card-into-view');
  const { state, row: card } = harness;
  try {
    card.scrollIntoView = () => (state.native = 1700);
    const before = state.restores;
    await harness.act(async () => {
      focusCardWhenIdle(card);
      state.hook.handleScroll();
    });
    assert.equal(state.hook.followingRef.current, true, 'the card scrolled into view keeps follow');
    assert.equal(state.restores, before + 1, 'and the end is put back');
  } finally {
    await harness.dispose();
  }
});

test('a focus that scrolls a row of a followed transcript into view is the app, not its reader', async () => {
  const { ownedFocus } = await import('./own-scroll-writes.ts');
  const harness = await tailHarness('focus-scrolls');
  const { state, row } = harness;
  try {
    row.focus = () => (state.native = 1700);
    const before = state.restores;
    await harness.act(async () => {
      ownedFocus(row);
      state.hook.handleScroll();
    });
    assert.equal(state.hook.followingRef.current, true, 'the focused row scrolled into view keeps follow');
    assert.equal(state.restores, before + 1, 'and the end is put back');
  } finally {
    await harness.dispose();
  }
});

test('an arrow key in a question card that moves the focus to an option above the view scrolls as the reader: the option stays in view and follow lets go', async () => {
  const state = { native: 2000, now: 400_000, restores: 0 };
  const { restore, window } = installTestDom(null, {
    html: "<div id='root'></div>",
    jsdom: { url: 'http://localhost/', pretendToBeVisual: true },
    expose: [
      'Element',
      'HTMLElement',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      'HTMLButtonElement',
      'Node',
      'navigator',
    ],
  });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.Element.prototype.scrollIntoView = () => {};
  const realNow = Date.now;
  Date.now = () => state.now;
  const [React, { createRoot }, { useTranscriptFollow, registerTranscriptScrollGeometry }, { QuestionCard }] =
    await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('./use-transcript-follow.ts'),
      import('./QuestionCard.tsx'),
    ]);
  const scrollToEndRef = { current: () => (state.restores += 1) };
  const questions = [
    { question: 'Which?', header: 'W', options: ['A', 'B', 'C'].map((label) => ({ label, description: '' })) },
  ];
  let follow = null;
  function Harness() {
    const viewport = React.useRef(null);
    const content = React.useRef(null);
    follow = useTranscriptFollow({ viewport, content, sessionKey: 'card-keys', scrollToEndRef });
    return React.createElement(
      'div',
      { ref: viewport, className: 'conversation' },
      React.createElement(
        'div',
        { ref: content },
        React.createElement(QuestionCard, { questions, resolve: async () => true })
      )
    );
  }
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(Harness)));
  const viewport = document.querySelector('.conversation');
  Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => state.native, set: () => {} });
  const release = registerTranscriptScrollGeometry(viewport, {
    viewportHeight: () => 400,
    contentHeight: () => 2400,
    scrollTop: () => state.native,
    deviation: () => 0,
  });
  try {
    await React.act(async () => follow.handleScroll());
    state.now += 1_000;
    const card = document.activeElement;
    assert.ok(card?.matches('.question-card'), `the card took focus when it appeared (${card?.className})`);
    // The card is taller than the pane: its first option sits above the view, and focusing it scrolls up to it.
    const first = document.querySelector('.question-option');
    const focus = first.focus.bind(first);
    first.focus = () => {
      focus();
      state.native = 1700;
    };
    const before = state.restores;
    await React.act(async () => {
      card.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      follow.handleScroll();
    });
    assert.equal(document.activeElement, first, 'the key moved the focus to the first option');
    assert.equal(follow.followingRef.current, false, "the reader's key scroll lets go of the end");
    assert.equal(state.restores, before, 'the view is not put back at the end');
    assert.equal(state.native, 1700, 'the focused option stays in view');
  } finally {
    release();
    Date.now = realNow;
    await React.act(async () => root.unmount());
    restore();
  }
});

test('a stationary press on prose does not vouch for a streaming correction; scrollbar and selection autoscroll do', async () => {
  const harness = await tailHarness('prose-press');
  const { state, row } = harness;
  try {
    await harness.pointerDown(row);
    state.hook.markProgrammaticScroll(1500);
    state.now += 50;
    await harness.scroll(1900);
    assert.equal(state.hook.followingRef.current, true, 'a click on prose keeps follow through a correction');
    await harness.rearm();
    await harness.pointerDown(row);
    await harness.act(async () => state.hook.handleSelectionAutoScroll(-8));
    state.hook.markProgrammaticScroll(1500);
    state.now += 50;
    await harness.scroll(1800);
    assert.equal(state.hook.followingRef.current, false, 'a selection drag that autoscrolls up leaves');
    await harness.rearm();
    // A press on the scroller's padding is no scrollbar: it vouches for nothing.
    await harness.pointerDown(harness.viewport, { pointerType: 'mouse', clientX: 20 });
    await harness.scroll(1750);
    assert.equal(state.hook.followingRef.current, true, 'a press on the padding keeps follow through a clamp');
    await harness.act(async () => state.hook.handlePointerUp());
    await harness.rearm();
    await harness.pressBar();
    state.hook.markProgrammaticScroll(1500);
    state.now += 50;
    await harness.scroll(1700);
    assert.equal(state.hook.followingRef.current, false, 'a scrollbar press leaves');
  } finally {
    await harness.dispose();
  }
});

test('updating an existing text node is a layout change that explains an upward scroll', async () => {
  const harness = await tailHarness('text-update');
  const { state, viewport } = harness;
  try {
    const text = document.createTextNode('a');
    viewport.appendChild(text);
    await harness.mutate();
    state.now += 1_000;
    await harness.act(async () => {
      text.data = 'ab';
      await Promise.resolve();
    });
    state.now += 100;
    await harness.scroll(1930);
    assert.equal(state.hook.followingRef.current, true, 'the streamed text edit explains the move');
  } finally {
    await harness.dispose();
  }
});

test('a move off the offset the timeline wrote is put back; its landing at the end never re-engages', async () => {
  const harness = await tailHarness('write-window');
  const { state } = harness;
  try {
    state.hook.markProgrammaticScroll(1500);
    state.now += 100;
    await harness.scroll(1700);
    assert.equal(state.hook.followingRef.current, true, 'a move after the write keeps follow');
    state.now += 100;
    await harness.scroll(1650);
    assert.equal(state.hook.followingRef.current, true, 'and so does the next one: no time makes it the reader');
    harness.wheel({ deltaY: -100 });
    await harness.scroll(1600);
    assert.equal(state.hook.followingRef.current, false, "the reader's notch leaves");
    // Released and parked 400px up. The timeline lands exactly on the end.
    state.hook.markProgrammaticScroll(2000);
    state.now += 5_000;
    await harness.scroll(2000);
    assert.equal(state.hook.followingRef.current, false, 'its own landing at the end is not the reader arriving');
    await harness.scroll(1900);
    await harness.scroll(2000);
    assert.equal(state.hook.followingRef.current, true, 'the reader scrolling down onto the end is');
  } finally {
    await harness.dispose();
  }
});

test('a held press, a lift from above the end, and a finger down each vouch for an upward scroll', async () => {
  const harness = await tailHarness('corroboration');
  const { state, viewport } = harness;
  try {
    await harness.mutate();
    await harness.pressBar();
    state.now += 50;
    await harness.scroll(1900);
    assert.equal(state.hook.followingRef.current, false, 'a held press beats a layout change');
    await harness.rearm();
    // The press ended (mouseup), so it vouches for nothing.
    await harness.pressBar();
    document.dispatchEvent(new window.Event('mouseup'));
    await harness.mutate();
    state.now += 50;
    await harness.scroll(1800);
    assert.equal(state.hook.followingRef.current, true, 'a released press is only a layout change');
    await harness.rearm();
    // A press inside a nested scroller is that scroller's: it vouches for nothing.
    const block = document.createElement('div');
    block.style.overflowY = 'auto';
    Object.defineProperty(block, 'scrollHeight', { value: 900 });
    Object.defineProperty(block, 'clientHeight', { value: 300 });
    viewport.appendChild(block);
    state.hook.markProgrammaticScroll(1500);
    await harness.pointerDown(block);
    state.now += 50;
    await harness.scroll(1700);
    assert.equal(state.hook.followingRef.current, true, 'inside the write window the move is put back');
    await harness.rearm();
    state.hook.markProgrammaticScroll(1500);
    await harness.pressBar();
    state.now += 50;
    await harness.scroll(1600);
    assert.equal(state.hook.followingRef.current, false, "a held press on the transcript's scrollbar leaves");
  } finally {
    await harness.dispose();
  }
});

test('a finger lifted above the end vouches for the momentum scrolls after it', async () => {
  const harness = await tailHarness('touch-momentum');
  const { state, row, viewport } = harness;
  try {
    const touch = (clientY) => ({
      target: row,
      currentTarget: viewport,
      touches: [{ clientY }],
      changedTouches: [{ identifier: 0, clientY }],
    });
    state.hook.handleTouchStart(touch(100));
    // The timeline wrote while the finger was down, and the finger travelled
    // less than a tap: the lift has no scroll of its own to judge.
    state.hook.markProgrammaticScroll(1700);
    state.native = 1700;
    await harness.act(async () => state.hook.handleTouchEnd(lift()));
    assert.equal(state.hook.followingRef.current, true, 'the lift alone leaves nothing');
    state.now += 300;
    await harness.mutate();
    await harness.scroll(1650);
    assert.equal(state.hook.followingRef.current, false, 'the momentum scroll after a lift from above the end leaves');
  } finally {
    await harness.dispose();
  }
});

test('a press, Enter or Space on a control in the followed transcript keeps following, as prose and code do', async () => {
  const harness = await tailHarness('press-control');
  const { state, row, viewport } = harness;
  try {
    const button = document.createElement('button');
    const label = document.createElement('span');
    button.appendChild(label);
    const code = document.createElement('pre');
    viewport.append(button, code);
    for (const target of [row, code, viewport, label, button]) {
      await harness.pointerDown(target);
      await harness.act(async () => window.dispatchEvent(new window.Event('pointerup')));
    }
    for (const target of [row, button]) {
      harness.key({ key: 'Enter', target });
      harness.key({ key: ' ', target });
      harness.key({ key: ' ', shiftKey: true, target });
    }
    assert.equal(state.hook.followingRef.current, true, 'no press or activation lets go of the end');
    assert.equal(state.hook.following, true, 'and the end is still kept');
    // The reply grows under the clicked control: an unvouched move up is put back.
    state.now += 1_100;
    const before = state.restores;
    await harness.scroll(1900);
    assert.equal(state.hook.followingRef.current, true);
    assert.equal(state.restores, before + 1, 'the end is asked for again');
  } finally {
    await harness.dispose();
  }
});

test('a reader who pages up and straight back down to the end with the keys follows again', async () => {
  const rig = await mountFollowRig({ sessionKey: 'key-return', startedAt: 600_000 });
  const { React, viewport, VIEWPORT, state, frame, flush, grow, advance } = rig;
  const scroll = (to) => {
    state.native = to;
    return React.act(async () => rig.follow.handleScroll());
  };
  const key = (name) => React.act(async () => rig.follow.handleKeyDown({ key: name, target: viewport }));
  try {
    await scroll(state.native);
    advance(1_000);
    await key('PageUp');
    await scroll(state.native - 350);
    assert.equal(rig.follow.followingRef.current, false, 'the page up lets go');
    advance(300);
    await key('End');
    await scroll(state.content - VIEWPORT);
    assert.equal(rig.follow.followingRef.current, true, "back at the end inside the up key's window: following again");
    advance(1_000);
    await frame();
    await flush();
    await grow(40);
    assert.equal(state.native, state.content - VIEWPORT, 'and the reply streaming on is followed');
  } finally {
    await rig.cleanup();
  }
});

test("pressing a reply's copy control at the followed end keeps following", async () => {
  const harness = await tailHarness('copy-control');
  const { state, viewport } = harness;
  const [React, { createRoot }, { CopyControl }] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./transcript-primitives.tsx'),
  ]);
  const host = document.createElement('div');
  viewport.appendChild(host);
  const copy = createRoot(host);
  try {
    await harness.act(async () => copy.render(React.createElement(CopyControl, { label: 'Copy', value: 'the reply' })));
    const button = host.querySelector('button');
    assert.ok(button, 'the control renders its button');
    await harness.pointerDown(button.firstElementChild ?? button);
    harness.key({ key: 'Enter', target: button });
    assert.equal(state.hook.followingRef.current, true, 'copying changes nothing under the reader');
  } finally {
    await harness.act(async () => copy.unmount());
    await harness.dispose();
  }
});

test('answering the question card at the followed end keeps following the reply after it', async () => {
  const harness = await tailHarness('question-card-answer');
  const { state, viewport } = harness;
  const [React, { createRoot }, { QuestionCard }] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./QuestionCard.tsx'),
  ]);
  window.Element.prototype.scrollIntoView = () => {};
  const host = document.createElement('div');
  viewport.appendChild(host);
  const card = createRoot(host);
  try {
    const questions = [
      { question: 'Which topic next?', header: 'Topic', options: [{ label: 'Cats' }, { label: 'Birds' }] },
    ];
    await harness.act(async () =>
      card.render(React.createElement(QuestionCard, { questions, resolve: () => new Promise(() => {}) }))
    );
    // The live press lands on the option's label text, inside its button.
    const label = host.querySelector('.question-option .question-option-label');
    assert.ok(label, 'the card renders its options');
    await harness.pointerDown(label);
    assert.equal(state.hook.followingRef.current, true, 'picking an option keeps the tail followed');
    for (const target of [
      host.querySelector('.question-close'),
      host.querySelector('.question-other input'),
      host.querySelector('[data-primary]'),
    ]) {
      await harness.pointerDown(target);
      harness.key({ key: 'Enter', target });
    }
    assert.equal(state.hook.followingRef.current, true, "none of the card's controls lets go of the tail");
  } finally {
    await harness.act(async () => card.unmount());
    await harness.dispose();
  }
});

test('the jump control shows only while follow is off and the end is more than 200px away', async () => {
  const harness = await tailHarness('jump-state');
  const { state } = harness;
  try {
    const frame = harness.frame;
    state.hook.markProgrammaticScroll(1700);
    await harness.scroll(1700);
    await frame();
    assert.equal(state.hook.followingRef.current, true);
    assert.equal(state.hook.showJump, false, 'following hides it, however far the end is');
    state.now += 1_000;
    harness.wheel({ deltaY: -100 });
    await harness.scroll(1650);
    await frame();
    await frame();
    assert.equal(state.hook.followingRef.current, false);
    assert.equal(state.hook.showJump, true, 'released and 350px from the end');
    state.now += 1_000;
    await harness.scroll(1850);
    await frame();
    assert.equal(state.hook.followingRef.current, false, '150px above the end stays unpinned');
    assert.equal(state.hook.showJump, true, 'jump control stays visible while unpinned above the bottom');
    state.now += 100;
    await harness.scroll(2000);
    await frame();
    assert.equal(state.hook.followingRef.current, true, 'reaching the bottom follows again');
    assert.equal(state.hook.showJump, false, 'reaching the bottom hides the jump control');
  } finally {
    await harness.dispose();
  }
});

test('a scrollbar press stops vouching for scrolls after fifteen seconds', async () => {
  const harness = await tailHarness('scrollbar-hold');
  const { state } = harness;
  try {
    await harness.pressBar();
    state.now += 1_000;
    await harness.scroll(1940);
    assert.equal(state.hook.followingRef.current, false, 'a drag on the scrollbar leaves the tail');
    await harness.rearm();
    // The release of the press was lost (the pointer left the window).
    await harness.pressBar();
    await harness.mutate();
    state.now += 16_000;
    await harness.mutate();
    state.now += 100;
    await harness.scroll(1880);
    assert.equal(state.hook.followingRef.current, true, 'a press older than 15s is only a layout change');
  } finally {
    await harness.dispose();
  }
});

test('a zoom change rounding the offset by a device pixel is put back, not a leave', async () => {
  const harness = await tailHarness('zoom');
  const { state } = harness;
  const realRatio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  try {
    state.hook.markProgrammaticScroll(1990);
    await harness.scroll(1990);
    state.now += 1_000;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    const before = state.restores;
    await harness.scroll(1989.7);
    assert.equal(state.hook.followingRef.current, true);
    assert.equal(state.restores, before + 1);
    harness.wheel({ deltaY: -100 });
    await harness.scroll(1950);
    assert.equal(state.hook.followingRef.current, false, "the reader's move at the same zoom still leaves");
  } finally {
    if (realRatio) Object.defineProperty(window, 'devicePixelRatio', realRatio);
    else delete window.devicePixelRatio;
    await harness.dispose();
  }
});

/** The follow hook over a 400px viewport whose offset (`state.native`) and content height (`state.content`) the test
 *  owns. `resize` changes the content as a folding row, a closing dock or a growing window does: no scroll event, only
 *  the content observer. The end pin is a counter (`restores`); anchor flips are recorded (`anchors`). */
async function endHarness(sessionKey, { pane = '' } = {}) {
  const observers = new Set();
  class ContentObserver {
    constructor(callback) {
      this.callback = callback;
      observers.add(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      observers.delete(this);
    }
  }
  const state = { native: 2000, content: 2400, now: 900_000, restores: 0, anchors: [] };
  const mount = await mountFollowHook({
    sessionKey,
    clock: state,
    pane,
    globals: { ResizeObserver: ContentObserver },
    hookOptions: {
      scrollToEndRef: { current: () => (state.restores += 1) },
      setAnchorBottomRef: { current: (bottom) => state.anchors.push(bottom) },
    },
  });
  const { React, viewport } = mount;
  Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => state.native, set: () => {} });
  const release = mount.registerGeometry(viewport, {
    viewportHeight: () => 400,
    contentHeight: () => state.content,
    scrollTop: () => state.native,
    deviation: () => 0,
  });
  await React.act(async () => mount.follow.handleScroll());
  await mount.frame();
  state.now += 1_000;
  return {
    state,
    viewport,
    get follow() {
      return mount.follow;
    },
    enter: mount.enter,
    frame: mount.frame,
    act: (callback) => React.act(callback),
    /** A scroll event at `top`, then a frame. */
    scroll: async (top) => {
      state.native = top;
      await React.act(async () => mount.follow.handleScroll());
      await mount.frame();
    },
    resize: async (content) => {
      state.content = content;
      await React.act(async () => {
        for (const observer of [...observers]) observer.callback([]);
      });
      await mount.frame();
    },
    /** The jump control and follow as the reader sees them. */
    shown: () => ({ following: mount.follow.following, jump: mount.follow.showJump }),
    dispose: async () => {
      release();
      await mount.dispose();
    },
  };
}

test('the jump control shows exactly when the end is not kept: 0, 1, 100 and 300px from it, with follow on, off and held', async () => {
  const h = await endHarness('jump-control');
  try {
    const seen = {};
    for (const distance of [0, 1, 100, 300]) {
      await h.resize(2400 + distance);
      await h.act(async () => h.follow.arm());
      await h.frame();
      seen[`on ${distance}`] = h.shown();
      await h.act(async () => h.follow.handleSelectionHold(true));
      await h.frame();
      seen[`held ${distance}`] = h.shown();
      await h.act(async () => h.follow.handleSelectionHold(false));
      await h.act(async () => h.follow.pause());
      await h.frame();
      seen[`off ${distance}`] = h.shown();
    }
    const kept = { following: true, jump: false };
    // A held selection keeps the end unwritten: follow says so as the jump control does, never one without the other.
    const held = { following: false, jump: false };
    assert.deepEqual(seen, {
      'on 0': kept,
      'held 0': held,
      // Standing at the end is following: let go there, the view takes follow back.
      'off 0': kept,
      'on 1': kept,
      'held 1': held,
      'off 1': kept,
      'on 100': kept,
      'held 100': { following: false, jump: true },
      'off 100': { following: false, jump: true },
      'on 300': kept,
      'held 300': { following: false, jump: true },
      'off 300': { following: false, jump: true },
    });
  } finally {
    await h.dispose();
  }
});

test('the distance changing with no scroll event: into the band shows the jump control, onto the end follows again', async () => {
  const h = await endHarness('resize-band');
  const { state } = h;
  try {
    // The reader scrolls 600px up, then back down to 400px above the end: outside the band, so still let go.
    await h.act(async () => h.follow.handleWheel({ deltaY: -100, target: h.viewport, currentTarget: h.viewport }));
    await h.scroll(1400);
    state.now += 1_000;
    await h.act(async () => h.follow.handleWheel({ deltaY: 100, target: h.viewport, currentTarget: h.viewport }));
    await h.scroll(1600);
    state.now += 1_000;
    await h.frame();
    assert.deepEqual(h.shown(), { following: false, jump: true });
    // A row below folds: the end comes 100px below the view, though the reader did not scroll there.
    await h.resize(2100);
    assert.deepEqual(
      h.shown(),
      { following: false, jump: true },
      'in the band: the jump control says the end is not kept'
    );
    // A scroll event that moves nothing (a layout pass) does not count as the reader coming back.
    await h.scroll(1600);
    assert.deepEqual(h.shown(), { following: false, jump: true }, 'resting in the band is not coming back');
    // The timeline writes the view down into the band: not the reader either.
    await h.resize(2400);
    h.follow.markProgrammaticScroll(1850);
    await h.scroll(1850);
    state.now += 1_000;
    await h.scroll(1850);
    assert.deepEqual(
      h.shown(),
      { following: false, jump: true },
      "the timeline's own write is not the reader coming back"
    );
    // The dock closes and the window grows: the view stands at the end. It follows, and nothing is shown.
    await h.resize(2250);
    assert.deepEqual(h.shown(), { following: true, jump: false }, 'standing at the end is following');
  } finally {
    await h.dispose();
  }
});

test('a search hit opened from the end: follow waits while the place is opened, then the view at the end follows and one in the band shows the jump control', async () => {
  const { openReaderPlace, voidReaderPlace } = await import('./transcript-list-reader-place.ts');
  const h = await endHarness('hit-session', { pane: 'hit-pane' });
  const { state } = h;
  try {
    // useTranscriptJump: the pane leaves the tail and the list is handed the hit's place.
    await h.act(async () => {
      h.follow.pause();
      openReaderPlace('hit-pane', 'hit-session', { position: 'p1', top: 'center' });
    });
    for (let frame = 0; frame < 3; frame += 1) await h.frame();
    assert.deepEqual(
      h.shown(),
      { following: false, jump: false },
      'the place being opened is the reader’s, still in flight'
    );
    // The hit's row lies at the end: the list puts the reader there (the place is taken).
    await h.act(async () => voidReaderPlace('hit-pane', 'hit-session'));
    await h.scroll(2000);
    assert.deepEqual(h.shown(), { following: true, jump: false }, 'a hit at the end follows');
    // A hit centred 100px above the end.
    await h.act(async () => {
      h.follow.pause();
      openReaderPlace('hit-pane', 'hit-session', { position: 'p2', top: 'center' });
    });
    h.follow.markProgrammaticScroll(1900);
    await h.scroll(1900);
    await h.act(async () => voidReaderPlace('hit-pane', 'hit-session'));
    state.now += 1_000;
    await h.scroll(1900);
    assert.deepEqual(h.shown(), { following: false, jump: true }, 'a hit in the band shows the jump control');
  } finally {
    await h.dispose();
  }
});

test('entering another session starts with no selection hold: its end is anchored from the entry', async () => {
  const h = await endHarness('held-before');
  const { state } = h;
  try {
    await h.act(async () => h.follow.handleSelectionHold(true));
    assert.equal(state.anchors.at(-1), false, 'the selection holds the end');
    // The pane enters another session; its arm runs before the old list lets go of its selection.
    await h.enter('entered');
    await h.act(async () => h.follow.arm());
    assert.equal(state.anchors.at(-1), true, 'the entered session is anchored at its end');
    // The old list's late report of its selection ending changes nothing.
    await h.act(async () => h.follow.handleSelectionHold(false));
    assert.equal(state.anchors.at(-1), true);
    assert.deepEqual(h.shown(), { following: true, jump: false });
  } finally {
    await h.dispose();
  }
});

test('a pressed scrollbar whose release is lost ends when chromePressHeld lets go of it: corrections land, and a view at the end follows', async () => {
  const harness = await tailHarness('lost-thumb');
  const { state } = harness;
  try {
    await harness.pressBar();
    // Let go at the end under the held thumb: the press is the reader's, in flight.
    await harness.act(async () => state.hook.pause());
    state.now += 14_000;
    await harness.frame();
    assert.equal(state.hook.holdsScrollCorrections(), true, 'a thumb held a long time is still held');
    assert.equal(state.hook.followingRef.current, false, 'the view at the end waits for the thumb');
    // No pointerup ever comes.
    state.now += 1_000;
    await harness.frame();
    assert.equal(state.hook.holdsScrollCorrections(), false, 'the press ends as chromePressHeld ends it');
    assert.equal(state.hook.followingRef.current, true, 'and the view at the end follows again');
  } finally {
    await harness.dispose();
  }
});

test('a thumb dragged down to the bottom takes follow back when let go, not while held and not 150px above', async () => {
  const harness = await tailHarness('thumb-into-band');
  const { state } = harness;
  try {
    await harness.act(async () => state.hook.pause());
    await harness.scroll(1400);
    state.now += 1_000;
    await harness.pressBar();
    state.now += 50;
    await harness.scroll(1850);
    await harness.act(async () => window.dispatchEvent(new window.Event('pointerup')));
    assert.equal(state.hook.followingRef.current, false, 'let go 150px above the end: stays unpinned');
    state.now += 100;
    await harness.pressBar();
    state.now += 50;
    await harness.scroll(1998);
    assert.equal(state.hook.followingRef.current, false, 'held at the bottom: not yet');
    const before = state.restores;
    await harness.act(async () => window.dispatchEvent(new window.Event('pointerup')));
    assert.equal(state.hook.followingRef.current, true, 'let go at the bottom: follow is taken back');
    assert.equal(state.restores, before + 1, 'and the end is asked for');
  } finally {
    await harness.dispose();
  }
});

test('a selection autoscroll released over the composer ends its press there: scrolling back to the bottom follows again', async () => {
  const harness = await tailHarness('selection-release-outside');
  const { state, row } = harness;
  const composer = document.createElement('div');
  document.body.appendChild(composer);
  try {
    await harness.act(async () => state.hook.pause());
    await harness.scroll(1400);
    state.now += 1_000;
    await harness.pointerDown(row);
    await harness.act(async () => state.hook.handleSelectionAutoScroll(8));
    state.now += 50;
    await harness.act(async () => composer.dispatchEvent(new window.Event('pointerup', { bubbles: true })));
    state.now += 1_000;
    await harness.scroll(1850);
    assert.equal(state.hook.followingRef.current, false, '150px above bottom does not snap follow back');
    await harness.scroll(2000);
    assert.equal(
      state.hook.followingRef.current,
      true,
      'the press ended at its release: reaching bottom takes follow back'
    );
  } finally {
    composer.remove();
    await harness.dispose();
  }
});

test('returning to bottom during streaming clears stale upward wheel input so a layout clamp stays pinned', async () => {
  const harness = await tailHarness('streaming-bottom-return');
  const { state } = harness;
  try {
    harness.wheel({ deltaY: -120 });
    await harness.scroll(1400);
    assert.equal(state.hook.followingRef.current, false, 'scrolled up');
    // Immediately return to bottom within the wheelUpRecent window via resume/jump.
    state.now += 50;
    await harness.act(async () => state.hook.resume());
    assert.equal(state.hook.followingRef.current, true, 're-pinned at bottom');
    // Streaming layout clamp moves scrollTop up by 3px right after re-pinning without any new upward input.
    state.now += 20;
    await harness.scroll(1997);
    assert.equal(
      state.hook.followingRef.current,
      true,
      'stale upward input was cleared, so clamp restores instead of unpinning'
    );
  } finally {
    await harness.dispose();
  }
});

test('holding thumb at the bottom while streaming appends height before pointer release still pins cleanly', async () => {
  const harness = await tailHarness('thumb-held-during-stream');
  const { state } = harness;
  try {
    await harness.act(async () => state.hook.pause());
    await harness.scroll(1400);
    state.now += 1_000;
    await harness.pressBar();
    state.now += 50;
    // Reader drags thumb all the way to the current bottom (2000).
    await harness.scroll(2000);
    assert.equal(state.hook.followingRef.current, false, 'held at bottom: waits for pointer release');
    // Before rAF or pointerup, a streamed row appends 120px to the transcript.
    state.content += 120;
    const before = state.restores;
    await harness.act(async () => window.dispatchEvent(new window.Event('pointerup')));
    assert.equal(state.hook.followingRef.current, true, 'releasing preserves recorded bottom arrival and pins');
    assert.equal(state.restores, before + 1, 'pin restores to the newly grown bottom');
  } finally {
    await harness.dispose();
  }
});

test('reversing a held drag after streaming growth does not snap back to bottom on release', async () => {
  const harness = await tailHarness('thumb-reverse-after-growth');
  const { state } = harness;
  try {
    await harness.act(async () => state.hook.pause());
    await harness.scroll(1400);
    await harness.frame();
    state.now += 1_000;
    await harness.pressBar();
    state.now += 50;
    // Thumb reaches the bottom (2000).
    await harness.scroll(2000);
    // Streaming appends 120px (new bottom 2120) before the first rAF runs.
    state.content += 120;
    await harness.frame();
    // Reader drags further down to 2080, then deliberately reverses up to 2050.
    state.now += 50;
    await harness.scroll(2080);
    state.now += 50;
    await harness.scroll(2050);
    const before = state.restores;
    // Reader releases the thumb and waits past the gesture window so idle settle runs.
    await harness.act(async () => window.dispatchEvent(new window.Event('pointerup')));
    state.now += 1_000;
    await harness.frame();
    await harness.frame();
    assert.equal(state.hook.followingRef.current, false, 'deliberate reversal from 2080 to 2050 does not rearm follow');
    assert.equal(state.restores, before, 'idle callback does not snap back to 2120');
    assert.equal(state.hook.showJump, true, 'jump control stays visible at 2050');
  } finally {
    await harness.dispose();
  }
});

test('a touch drag and a run of wheel notches each resolve their scroller once, where they begin', async () => {
  const harness = await tailHarness('gesture-scroller');
  const { state, viewport } = harness;
  const realStyle = window.getComputedStyle;
  let styleReads = 0;
  window.getComputedStyle = (...args) => {
    styleReads += 1;
    return realStyle.apply(window, args);
  };
  try {
    let blockTop = 400;
    let blockReads = 0;
    const block = document.createElement('div');
    block.style.overflowY = 'auto';
    Object.defineProperty(block, 'scrollHeight', { value: 900 });
    Object.defineProperty(block, 'clientHeight', { value: 300 });
    Object.defineProperty(block, 'scrollTop', {
      get: () => {
        blockReads += 1;
        return blockTop;
      },
    });
    const line = document.createElement('span');
    block.appendChild(line);
    viewport.appendChild(block);
    const touch = (clientY) => ({
      target: line,
      currentTarget: viewport,
      touches: [{ clientY }],
      changedTouches: [{ identifier: 0, clientY }],
    });
    await harness.act(async () => state.hook.handleTouchStart(touch(100)));
    const atStart = styleReads;
    assert.ok(atStart > 0, 'the touch start resolves its scroller');
    blockReads = 0;
    for (const y of [110, 120, 130, 140]) await harness.act(async () => state.hook.handleTouchMove(touch(y)));
    assert.equal(styleReads, atStart, 'no move of the drag reads style again');
    assert.equal(blockReads, 4, 'each move reads only the block’s offset');
    assert.equal(state.hook.hasTouchScroll(), false, 'the block takes the drag');
    blockTop = 0;
    await harness.act(async () => state.hook.handleTouchMove(touch(150)));
    assert.equal(state.hook.hasTouchScroll(), true, 'at its top the drag reaches the transcript');
    await harness.act(async () => state.hook.handleTouchEnd(lift()));
    await harness.rearm();
    blockTop = 400;
    const beforeWheel = styleReads;
    harness.wheel({ deltaY: -120, target: line });
    const firstNotch = styleReads;
    assert.ok(firstNotch > beforeWheel, 'the first notch resolves its scroller');
    for (let notch = 0; notch < 3; notch += 1) {
      state.now += 16;
      harness.wheel({ deltaY: -120, target: line });
    }
    assert.equal(styleReads, firstNotch, 'the later notches of the run read no style');
    assert.equal(state.hook.followingRef.current, true, 'the block takes the run');
    // A run that begins over no scroller reads nothing on its later notches.
    state.now += 1_000;
    harness.wheel({ deltaY: 120, target: harness.row });
    const overText = styleReads;
    for (let notch = 0; notch < 3; notch += 1) {
      state.now += 16;
      harness.wheel({ deltaY: 120, target: harness.row });
    }
    assert.equal(styleReads, overText, 'its later notches read no style');
  } finally {
    window.getComputedStyle = realStyle;
    await harness.dispose();
  }
});
