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
import { boundaryGestureReached, touchScrollLatchOpen, TRANSCRIPT_OVERFLOW_ANCHOR } from './use-transcript-follow.ts';

test('transcript history grows in bounded pages only at a full window', () => {
  assert.equal(nextTranscriptHistoryLimit(120, 512), null);
  assert.equal(nextTranscriptHistoryLimit(512, 512), 1024);
  assert.equal(nextTranscriptHistoryLimit(1300, 1024), 1812);
  assert.equal(nextTranscriptHistoryLimit(8192, 8192), null);
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

test('virtual-core remains the only transcript scroll anchoring authority', () => {
  assert.equal(TRANSCRIPT_OVERFLOW_ANCHOR, 'none');
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

// Phone: the compositor scrolls from the first move past the slop while the
// main thread is still inside a streaming frame. The end pin that frame
// requested must not write the old bottom back under the finger before the
// touchmove is handled; a tap that never scrolls still re-pins on lift.
test('a finger on the glass holds the end pin off and its upward scroll releases follow', async () => {
  const [React, { createRoot }, { useTranscriptFollow, registerTranscriptScrollGeometry }] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./use-transcript-follow.ts'),
  ]);
  const { restore } = installTestDom(null, {
    html: "<div id='root'></div>",
    jsdom: { url: 'http://localhost/', pretendToBeVisual: true },
    expose: ['Element'],
  });
  const realNow = Date.now;
  let now = 100_000;
  Date.now = () => now;
  const root = createRoot(document.getElementById('root'));
  let follow = null;
  function Harness() {
    const viewport = React.useRef(null);
    const content = React.useRef(null);
    follow = useTranscriptFollow({ viewport, content, sessionKey: 'finger-down' });
    return React.createElement(
      'div',
      { ref: viewport },
      React.createElement('div', { ref: content }, React.createElement('p', { id: 'row' }, 'row'))
    );
  }
  let native = 2000;
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    const row = document.getElementById('row');
    const viewport = row.parentElement.parentElement;
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => native, set: () => {} });
    const release = registerTranscriptScrollGeometry(viewport, {
      viewportHeight: () => 400,
      contentHeight: () => 2400,
      scrollTop: () => native,
      deviation: () => 0,
    });
    await React.act(async () => follow.handleScroll());
    now += 1_000;
    assert.equal(follow.followingRef.current, true, 'the reader starts at the tail');
    assert.equal(follow.hasScrollGesture(), false, 'no reader owns the idle tail');
    const touch = (clientY) => ({ target: row, currentTarget: viewport, touches: [{ clientY }] });
    // A tap: the finger holds the pin off while it rests, and lets go on lift.
    follow.handleTouchStart(touch(100));
    assert.equal(follow.hasScrollGesture(), true, 'a resting finger holds the end pin off');
    assert.equal(follow.followingRef.current, true, 'resting is not a leave');
    follow.handleTouchEnd();
    assert.equal(follow.hasScrollGesture(), false, 'a tap that never scrolled hands the tail back');
    // A drag the compositor moved before its touchmove reached the page.
    follow.handleTouchStart(touch(100));
    native = 1960;
    await React.act(async () => follow.handleScroll());
    assert.equal(follow.followingRef.current, false, 'the upward move under the finger releases follow');
    release();
  } finally {
    Date.now = realNow;
    await React.act(async () => root.unmount());
    restore();
  }
});

// A touch keeps targeting the row it started on. Virtualization unmounting
// that row mid-drag means its touchend never reaches the viewport; the finger
// then "stayed down" until the next touch, and every row size deferred for
// reader motion stayed deferred with the rows drawn over each other.
test('a touch whose row is virtualized away stops owning the transcript once its fling idles', async () => {
  const [React, { createRoot }, { useTranscriptFollow }] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./use-transcript-follow.ts'),
  ]);
  const { restore } = installTestDom(null, {
    html: "<div id='root'></div>",
    jsdom: { url: 'http://localhost/', pretendToBeVisual: true },
    expose: ['Element'],
  });
  const realNow = Date.now;
  let now = 100_000;
  Date.now = () => now;
  const root = createRoot(document.getElementById('root'));
  let follow = null;
  function Harness() {
    const viewport = React.useRef(null);
    const content = React.useRef(null);
    follow = useTranscriptFollow({ viewport, content, sessionKey: 'touch' });
    return React.createElement(
      'div',
      { ref: viewport },
      React.createElement('div', { ref: content }, React.createElement('p', { id: 'row' }, 'row'))
    );
  }
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    const viewport = document.getElementById('row').parentElement.parentElement;
    const row = document.getElementById('row');
    const touch = (clientY) => ({ target: row, currentTarget: viewport, touches: [{ clientY }] });
    follow.handleTouchStart(touch(100));
    follow.handleTouchMove(touch(160));
    now += 5_000;
    assert.equal(follow.hasScrollGesture(), true, 'a finger resting on the glass keeps ownership');
    row.remove();
    assert.equal(follow.hasScrollGesture(), false, 'its lost touchend cannot hold ownership forever');
  } finally {
    Date.now = realNow;
    await React.act(async () => root.unmount());
    restore();
  }
});

