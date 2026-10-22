import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attributeWrite,
  chromePressHeld,
  classifyScrollKey,
  judgeScrollEvent,
  jumpButtonVisible,
  keyUpRecent,
  mutationExplainsScroll,
  touchEndRecent,
  touchLiftNeedsJudgement,
  wheelReleasesFollow,
  wheelUpRecent,
  widthShiftPending,
} from './transcript-follow-rules';

test('a wheel releases follow only as a vertical upward notch over a scrolled transcript', () => {
  assert.equal(wheelReleasesFollow({ deltaY: -3 }, 500), true);
  assert.equal(wheelReleasesFollow({ deltaY: -3 }, 0), false, 'nothing above the viewport');
  assert.equal(wheelReleasesFollow({ deltaY: 3 }, 500), false);
  assert.equal(wheelReleasesFollow({ deltaY: -3, ctrlKey: true }, 500), false, 'pinch-zoom');
  assert.equal(wheelReleasesFollow({ deltaY: -3, deltaX: 12 }, 500), false, 'a sideways swipe');
  assert.equal(wheelReleasesFollow({ deltaY: -30, deltaX: 12 }, 500), true);
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
  assert.equal(mutationExplainsScroll({ mutationAt: 1_000, restoredAt: 0, now: 1_399 }), true);
  assert.equal(mutationExplainsScroll({ mutationAt: 1_000, restoredAt: 0, now: 1_400 }), false);
  assert.equal(
    mutationExplainsScroll({ mutationAt: 1_000, restoredAt: 1_100, now: 1_200 }),
    false,
    'a mutation older than the last restore was answered by it'
  );
});

test('the timeline owns a scroll within 150ms of its write, or exactly on the value it wrote', () => {
  const written = { lastWriteAt: 10_000, writtenTops: [1_480] };
  assert.deepEqual(attributeWrite({ ...written, top: 900, now: 10_150 }), { recent: true, exact: false });
  assert.deepEqual(attributeWrite({ ...written, top: 900, now: 10_151 }), { recent: false, exact: false });
  assert.deepEqual(attributeWrite({ ...written, top: 1_480.3, now: 12_000 }), { recent: false, exact: true });
  assert.deepEqual(attributeWrite({ lastWriteAt: 0, writtenTops: [], top: 0, now: 100 }), {
    recent: false,
    exact: false,
  });
});

const base = {
  pinned: true,
  previousTop: 2_000,
  top: 1_900,
  distance: 100,
  lastDirection: -1,
  touchDown: false,
  wheelUpRecent: false,
  inWriteWindow: false,
  atWrittenTop: false,
  pressHeld: false,
  keyUpRecent: false,
  touchEndRecent: false,
  zoomChanged: false,
  zoom: 1,
  mutationRecent: false,
  widthShifted: false,
};
const judge = (over) => judgeScrollEvent({ ...base, ...over });

test('an upward scroll nothing explains leaves; each corroboration leaves even inside the write window', () => {
  assert.equal(judge({}), 'unpin');
  for (const sign of ['touchDown', 'wheelUpRecent', 'pressHeld', 'keyUpRecent', 'touchEndRecent']) {
    assert.equal(judge({ [sign]: true }), 'unpin', sign);
    assert.equal(judge({ [sign]: true, inWriteWindow: true }), 'unpin', `${sign} inside the write window`);
  }
});

test('an upward scroll the page explains is put back, not a leave', () => {
  assert.equal(judge({ inWriteWindow: true }), 'restore', 'the timeline wrote it');
  assert.equal(judge({ mutationRecent: true }), 'restore', 'a fresh layout change');
  assert.equal(judge({ widthShifted: true }), 'restore', 'a container width change');
  // A zoom change rounds the offset by a fraction of a device pixel.
  assert.equal(judge({ zoomChanged: true, zoom: 2, previousTop: 2_000, top: 1_999.7 }), 'restore');
  assert.equal(judge({ zoomChanged: true, zoom: 2, previousTop: 2_000, top: 1_900 }), 'unpin');
});

test('a clamp or move within two pixels of the end is never a leave; an unpinned viewport has none to make', () => {
  assert.equal(judge({ distance: 2 }), 'none');
  assert.equal(judge({ distance: 3 }), 'unpin');
  assert.equal(judge({ pinned: false }), 'none');
  assert.equal(judge({ top: 2_050, previousTop: 2_000, lastDirection: 1 }), 'none', 'downward');
});

test('arriving at the end re-engages follow at once, unless a gesture or a write is behind it', () => {
  const arrive = { pinned: false, previousTop: 1_900, top: 2_000, distance: 1, lastDirection: 1 };
  assert.equal(judge(arrive), 'pin');
  assert.equal(judge({ ...arrive, distance: 2 }), 'none', 'two pixels short is not the end');
  assert.equal(judge({ ...arrive, lastDirection: -1 }), 'none', 'the last move was up');
  assert.equal(judge({ ...arrive, touchDown: true }), 'none', 'a finger is still down');
  assert.equal(judge({ ...arrive, wheelUpRecent: true }), 'none');
  assert.equal(judge({ ...arrive, inWriteWindow: true }), 'none', 'the timeline wrote it');
  assert.equal(judge({ ...arrive, atWrittenTop: true }), 'none');
});

test('a finger lift is judged after a native scroll, or after a travelled or unwritten move', () => {
  const lift = { scrolledNatively: false, moved: false, top: 1_900, startTop: 2_000, writesSinceStart: true };
  assert.equal(touchLiftNeedsJudgement(lift), false);
  assert.equal(touchLiftNeedsJudgement({ ...lift, scrolledNatively: true }), true);
  assert.equal(touchLiftNeedsJudgement({ ...lift, moved: true }), true);
  assert.equal(touchLiftNeedsJudgement({ ...lift, writesSinceStart: false }), true);
  assert.equal(touchLiftNeedsJudgement({ ...lift, moved: true, top: 2_000 }), false, 'the offset did not move');
});

test('a width change is pending until a restore has spent it', () => {
  assert.equal(widthShiftPending(null, 900), false);
  assert.equal(widthShiftPending({ client: 900, spent: null }, 900), false);
  assert.equal(widthShiftPending({ client: 900, spent: null }, 840), true);
  assert.equal(widthShiftPending({ client: 900, spent: 840 }, 840), false);
});

test('the jump control needs follow off and the end more than 200px below', () => {
  const at = (top) => ({ top, maxScrollTop: 1_000, viewportHeight: 600 });
  assert.equal(jumpButtonVisible(at(700), false), true);
  assert.equal(jumpButtonVisible(at(800), false), false, 'exactly 200px');
  assert.equal(jumpButtonVisible(at(799), false), true);
  assert.equal(jumpButtonVisible(at(0), true), false, 'following hides it');
});
