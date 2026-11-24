import assert from 'node:assert/strict';
import test from 'node:test';
import {
  atWrittenOffset,
  chromePressHeld,
  classifyScrollKey,
  judgeScrollEvent,
  jumpButtonVisible,
  keyUpRecent,
  moveArrivesNearEnd,
  pressOnScrollbar,
  touchEndRecent,
  touchLiftNeedsJudgement,
  touchTravelled,
  wheelIsVerticalScroll,
  wheelUpRecent,
} from './transcript-follow-rules';

test('a wheel is a vertical scroll only unmodified and mostly vertical', () => {
  assert.equal(wheelIsVerticalScroll({ deltaY: -3 }), true);
  assert.equal(wheelIsVerticalScroll({ deltaY: 3 }), true);
  assert.equal(wheelIsVerticalScroll({ deltaY: -3, ctrlKey: true }), false, 'pinch-zoom');
  assert.equal(wheelIsVerticalScroll({ deltaY: -3, shiftKey: true }), false, 'a shift-wheel scrolls sideways');
  assert.equal(wheelIsVerticalScroll({ deltaY: -3, deltaX: 12 }), false, 'a sideways swipe');
  assert.equal(wheelIsVerticalScroll({ deltaY: -30, deltaX: 12 }), true);
});

test('a finger travelled only up or down beyond a tap, never on a sideways swipe', () => {
  assert.equal(touchTravelled({ x: 100, y: 100 }, { x: 100, y: 140 }), true);
  assert.equal(touchTravelled({ x: 100, y: 100 }, { x: 101, y: 103 }), false, 'a tap');
  assert.equal(touchTravelled({ x: 100, y: 100 }, { x: 200, y: 140 }), false, 'a pane swipe with drift');
});

test("a press counts as the scrollbar's only on the track its gutter reserves, not on the scroller's padding", () => {
  const root = {
    offsetWidth: 400,
    clientWidth: 388,
    clientLeft: 0,
    getBoundingClientRect: () => ({ left: 100, right: 500 }),
  };
  assert.equal(pressOnScrollbar(root, { target: root, clientX: 495 }), true);
  assert.equal(pressOnScrollbar(root, { target: root, clientX: 488 }), true, 'the track’s inner edge');
  assert.equal(pressOnScrollbar(root, { target: root, clientX: 487 }), false, 'the padding beside it');
  assert.equal(pressOnScrollbar(root, { target: root, clientX: 120 }), false, 'the padding at the left');
  assert.equal(pressOnScrollbar(root, { target: {}, clientX: 495 }), false, 'a row');
  const overlay = { ...root, clientWidth: 400 };
  assert.equal(pressOnScrollbar(overlay, { target: overlay, clientX: 499 }), false, 'no track');
});

test('only scroll keys classify, with the platform jump to the top surviving a modifier', () => {
  assert.equal(classifyScrollKey({ key: 'ArrowUp' }), 'up');
  assert.equal(classifyScrollKey({ key: 'PageUp' }), 'up');
  assert.equal(classifyScrollKey({ key: 'Home' }), 'up');
  assert.equal(classifyScrollKey({ key: ' ', shiftKey: true }), 'up');
  assert.equal(classifyScrollKey({ key: 'Tab', shiftKey: true }), 'up');
  assert.equal(classifyScrollKey({ key: 'Tab' }), 'none');
  assert.equal(classifyScrollKey({ key: ' ' }), 'down');
  assert.equal(classifyScrollKey({ key: 'End' }), 'down');
  assert.equal(classifyScrollKey({ key: 'PageUp', ctrlKey: true }), 'none', 'a tab switch');
  assert.equal(classifyScrollKey({ key: 'ArrowUp', metaKey: true }), 'up');
  assert.equal(classifyScrollKey({ key: 'Home', ctrlKey: true }), 'up');
  assert.equal(classifyScrollKey({ key: 'a' }), 'none');
});

test('the windows of reader signals are the reference ones', () => {
  assert.equal(wheelUpRecent({ wheelUpAt: 1_000, now: 1_199 }), true);
  assert.equal(wheelUpRecent({ wheelUpAt: 1_000, now: 1_200 }), false);
  assert.equal(wheelUpRecent({ wheelUpAt: 0, now: 100 }), false);
  assert.equal(keyUpRecent({ keyUpAt: 1_000, now: 1_999 }), true);
  assert.equal(keyUpRecent({ keyUpAt: 1_000, now: 2_000 }), false);
  assert.equal(touchEndRecent({ touchEndUpAt: 1_000, now: 3_499 }), true);
  assert.equal(touchEndRecent({ touchEndUpAt: 1_000, now: 3_500 }), false);
  assert.equal(chromePressHeld({ pressedAt: 1_000, now: 15_999 }), true);
  assert.equal(chromePressHeld({ pressedAt: 1_000, now: 16_000 }), false);
  assert.equal(chromePressHeld({ pressedAt: 0, now: 1_000 }), false);
});