// A streamed word's fade wrapper is unwrapped when its fade ends. A finger
// that pressed it keeps targeting the removed element, so its moves never
// bubble to the viewport: follow stayed on and the end pin wrote the tail back
// under the finger every frame (phone: scrolling up stopped at once).
test('a drag whose pressed word left the document still releases follow and owns the scroll', async () => {
  const [React, { createRoot }, { useTranscriptFollow, registerTranscriptScrollGeometry }] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./use-transcript-follow.ts'),
  ]);
  const { restore } = installTestDom(null, {
    html: "<div id='root'></div>",
    jsdom: { url: 'http://localhost/', pretendToBeVisual: true },
    expose: ['Element'],
  });
  const root = createRoot(document.getElementById('root'));
  let follow = null;
  function Harness() {
    const viewport = React.useRef(null);
    const content = React.useRef(null);
    follow = useTranscriptFollow({ viewport, content, sessionKey: 'touch-detached' });
    return React.createElement(
      'div',
      { ref: viewport },
      React.createElement('div', { ref: content }, React.createElement('mx-fade', { id: 'word' }, 'word'))
    );
  }
  const touchEvent = (type, clientY) => {
    const event = new window.Event(type, { bubbles: true });
    Object.defineProperty(event, 'touches', { value: clientY === undefined ? [] : [{ clientY }] });
    return event;
  };
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    const word = document.getElementById('word');
    const viewport = word.parentElement.parentElement;
    let native = 2000;
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => native, set: () => {} });
    const release = registerTranscriptScrollGeometry(viewport, {
      viewportHeight: () => 400,
      contentHeight: () => 2400,
      scrollTop: () => native,
      deviation: () => 0,
    });
    await React.act(async () => follow.handleScroll());
    assert.equal(follow.followingRef.current, true, 'the reader starts at the followed tail');
    follow.handleTouchStart({ target: word, currentTarget: viewport, touches: [{ clientY: 100 }] });
    word.remove();
    await React.act(async () => word.dispatchEvent(touchEvent('touchmove', 140)));
    assert.equal(follow.hasTouchScroll(), true, 'the drag owns the transcript');
    native = 1960;
    await React.act(async () => follow.handleScroll());
    assert.equal(follow.followingRef.current, false, 'the scroll under the finger releases follow');
    word.dispatchEvent(touchEvent('touchend'));
    viewport.dispatchEvent(new window.Event('scrollend'));
    assert.equal(follow.hasTouchScroll(), false, 'its lift and scrollend end the touch scroll');
    release();
  } finally {
    await React.act(async () => root.unmount());
    restore();
  }
});

// A correction the timeline holds during a touch scroll moves the LOGICAL
// offset while the reader's finger keeps climbing: direction is the native
// displacement, never the held amount growing between two scroll events.
test('a held touch correction growing between scroll events is not read as a return to the tail', async () => {
  const [React, { createRoot }, { useTranscriptFollow, registerTranscriptScrollGeometry }] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./use-transcript-follow.ts'),
  ]);
  const { restore } = installTestDom(null, {
    html: "<div id='root'></div>",
    jsdom: { url: 'http://localhost/', pretendToBeVisual: true },
    expose: ['Element'],
  });
  const root = createRoot(document.getElementById('root'));
  let follow = null;
  function Harness() {
    const viewport = React.useRef(null);
    const content = React.useRef(null);
    follow = useTranscriptFollow({ viewport, content, sessionKey: 'touch-hold' });
    return React.createElement(
      'div',
      { ref: viewport },
      React.createElement('div', { ref: content }, React.createElement('p', { id: 'row' }, 'row'))
    );
  }
  let native = 2000;
  let held = 0;
  let content = 2400;
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    const row = document.getElementById('row');
    const viewport = row.parentElement.parentElement;
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => native, set: () => {} });
    const release = registerTranscriptScrollGeometry(viewport, {
      viewportHeight: () => 400,
      contentHeight: () => content,
      scrollTop: () => native + held,
      deviation: () => held,
    });
    await React.act(async () => follow.handleScroll());
    assert.equal(follow.followingRef.current, true, 'the reader starts at the tail');
    const touch = (clientY) => ({ target: row, currentTarget: viewport, touches: [{ clientY }] });
    follow.handleTouchStart(touch(100));
    await React.act(async () => follow.handleTouchMove(touch(140)));
    native = 1990;
    await React.act(async () => follow.handleScroll());
    assert.equal(follow.followingRef.current, false, 'the upward drag releases follow');
    // The finger climbs 10 px more while a row above grows by 400 px into a hold.
    native = 1980;
    held = 400;
    content = 2800;
    await React.act(async () => follow.handleScroll());
    assert.equal(follow.followingRef.current, false, 'a growing hold is not the reader arriving at the tail');
    release();
  } finally {
    await React.act(async () => root.unmount());
    restore();
  }
});

