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
import {
  boundaryGestureReached,
  grewWhileAtBottom,
  pointerShouldReleaseFollow,
  programmaticWriteMatches,
  readerScrollShouldReleaseFollow,
  selectionAutoScrollShouldReleaseFollow,
  touchMoveShouldReleaseFollow,
  touchScrollLatchOpen,
  wheelShouldReleaseFollow,
  TRANSCRIPT_OVERFLOW_ANCHOR,
} from './use-transcript-follow.ts';

/** The wheel handler's boundary decision, exactly as the hook composes it. */
function wheelReleases({ delta, nested }) {
  const transcriptReached = !nested || boundaryGestureReached(nested, delta);
  return {
    marks: transcriptReached,
    releases: wheelShouldReleaseFollow({ delta, transcriptReached }),
  };
}

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

test('a touch drag toward older transcript history releases follow', () => {
  assert.equal(
    touchMoveShouldReleaseFollow({
      delta: -12,
      transcriptReached: true,
    }),
    true
  );
});

test('nested scrollers keep touch ownership until the transcript is reached', () => {
  assert.equal(
    touchMoveShouldReleaseFollow({
      delta: -12,
      transcriptReached: false,
    }),
    false
  );
});

test('touch movement toward the tail and sub-pixel jitter keep follow armed', () => {
  assert.equal(
    touchMoveShouldReleaseFollow({
      delta: 12,
      transcriptReached: true,
    }),
    false
  );
  assert.equal(
    touchMoveShouldReleaseFollow({
      delta: -1,
      transcriptReached: true,
    }),
    false
  );
});

test('an upward wheel over the transcript itself releases follow immediately', () => {
  const outcome = wheelReleases({ delta: -3, nested: null });
  assert.equal(outcome.marks, true);
  assert.equal(outcome.releases, true);
});

test("an upward wheel at a nested scroller's leading boundary releases follow", () => {
  // The nested code block cannot scroll up any further, so the notch scrolls
  // the transcript. Marking the gesture without releasing left the end anchor
  // fighting the reader every frame.
  const outcome = wheelReleases({
    delta: -120,
    nested: { scrollTop: 0, scrollHeight: 900, clientHeight: 300 },
  });
  assert.equal(outcome.marks, true);
  assert.equal(outcome.releases, true);
});

test('a nested scroller with room left keeps the wheel and never releases follow', () => {
  const outcome = wheelReleases({
    delta: -120,
    nested: { scrollTop: 400, scrollHeight: 900, clientHeight: 300 },
  });
  assert.equal(outcome.marks, false);
  assert.equal(outcome.releases, false);
});

test('a downward wheel never releases follow, boundary or not', () => {
  assert.equal(wheelReleases({ delta: 120, nested: null }).releases, false);
  assert.equal(
    wheelReleases({
      delta: 120,
      nested: { scrollTop: 600, scrollHeight: 900, clientHeight: 300 },
    }).releases,
    false
  );
});

test('an unscrollable nested target hands the gesture straight to the transcript', () => {
  assert.equal(boundaryGestureReached({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 }, -50), true);
  assert.equal(boundaryGestureReached({ scrollTop: 0, scrollHeight: 900, clientHeight: 300 }, 0), false);
});

test('a pointer drag releases follow only after leaving the tail upward', () => {
  assert.equal(pointerShouldReleaseFollow({ distance: 400, upwardMove: 20 }), true);
  // Inside the bottom band the drag is selection, not a leave.
  assert.equal(pointerShouldReleaseFollow({ distance: 4, upwardMove: 20 }), false);
  // Downward and sub-pixel travel are not a leave either.
  assert.equal(pointerShouldReleaseFollow({ distance: 400, upwardMove: -20 }), false);
  assert.equal(pointerShouldReleaseFollow({ distance: 400, upwardMove: 1 }), false);
});

