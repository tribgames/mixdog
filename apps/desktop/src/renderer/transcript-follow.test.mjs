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
test('a touch scroll owns the transcript from its drag until scrollend ends the fling', async () => {
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
    follow.handleTouchEnd();
    assert.equal(follow.hasTouchScroll(), true, 'the fling keeps it after the finger lifts');
    viewport.dispatchEvent(new window.Event('scrollend'));
    assert.equal(follow.hasTouchScroll(), false, 'scrollend ends it');
  } finally {
    await React.act(async () => root.unmount());
    restore();
  }
});