// The timeline holds its corrections off the native offset for exactly this
// window: from a drag that moves the transcript, through the fling, until
// scrollend.
test('streaming growth never writes scrollTop while the reader scrolls, and follow resumes at the bottom', async () => {
  const [React, { createRoot }, { useTranscriptFollow, registerTranscriptScrollGeometry }, { createTranscriptEndPin }] =
    await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('./use-transcript-follow.ts'),
      import('./transcript-end-pin.ts'),
    ]);
  const { restore } = installTestDom(null, {
    html: "<div id='root'></div>",
    jsdom: { url: 'http://localhost/', pretendToBeVisual: true },
    expose: ['Element'],
  });
  const realNow = Date.now;
  let now = 200_000;
  Date.now = () => now;
  const VIEWPORT = 400;
  let content = 2400;
  let native = content - VIEWPORT;
  const writes = [];
  // The timeline the hook drives: its end anchor flips with every follow decision.
  const instance = {
    options: { anchorTo: 'end', followOnAppend: false },
    targetWindow: window,
    getTotalSize: () => content,
  };
  const setAnchorBottomRef = { current: (bottom) => (instance.options.anchorTo = bottom ? 'end' : 'start') };
  let follow = null;
  let pin = null;
  const scrollToEndRef = { current: () => pin.request() };
  const root = createRoot(document.getElementById('root'));
  function Harness() {
    const viewport = React.useRef(null);
    const contentRef = React.useRef(null);
    follow = useTranscriptFollow({
      viewport,
      content: contentRef,
      sessionKey: 'stream-reader',
      setAnchorBottomRef,
      scrollToEndRef,
    });
    return React.createElement('div', { ref: viewport }, React.createElement('div', { ref: contentRef }, 'rows'));
  }
  const flush = () => React.act(async () => {});
  const frame = () => React.act(() => new Promise((resolve) => window.requestAnimationFrame(() => resolve())));
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    const viewport = document.getElementById('root').firstElementChild;
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => native,
      set: (value) => {
        writes.push(value);
        native = Math.min(Math.max(0, value), content - VIEWPORT);
      },
    });
    const release = registerTranscriptScrollGeometry(viewport, {
      viewportHeight: () => VIEWPORT,
      contentHeight: () => content,
      scrollTop: () => native,
      deviation: () => 0,
    });
    pin = createTranscriptEndPin({
      getVirtualizer: () => instance,
      getViewport: () => viewport,
      getSpacer: () => null,
      getMaxScrollTop: () => content - VIEWPORT,
      hasReaderGesture: () => follow.hasScrollGesture(),
      markProgrammaticScroll: (top, intended) => follow.markProgrammaticScroll(top, intended),
    });
    // A streamed token grows the tail and the timeline asks for the end, as its resize path does.
    const grow = async (px) => {
      content += px;
      if (instance.options.anchorTo === 'end') pin.request();
      await flush();
    };
    await React.act(async () => follow.handleScroll());
    now += 1_000;
    await grow(40);
    assert.equal(writes.length, 1, 'a following, idle tail is pinned on growth');
    assert.equal(native, content - VIEWPORT);
    writes.length = 0;

    // A downward wheel at the tail keeps follow armed but owns the viewport:
    // growth meanwhile waits instead of writing under the wheel.
    await React.act(async () => follow.handleWheel({ deltaY: 100, target: viewport, currentTarget: viewport }));
    await grow(40);
    await grow(40);
    assert.equal(writes.length, 0, 'no write while the reader is scrolling');
    assert.equal(follow.followingRef.current, true);
    now += 1_000;
    await frame();
    await flush();
    assert.equal(writes.length, 1, 'the deferred pin lands once the reader stops');
    assert.equal(native, content - VIEWPORT);
    writes.length = 0;

    // Scrolling up releases follow: the tail keeps growing without a single write.
    await React.act(async () => follow.handleWheel({ deltaY: -100, target: viewport, currentTarget: viewport }));
    native -= 300;
    await React.act(async () => follow.handleScroll());
    assert.equal(follow.followingRef.current, false, 'an upward wheel releases follow');
    const reading = native;
    for (let index = 0; index < 5; index += 1) {
      now += 50;
      await grow(40);
    }
    now += 1_000;
    await frame();
    await flush();
    assert.equal(writes.length, 0, 'no write while the reader reads above the tail');
    assert.equal(native, reading, 'the reading offset is never moved');

    // Back at the bottom, follow re-attaches and the next growth is pinned.
    native = content - VIEWPORT;
    now += 1_000;
    await React.act(async () => follow.handleScroll());
    assert.equal(follow.followingRef.current, true, 'the bottom re-attaches follow');
    now += 1_000;
    await grow(40);
    assert.equal(writes.length, 1, 'following resumes on the next growth');
    assert.equal(native, content - VIEWPORT);
    release();
  } finally {
    Date.now = realNow;
    await React.act(async () => root.unmount());
    restore();
  }
});