test('the timeline owns a scroll on a value it wrote, at whole pixels, however late it lands', () => {
  assert.equal(atWrittenOffset([1_480], 1_480.3), true);
  assert.equal(atWrittenOffset([1_480], 1_479.4), false);
  assert.equal(atWrittenOffset([], 0), false);
});

const base = {
  pinned: true,
  previousTop: 2_000,
  top: 1_900,
  distance: 100,
  arrived: false,
  upward: false,
  inFlight: false,
  atWrittenTop: false,
};
const judge = (over) => judgeScrollEvent({ ...base, ...over });

test("an upward move leaves only with the reader's upward input behind it; anything else is put back", () => {
  assert.equal(judge({ upward: true }), 'unpin');
  assert.equal(judge({ upward: true, atWrittenTop: true }), 'unpin', 'even onto an offset the timeline wrote');
  // A clamp to a shrunken extent, a layout pass, a zoom's rounding, the timeline's own write: no input of the reader.
  assert.equal(judge({}), 'restore');
  assert.equal(judge({ atWrittenTop: true }), 'restore');
  assert.equal(judge({ inFlight: true }), 'restore', 'a resting finger or a press that moved nothing vouches for nothing');
});

test('a clamp or move within two pixels of the end is never a leave; an unpinned viewport has none to make', () => {
  assert.equal(judge({ upward: true, distance: 2 }), 'none');
  assert.equal(judge({ upward: true, distance: 3 }), 'unpin');
  assert.equal(judge({ distance: 2 }), 'none', 'nothing to put back');
  assert.equal(judge({ upward: true, pinned: false }), 'none');
  assert.equal(judge({ top: 2_050, previousTop: 2_000, arrived: true }), 'none', 'downward');
});

test('arriving where the jump control would not show re-engages follow at once, unless input or a write is behind it', () => {
  const arrive = { pinned: false, previousTop: 1_900, top: 2_000, distance: 1, arrived: true };
  assert.equal(judge(arrive), 'pin');
  assert.equal(judge({ ...arrive, distance: 200 }), 'pin', '200px short: the jump control would not show');
  assert.equal(judge({ ...arrive, distance: 201 }), 'none', 'the jump control would show');
  assert.equal(judge({ ...arrive, arrived: false }), 'none', 'the last move did not bring the reader near the end');
  assert.equal(judge({ ...arrive, inFlight: true }), 'none', 'a finger or a thumb is still down');
  assert.equal(judge({ ...arrive, upward: true }), 'none', 'an upward input is still in its window');
  assert.equal(judge({ ...arrive, atWrittenTop: true }), 'none', 'exactly the written offset');
});

test('only a downward move off any written offset, ending within 200px of the end, is the reader coming back', () => {
  const move = { previousTop: 1_700, top: 1_850, distance: 150, written: false };
  assert.equal(moveArrivesNearEnd(move), true);
  assert.equal(moveArrivesNearEnd({ ...move, distance: 200 }), true);
  assert.equal(moveArrivesNearEnd({ ...move, distance: 201 }), false, 'it ended where the band begins');
  assert.equal(moveArrivesNearEnd({ ...move, top: 1_600 }), false, 'upward');
  assert.equal(moveArrivesNearEnd({ ...move, written: true }), false, 'the timeline wrote it');
});

test('a finger lift is judged after a native scroll, or after a travelled or unwritten move', () => {
  const lift = { scrolledNatively: false, moved: false, top: 1_900, startTop: 2_000, writesSinceStart: true };
  assert.equal(touchLiftNeedsJudgement(lift), false);
  assert.equal(touchLiftNeedsJudgement({ ...lift, scrolledNatively: true }), true);
  assert.equal(touchLiftNeedsJudgement({ ...lift, moved: true }), true);
  assert.equal(touchLiftNeedsJudgement({ ...lift, writesSinceStart: false }), true);
  assert.equal(touchLiftNeedsJudgement({ ...lift, moved: true, top: 2_000 }), false, 'the offset did not move');
});

test('the jump control shows whenever the end is not kept and the view does not stand at it', () => {
  const at = (top) => ({ top, maxScrollTop: 1_000, viewportHeight: 600 });
  assert.equal(jumpButtonVisible(at(1_000), false), false, 'at the end');
  assert.equal(jumpButtonVisible(at(998), false), false, 'two pixels short still stands at the end');
  assert.equal(jumpButtonVisible(at(997), false), true, 'three pixels short does not');
  assert.equal(jumpButtonVisible(at(900), false), true, 'inside the band that takes follow back');
  assert.equal(jumpButtonVisible(at(0), true), false, 'a kept end hides it however far');
});