test('native selection autoscroll releases follow only when it moves upward', () => {
  assert.equal(selectionAutoScrollShouldReleaseFollow(-12), true);
  assert.equal(selectionAutoScrollShouldReleaseFollow(12), false);
  assert.equal(selectionAutoScrollShouldReleaseFollow(0), false);
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

test('only a chrome-pointer upward move counts as a reader scroll release', () => {
  assert.equal(
    readerScrollShouldReleaseFollow({
      programmatic: false,
      chromePointer: true,
      upwardMove: 30,
    }),
    true
  );
  // The timeline's own corrective write is never reader intent.
  assert.equal(
    readerScrollShouldReleaseFollow({
      programmatic: true,
      chromePointer: true,
      upwardMove: 30,
    }),
    false
  );
  // A scroll that did not start on the scrollbar/padding keeps follow.
  assert.equal(
    readerScrollShouldReleaseFollow({
      programmatic: false,
      chromePointer: false,
      upwardMove: 30,
    }),
    false
  );
  // A native upward move under a finger is the touch, even before its
  // touchmove reaches the main thread; the timeline's own write never is.
  assert.equal(
    readerScrollShouldReleaseFollow({ programmatic: false, chromePointer: false, fingerOnGlass: true, upwardMove: 30 }),
    true
  );
  assert.equal(
    readerScrollShouldReleaseFollow({ programmatic: true, chromePointer: false, fingerOnGlass: true, upwardMove: 30 }),
    false
  );
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

test('growth follows the tail only when the viewport was at the bottom before it', () => {
  assert.equal(grewWhileAtBottom({ distanceBefore: 2, growth: 400 }), true);
  // A row above the reader resolving from its estimate must not yank the view.
  assert.equal(grewWhileAtBottom({ distanceBefore: 900, growth: 400 }), false);
  assert.equal(grewWhileAtBottom({ distanceBefore: 0, growth: 0 }), false);
});

test('a burst of programmatic writes stays attributable to the timeline', () => {
  const now = 10_000;
  const writes = [
    { top: 1_200, time: now - 900 },
    { top: 1_480, time: now - 40 },
  ];
  // Any offset in the live burst, not just the last one.
  assert.equal(programmaticWriteMatches({ writes, top: 1_200.4, now }), true);
  assert.equal(programmaticWriteMatches({ writes, top: 1_480, now }), true);
  // A reader offset the timeline never wrote is reader intent.
  assert.equal(programmaticWriteMatches({ writes, top: 900, now }), false);
  // Expired writes no longer excuse a move.
  assert.equal(
    programmaticWriteMatches({
      writes: [{ top: 1_200, time: now - 5_000 }],
      top: 1_200,
      now,
    }),
    false
  );
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
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => 2000, set: () => {} });
    const release = registerTranscriptScrollGeometry(viewport, {
      viewportHeight: () => 400,
      contentHeight: () => 2400,
      scrollTop: () => 2000,
      deviation: () => 0,
    });
    await React.act(async () => follow.handleScroll());
    assert.equal(follow.followingRef.current, true, 'the reader starts at the followed tail');
    follow.handleTouchStart({ target: word, currentTarget: viewport, touches: [{ clientY: 100 }] });
    word.remove();
    await React.act(async () => word.dispatchEvent(touchEvent('touchmove', 140)));
    assert.equal(follow.followingRef.current, false, 'the drag toward older rows releases follow');
    assert.equal(follow.hasTouchScroll(), true, 'and owns the transcript');
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
    assert.equal(follow.followingRef.current, false, 'the upward drag releases follow');
    // The finger climbs 20 px while a row above grows by 400 px into a hold.
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

test('reaching the true bottom re-engages follow once the scroll settles, and growth is then pinned', async () => {
  for (const input of ['wheel', 'touch']) {
    const reader = await mountReturningReader();
    try {
      if (input === 'wheel') {
        await reader.wheel(100);
        await reader.scroll(reader.max());
      } else {
        await reader.touch.start(300);
        await reader.touch.move(200);
        await reader.scroll(reader.max());
      }
      // Still scrolling (wheel ramp, finger on the glass): not yet.
      assert.equal(reader.follow.followingRef.current, false, `${input}: not while the reader scrolls`);
      await reader.grow(40);
      assert.deepEqual(reader.writes, [], `${input}: nothing pushes the content under the reader's hand`);
      if (input === 'touch') {
        await reader.touch.end();
        await reader.touch.scrollend();
        assert.equal(reader.follow.followingRef.current, false, `${input}: not the instant the finger lifts`);
      }
      await reader.idle();
      assert.equal(reader.follow.followingRef.current, true, `${input}: settled at the end, follow re-engages`);
      await reader.grow(40);
      assert.equal(reader.writes.length, 1, `${input}: the next growth is pinned`);
      assert.equal(reader.native(), reader.max(), `${input}: at the bottom`);
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

test('a touch scroll owns the transcript and holds corrections from its drag until scrollend ends the fling', async () => {
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
    // An Android scrollTop write under a touch fling desyncs it until the next
    // touch: the drag holds corrections off the native offset, at the edge too.
    assert.equal(follow.holdsScrollCorrections(), true, 'the drag holds corrections');
    assert.equal(follow.touchHoldsCorrections(), true, 'as a touch hold');
    follow.handleTouchEnd();
    assert.equal(follow.hasTouchScroll(), true, 'the fling keeps it after the finger lifts');
    assert.equal(follow.holdsScrollCorrections(), true, 'and so does its fling');
    viewport.dispatchEvent(new window.Event('scrollend'));
    assert.equal(follow.hasTouchScroll(), false, 'scrollend ends it');
    assert.equal(follow.holdsScrollCorrections(), true, 'a finger lifted a moment ago still holds');
  } finally {
    await React.act(async () => root.unmount());
    restore();
  }
});

/** The follow hook over a 400 px viewport whose native offset the test owns,
 *  with the list's correction hold wired to it as TranscriptList wires it. */
async function touchHoldHarness(sessionKey, startTop) {
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

// Android phone: a scrollTop write under a touch fling desynced the fling from
// the page, and the next touch reconciled them in one jump (위로 빠르게 넘기면
// 멈추고, 다시 터치하면 훨씬 위로 순간이동). Rows measured into view during the
// fling are held as a row offset, and their sum lands once the fling is over.
test('an Android touch fling writes no measured-size correction until scrollend, then lands them in one write', async () => {
  const harness = await touchHoldHarness('android-fling', 8_000);
  const { state, space, viewport, deviation } = harness;
  try {
    await harness.drag();
    assert.equal(deviation.hold(state.native + 30), true, 'a row measured into view mid-fling is held');
    for (let step = 0; step < 6; step += 1) await harness.scroll(-80);
    // A second row grows by 40px further into the fling.
    assert.equal(deviation.hold(state.native + 70), true, 'the next correction joins the hold');
    assert.equal(space.style.transform, 'translateY(-70px)', 'held as one row offset');
    for (let step = 0; step < 6; step += 1) await harness.scroll(-40);
    assert.equal(state.follow.holdsScrollCorrections(), true, 'the fling keeps the hold');
    assert.deepEqual(state.writes, [], 'no scrollTop write under the fling');
    const settledAt = state.native + 70;
    viewport.dispatchEvent(new window.Event('scrollend'));
    await harness.frame();
    assert.deepEqual(state.writes, [settledAt], 'the held corrections land as one write once the fling ends');
    assert.equal(space.style.transform, '');
    assert.equal(deviation.amount(), 0);
  } finally {
    await harness.dispose();
  }
});

// A held page landing leaves the native offset short of the logical one: a
// fling toward older history ran into native 0 and stuck there with the page
// unreachable above it. A touch hold lands once the reader is at the top.
test('an Android touch fling toward the top lands a held page at the top, never short of it', async () => {
  const harness = await touchHoldHarness('android-edge', 1_400);
  const { state, space, deviation } = harness;
  try {
    await harness.drag();
    // Older history (5,000 px) lands above the reader mid-fling.
    assert.equal(deviation.hold(state.native + 5_000), true, 'the landing is held away from the top');
    assert.equal(space.style.transform, 'translateY(-5000px)');
    while (state.native > 80) await harness.scroll(-80);
    assert.deepEqual(state.writes, [], 'short of the top it stays held, even within a screen of it');
    await harness.scroll(-state.native);
    assert.deepEqual(state.writes, [5_000], 'at the top the hold lands as one write');
    assert.equal(space.style.transform, '');
    // The page is reachable above: the reader's next frames move into it.
    for (let step = 0; step < 10; step += 1) await harness.scroll(-80);
    assert.equal(state.native, 4_200, 'the touch scroll carries on past the old top');
    assert.equal(state.writes.length, 1);
    // A landing at the top is never held.
    state.native = 0;
    assert.equal(deviation.hold(2_000), false, 'the caller writes it natively');
  } finally {
    await harness.dispose();
  }
});

// The jump landed in the gap between the fling's stop and the next touch: a
// touch while a hold is pending keeps holding, and so does the finger's
// release for a moment.
test('a touch after the fling stopped keeps a pending hold until the finger has been off for a moment', async () => {
  const harness = await touchHoldHarness('android-retouch', 8_000);
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
  const harness = await touchHoldHarness('touch-bounce', 39_600);
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