/** The follow hook driving an end pin over a fake viewport; the reader starts
 *  released, 600px up. */
async function mountReturningReader() {
  const [React, { createRoot }, { useTranscriptFollow, registerTranscriptScrollGeometry }, { createTranscriptEndPin }] =
    await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('./use-transcript-follow.ts'),
      import('./transcript-end-pin.ts'),
    ]);
  const { restore } = installTestDom(null, {
    html: "<div id='root'></div>",
    jsdom: { url: 'http://localhost/', pretendToBeVisual: true },
    expose: ['Element'],
  });
  const realNow = Date.now;
  let now = 400_000;
  Date.now = () => now;
  const VIEWPORT = 400;
  let content = 2400;
  let native = content - VIEWPORT;
  const writes = [];
  const instance = {
    options: { anchorTo: 'end', followOnAppend: false },
    targetWindow: window,
    getTotalSize: () => content,
  };
  const setAnchorBottomRef = { current: (bottom) => (instance.options.anchorTo = bottom ? 'end' : 'start') };
  let follow = null;
  let pin = null;
  const scrollToEndRef = { current: () => pin.request() };
  const root = createRoot(document.getElementById('root'));
  function Harness() {
    const viewport = React.useRef(null);
    const contentRef = React.useRef(null);
    follow = useTranscriptFollow({
      viewport,
      content: contentRef,
      sessionKey: 'returning-reader',
      setAnchorBottomRef,
      scrollToEndRef,
    });
    return React.createElement('div', { ref: viewport }, React.createElement('div', { ref: contentRef }, 'rows'));
  }
  const flush = () => React.act(async () => {});
  const frame = () => React.act(() => new Promise((resolve) => window.requestAnimationFrame(() => resolve())));
  await React.act(async () => root.render(React.createElement(Harness)));
  const viewport = document.getElementById('root').firstElementChild;
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => native,
    set: (value) => {
      writes.push(value);
      native = Math.min(Math.max(0, value), content - VIEWPORT);
    },
  });
  const release = registerTranscriptScrollGeometry(viewport, {
    viewportHeight: () => VIEWPORT,
    contentHeight: () => content,
    scrollTop: () => native,
    deviation: () => 0,
  });
  pin = createTranscriptEndPin({
    getVirtualizer: () => instance,
    getViewport: () => viewport,
    getSpacer: () => null,
    getMaxScrollTop: () => content - VIEWPORT,
    hasReaderGesture: () => follow.hasScrollGesture(),
    markProgrammaticScroll: (top, intended) => follow.markProgrammaticScroll(top, intended),
  });
  const scroll = (to) => {
    native = to;
    return React.act(async () => follow.handleScroll());
  };
  const wheel = (deltaY) =>
    React.act(async () => follow.handleWheel({ deltaY, target: viewport, currentTarget: viewport }));
  const touch = {
    start: (clientY) =>
      React.act(async () =>
        follow.handleTouchStart({ target: viewport, currentTarget: viewport, touches: [{ clientY }] })
      ),
    move: (clientY) =>
      React.act(async () =>
        follow.handleTouchMove({ target: viewport, currentTarget: viewport, touches: [{ clientY }] })
      ),
    end: () => React.act(async () => follow.handleTouchEnd()),
    scrollend: () => React.act(async () => viewport.dispatchEvent(new window.Event('scrollend'))),
  };
  /** Time passes with no input: the reader's scroll is over. */
  const idle = async (ms = 1_000) => {
    now += ms;
    await frame();
    await frame();
    await flush();
  };
  /** A streamed token grows the tail; a following timeline asks for the end. */
  const grow = async (px) => {
    content += px;
    if (instance.options.anchorTo === 'end') pin.request();
    await flush();
  };
  // The reader scrolls 600px up: released.
  await wheel(-100);
  await scroll(native - 600);
  assert.equal(follow.followingRef.current, false, 'an upward wheel releases follow');
  await idle();
  writes.length = 0;
  return {
    follow,
    writes,
    VIEWPORT,
    max: () => content - VIEWPORT,
    native: () => native,
    scroll,
    wheel,
    touch,
    idle,
    grow,
    async cleanup() {
      release();
      Date.now = realNow;
      await React.act(async () => root.unmount());
      restore();
    },
  };
}

// The view is the reader's while they scroll back down: entering the old
// re-attach band (32px, 12% of the pane) snapped them the rest of the way to
// the bottom and pinned new output up under their hand.
test('a reader scrolling back down near the bottom is never moved, and follow stays released', async () => {
  for (const input of ['wheel', 'touch']) {
    const reader = await mountReturningReader();
    try {
      const near = reader.max() - 20;
      if (input === 'wheel') {
        await reader.wheel(100);
        await reader.scroll(near);
      } else {
        await reader.touch.start(300);
        await reader.touch.move(200);
        await reader.scroll(near);
        await reader.touch.end();
        await reader.touch.scrollend();
      }
      assert.equal(reader.follow.followingRef.current, false, `${input}: 20px above the end is not the end`);
      await reader.idle();
      await reader.grow(40);
      await reader.idle();
      assert.equal(reader.follow.followingRef.current, false, `${input}: follow stays released`);
      assert.deepEqual(reader.writes, [], `${input}: the app writes no scrollTop`);
      assert.equal(reader.native(), near, `${input}: the reader's offset is untouched`);
    } finally {
      await reader.cleanup();
    }
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
  const [
    React,
    { createRoot },
    { useTranscriptFollow, registerTranscriptScrollGeometry },
    { createTouchScrollDeviation },
  ] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./use-transcript-follow.ts'),
    import('./transcript-list-touch-deviation.ts'),
  ]);
  const { restore } = installTestDom(null, {
    html: "<div id='root'></div>",
    jsdom: { url: 'http://localhost/', pretendToBeVisual: true },
    expose: ['Element'],
  });
  const realNow = Date.now;
  let now = 300_000;
  Date.now = () => now;
  const VIEWPORT = 400;
  const content = 4000;
  let native = 2000;
  const writes = [];
  let follow = null;
  const root = createRoot(document.getElementById('root'));
  function Harness() {
    const viewport = React.useRef(null);
    const contentRef = React.useRef(null);
    follow = useTranscriptFollow({ viewport, content: contentRef, sessionKey: 'wheel-hold' });
    return React.createElement(
      'div',
      { ref: viewport },
      React.createElement('div', { ref: contentRef }, React.createElement('div', { id: 'space' }, 'rows'))
    );
  }
  const frame = () => React.act(() => new Promise((resolve) => window.requestAnimationFrame(() => resolve())));
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    const space = document.getElementById('space');
    const viewport = space.parentElement.parentElement;
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
    const deviation = createTouchScrollDeviation({
      getViewport: () => viewport,
      getSpacer: () => space,
      hasTouchScroll: () => follow.holdsScrollCorrections(),
      clampAtEdge: () => follow.touchHoldsCorrections(),
      markProgrammaticScroll: (top, intended) => follow.markProgrammaticScroll(top, intended),
    });
    const release = registerTranscriptScrollGeometry(viewport, {
      viewportHeight: () => VIEWPORT,
      contentHeight: () => content,
      scrollTop: () => native,
      deviation: () => deviation.amount(),
    });
    await React.act(async () => follow.handleScroll());
    // The reader wheels up; a row measured into view above grows by 30px.
    now += 1_000;
    await React.act(async () => follow.handleWheel({ deltaY: -100, target: viewport, currentTarget: viewport }));
    assert.equal(follow.holdsScrollCorrections(), true, 'the wheel owns the viewport');
    native -= 60;
    await React.act(async () => follow.handleScroll());
    assert.equal(deviation.hold(native + 30), true, 'its correction is held');
    assert.equal(space.style.transform, 'translateY(-30px)', 'as a row offset');
    assert.equal(space.style.marginBottom, '-30px', 'and the native end moves up with the lifted rows');
    // The ramp keeps scrolling past the wheel window; it still owns the viewport.
    for (let step = 0; step < 4; step += 1) {
      now += 120;
      native -= 20;
      await React.act(async () => follow.handleScroll());
      await frame();
    }
    assert.equal(follow.holdsScrollCorrections(), true, 'scrolls of the ramp extend the hold');
    assert.deepEqual(writes, [], 'no scrollTop write during the wheel scroll');
    // Quiet: the held correction lands as one write.
    const settledAt = native + 30;
    now += 300;
    assert.equal(follow.holdsScrollCorrections(), false, 'the hold ends once the ramp is quiet');
    await frame();
    assert.deepEqual(writes, [settledAt], 'one write lands the held correction');
    assert.equal(space.style.transform, '');
    assert.equal(space.style.marginBottom, '');
    // A later scroll that is no wheel (scrollbar, keyboard) holds nothing.
    now += 50;
    native -= 40;
    await React.act(async () => follow.handleScroll());
    assert.equal(follow.holdsScrollCorrections(), false, 'a later non-wheel scroll does not revive the hold');
    release();
    deviation.cancel();
  } finally {
    Date.now = realNow;
    await React.act(async () => root.unmount());
    restore();
  }
});

test('a touch scroll owns the transcript from its drag until scrollend ends the fling, and off iOS holds no corrections', async () => {
  const [React, { createRoot }, { useTranscriptFollow }] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./use-transcript-follow.ts'),
  ]);
  const { restore } = installTestDom(null, {
    html: "<div id='root'></div>",
    jsdom: { url: 'http://localhost/', pretendToBeVisual: true },
    expose: ['Element'],
  });
  const root = createRoot(document.getElementById('root'));
  let follow = null;
  function Harness() {
    const viewport = React.useRef(null);
    const content = React.useRef(null);
    follow = useTranscriptFollow({ viewport, content, sessionKey: 'touch-latch' });
    return React.createElement(
      'div',
      { ref: viewport },
      React.createElement('div', { ref: content }, React.createElement('p', { id: 'row' }, 'row'))
    );
  }
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    const viewport = document.getElementById('row').parentElement.parentElement;
    const row = document.getElementById('row');
    const touch = (clientY) => ({ target: row, currentTarget: viewport, touches: [{ clientY }] });
    follow.handleTouchStart(touch(100));
    assert.equal(follow.hasTouchScroll(), false, 'a tap alone owns nothing');
    follow.handleTouchMove(touch(160));
    assert.equal(follow.hasTouchScroll(), true, 'the drag owns the transcript');
    // Off iOS WebKit (Android, a desktop touchscreen) a touch fling keeps its
    // momentum through a scrollTop write: nothing is held off the native
    // offset, so the scroll range always includes history landed above.
    assert.equal(follow.holdsScrollCorrections(), false, 'the drag holds no corrections');
    assert.equal(follow.touchHoldsCorrections(), false, 'no touch hold');
    follow.handleTouchEnd();
    assert.equal(follow.hasTouchScroll(), true, 'the fling keeps it after the finger lifts');
    assert.equal(follow.holdsScrollCorrections(), false, 'and its fling holds nothing either');
    viewport.dispatchEvent(new window.Event('scrollend'));
    assert.equal(follow.hasTouchScroll(), false, 'scrollend ends it');
  } finally {
    await React.act(async () => root.unmount());
    restore();
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
  const [
    React,
    { createRoot },
    { useTranscriptFollow, registerTranscriptScrollGeometry },
    { createTouchScrollDeviation },
  ] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./use-transcript-follow.ts'),
    import('./transcript-list-touch-deviation.ts'),
  ]);
  const { restore } = installTestDom(null, {
    html: "<div id='root'></div>",
    jsdom: { url: 'http://localhost/', pretendToBeVisual: true },
    expose: ['Element'],
    ...(navigator ? { globals: { navigator } } : {}),
  });
  const realNow = Date.now;
  const state = { now: 700_000, native: startTop, writes: [], follow: null };
  Date.now = () => state.now;
  const root = createRoot(document.getElementById('root'));
  function Harness() {
    const viewport = React.useRef(null);
    const content = React.useRef(null);
    state.follow = useTranscriptFollow({ viewport, content, sessionKey });
    return React.createElement(
      'div',
      { ref: viewport },
      React.createElement('div', { ref: content }, React.createElement('div', { id: 'space' }, 'rows'))
    );
  }
  await React.act(async () => root.render(React.createElement(Harness)));
  const space = document.getElementById('space');
  const viewport = space.parentElement.parentElement;
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
  const release = registerTranscriptScrollGeometry(viewport, {
    viewportHeight: () => 400,
    contentHeight: () => 40_000,
    scrollTop: () => state.native,
    deviation: () => deviation.amount(),
  });
  const frame = () => React.act(() => new Promise((resolve) => window.requestAnimationFrame(() => resolve())));
  const touch = (clientY) => ({ target: space, currentTarget: viewport, touches: [{ clientY }] });
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
      state.follow.handleTouchEnd();
    },
    touchStart: () => React.act(async () => state.follow.handleTouchStart(touch(300))),
    async dispose() {
      release();
      deviation.cancel();
      Date.now = realNow;
      await React.act(async () => root.unmount());
      restore();
    },
  };
}

// Android phone: a page of older history held as a row offset left the native
// range short of it, so an upward fling ran into native 0 at the old first row
// and stopped there, mid-history (phone: 위로 스크롤하면 중간에 멈춘다).
// Chromium keeps a touch fling's momentum through a scrollTop write (its fling
// is a stream of scroll deltas, the same path scroll anchoring adjusts under),
// so off iOS WebKit the landing is written at once and the fling carries on
// into the page.
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
    state.follow.handleTouchEnd();
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
  const [React, { createRoot }, follow] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./use-transcript-follow.ts'),
  ]);
  const { restore } = installTestDom(null, {
    html: "<div id='root'></div>",
    jsdom: { url: 'http://localhost/', pretendToBeVisual: true },
    expose: ['Element', 'MutationObserver'],
  });
  const realNow = Date.now;
  const state = { native: 2000, now: 200_000, hook: null, restores: 0 };
  Date.now = () => state.now;
  const scrollToEndRef = { current: () => (state.restores += 1) };
  const root = createRoot(document.getElementById('root'));
  function Harness() {
    const viewport = React.useRef(null);
    const content = React.useRef(null);
    state.hook = follow.useTranscriptFollow({ viewport, content, sessionKey, scrollToEndRef });
    return React.createElement(
      'div',
      { ref: viewport },
      React.createElement('div', { ref: content }, React.createElement('p', { id: 'row' }, 'row'))
    );
  }
  await React.act(async () => root.render(React.createElement(Harness)));
  const row = document.getElementById('row');
  const viewport = row.parentElement.parentElement;
  Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => state.native, set: () => {} });
  const release = follow.registerTranscriptScrollGeometry(viewport, {
    viewportHeight: () => 400,
    contentHeight: () => 2400,
    scrollTop: () => state.native,
    deviation: () => 0,
  });
  await React.act(async () => state.hook.handleScroll());
  state.now += 1_000;
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
    pointerDown: (target, extra = {}) =>
      React.act(async () => state.hook.handlePointerDown({ target, currentTarget: viewport, button: 0, ...extra })),
    act: (callback) => React.act(callback),
    frame: () => React.act(() => new Promise((resolve) => window.requestAnimationFrame(() => resolve()))),
    dispose: async () => {
      release();
      Date.now = realNow;
      await React.act(async () => root.unmount());
      restore();
    },
  };
}

test('a wheel releases follow only as a vertical upward notch, over a nested scroller too', async () => {
  const harness = await tailHarness('wheel-intent');
  const { state } = harness;
  try {
    // Pinch-zoom and a mostly-sideways swipe are not a scroll toward older rows.
    harness.wheel({ deltaY: -3, ctrlKey: true });
    harness.wheel({ deltaY: -3, deltaX: 12 });
    assert.equal(state.hook.followingRef.current, true, 'neither a zoom nor a sideways swipe leaves the tail');
    // Nothing is above the viewport to scroll toward at the very top.
    state.native = 0;
    harness.wheel({ deltaY: -3 });
    assert.equal(state.hook.followingRef.current, true, 'a notch with no room above is not a leave');
    state.native = 2000;
    // A code block with room left takes the notch itself; the notch still counts.
    const block = document.createElement('div');
    block.setAttribute('data-scrollable', '');
    Object.defineProperty(block, 'scrollHeight', { value: 900 });
    Object.defineProperty(block, 'clientHeight', { value: 300 });
    Object.defineProperty(block, 'scrollTop', { value: 400 });
    harness.viewport.appendChild(block);
    harness.wheel({ deltaY: -120, target: block });
    assert.equal(state.hook.followingRef.current, false, 'a plain upward notch leaves at once, wherever it lands');
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

test('an upward scroll right after a layout change is put back, not a leave; a quiet one leaves', async () => {
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
    // The same move with the page quiet for longer than the mutation window.
    state.now += 450;
    await harness.scroll(1930);
    assert.equal(state.hook.followingRef.current, false, 'nothing explains it: it leaves');
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
    await harness.scroll(1400);
    assert.equal(state.hook.followingRef.current, false, 'a spent value excuses nothing');
  } finally {
    await harness.dispose();
  }
});

test('a stationary press on prose does not vouch for a streaming correction; scrollbar and selection autoscroll do', async () => {
  const harness = await tailHarness('prose-press');
  const { state, row, viewport } = harness;
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
    await harness.pointerDown(viewport);
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

test('a mutation that predates our own restore is answered by it', async () => {
  const harness = await tailHarness('restored-mutation');
  const { state } = harness;
  try {
    await harness.mutate();
    state.now += 100;
    await harness.scroll(1990);
    assert.equal(state.hook.followingRef.current, true);
    // Within 400ms of the mutation, but after the restore it was answered by.
    state.now += 100;
    await harness.scroll(1930);
    assert.equal(state.hook.followingRef.current, false, 'a second move after the restore leaves');
  } finally {
    await harness.dispose();
  }
});

test('a scroll within 150ms of the timeline write is the write; one on its exact value never re-engages', async () => {
  const harness = await tailHarness('write-window');
  const { state } = harness;
  try {
    state.hook.markProgrammaticScroll(1500);
    state.now += 100;
    await harness.scroll(1700);
    assert.equal(state.hook.followingRef.current, true, 'inside the window any event is the write');
    state.now += 100;
    await harness.scroll(1650);
    assert.equal(state.hook.followingRef.current, false, 'past the window it is not');
    // Released and parked 350px up. The timeline lands exactly on the end.
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
    await harness.pointerDown(viewport);
    state.now += 50;
    await harness.scroll(1900);
    assert.equal(state.hook.followingRef.current, false, 'a held press beats a layout change');
    await harness.rearm();
    // The press ended (mouseup), so it vouches for nothing.
    await harness.pointerDown(viewport);
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
    await harness.pointerDown(viewport);
    state.now += 50;
    await harness.scroll(1600);
    assert.equal(state.hook.followingRef.current, false, 'a held press on the transcript itself leaves');
  } finally {
    await harness.dispose();
  }
});

test('a finger lifted above the end vouches for the momentum scrolls after it', async () => {
  const harness = await tailHarness('touch-momentum');
  const { state, row, viewport } = harness;
  try {
    const touch = (clientY) => ({ target: row, currentTarget: viewport, touches: [{ clientY }] });
    state.hook.handleTouchStart(touch(100));
    // The timeline wrote while the finger was down, and the finger travelled
    // less than a tap: the lift has no scroll of its own to judge.
    state.hook.markProgrammaticScroll(1700);
    state.native = 1700;
    await harness.act(async () => state.hook.handleTouchEnd());
    assert.equal(state.hook.followingRef.current, true, 'the lift alone leaves nothing');
    state.now += 300;
    await harness.mutate();
    await harness.scroll(1650);
    assert.equal(state.hook.followingRef.current, false, 'the momentum scroll after a lift from above the end leaves');
  } finally {
    await harness.dispose();
  }
});

test('pressing, or pressing Enter or Space on, a control lets go of follow; prose and code do not', async () => {
  const harness = await tailHarness('press-control');
  const { state, row, viewport } = harness;
  try {
    const button = document.createElement('button');
    const label = document.createElement('span');
    button.appendChild(label);
    const code = document.createElement('pre');
    const kept = document.createElement('button');
    kept.setAttribute('data-transcript-keeps-follow', '');
    viewport.append(button, code, kept);
    await harness.pointerDown(row);
    await harness.pointerDown(code);
    await harness.pointerDown(viewport);
    await harness.pointerDown(kept);
    harness.key({ key: 'Enter', target: row });
    harness.key({ key: 'Enter', target: kept });
    assert.equal(state.hook.followingRef.current, true, 'prose, code, chrome and a keep-follow control keep it');
    await harness.pointerDown(label);
    assert.equal(state.hook.followingRef.current, false, 'pressing inside a control lets go');
    await harness.rearm();
    harness.key({ key: 'Enter', target: button });
    assert.equal(state.hook.followingRef.current, false, 'Enter on a control lets go');
    await harness.rearm();
    // Space on a control activates it: that is the leave, not a scroll.
    harness.key({ key: ' ', shiftKey: true, target: button });
    assert.equal(state.hook.followingRef.current, false, 'Shift+Space on a focused button leaves via the control');
    await harness.rearm();
    const field = document.createElement('input');
    viewport.appendChild(field);
    harness.key({ key: ' ', target: field });
    assert.equal(state.hook.followingRef.current, true, 'a space typed in a field leaves nothing');
  } finally {
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
    await harness.scroll(1650);
    await frame();
    await frame();
    assert.equal(state.hook.followingRef.current, false);
    assert.equal(state.hook.showJump, true, 'released and 350px from the end');
    await harness.scroll(1850);
    await frame();
    assert.equal(state.hook.showJump, false, 'within 200px of the end');
  } finally {
    await harness.dispose();
  }
});

test('a scrollbar press stops vouching for scrolls after fifteen seconds', async () => {
  const harness = await tailHarness('scrollbar-hold');
  const { state, viewport } = harness;
  try {
    await harness.pointerDown(viewport);
    state.now += 1_000;
    await harness.scroll(1940);
    assert.equal(state.hook.followingRef.current, false, 'a drag on the scrollbar leaves the tail');
    await harness.rearm();
    // The release of the press was lost (the pointer left the window).
    await harness.pointerDown(viewport);
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
    await harness.scroll(1950);
    assert.equal(state.hook.followingRef.current, false, 'a real move at the same zoom still leaves');
  } finally {
    if (realRatio) Object.defineProperty(window, 'devicePixelRatio', realRatio);
    else delete window.devicePixelRatio;
    await harness.dispose();
  }
});
