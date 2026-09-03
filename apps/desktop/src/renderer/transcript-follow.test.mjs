import assert from "node:assert/strict";
import test from "node:test";

import { nextTranscriptHistoryLimit } from "./transcript-history.ts";
import { shouldDeferTranscriptScrollAdjustment } from "./TranscriptList.tsx";
import {
  transcriptSelectionPrimaryButtonDown,
  transcriptSelectionPointerRegion,
} from "./transcript-selection-drag.ts";
import {
  boundaryGestureReached,
  grewWhileAtBottom,
  pointerShouldReleaseFollow,
  programmaticWriteMatches,
  readerScrollShouldReleaseFollow,
  selectionAutoScrollShouldReleaseFollow,
  touchMoveShouldReleaseFollow,
  wheelShouldReleaseFollow,
  TRANSCRIPT_OVERFLOW_ANCHOR,
} from "./use-transcript-follow.ts";

/** The wheel handler's boundary decision, exactly as the hook composes it. */
function wheelReleases({ delta, nested }) {
  const transcriptReached = !nested || boundaryGestureReached(nested, delta);
  return {
    marks: transcriptReached,
    releases: wheelShouldReleaseFollow({ delta, transcriptReached }),
  };
}

test("transcript history grows in bounded pages only at a full window", () => {
  assert.equal(nextTranscriptHistoryLimit(120, 512), null);
  assert.equal(nextTranscriptHistoryLimit(512, 512), 1024);
  assert.equal(nextTranscriptHistoryLimit(1300, 1024), 1812);
  assert.equal(nextTranscriptHistoryLimit(8192, 8192), null);
});

test("every active reader gesture defers corrective transcript scroll writes", () => {
  assert.equal(shouldDeferTranscriptScrollAdjustment(true), true);
  assert.equal(shouldDeferTranscriptScrollAdjustment(false), false);
});

test("virtual-core remains the only transcript scroll anchoring authority", () => {
  assert.equal(TRANSCRIPT_OVERFLOW_ANCHOR, "none");
});

test("a touch drag toward older transcript history releases follow", () => {
  assert.equal(touchMoveShouldReleaseFollow({
    delta: -12,
    transcriptReached: true,
  }), true);
});

test("nested scrollers keep touch ownership until the transcript is reached", () => {
  assert.equal(touchMoveShouldReleaseFollow({
    delta: -12,
    transcriptReached: false,
  }), false);
});

test("touch movement toward the tail and sub-pixel jitter keep follow armed", () => {
  assert.equal(touchMoveShouldReleaseFollow({
    delta: 12,
    transcriptReached: true,
  }), false);
  assert.equal(touchMoveShouldReleaseFollow({
    delta: -1,
    transcriptReached: true,
  }), false);
});

test("an upward wheel over the transcript itself releases follow immediately", () => {
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

test("a nested scroller with room left keeps the wheel and never releases follow", () => {
  const outcome = wheelReleases({
    delta: -120,
    nested: { scrollTop: 400, scrollHeight: 900, clientHeight: 300 },
  });
  assert.equal(outcome.marks, false);
  assert.equal(outcome.releases, false);
});

test("a downward wheel never releases follow, boundary or not", () => {
  assert.equal(wheelReleases({ delta: 120, nested: null }).releases, false);
  assert.equal(wheelReleases({
    delta: 120,
    nested: { scrollTop: 600, scrollHeight: 900, clientHeight: 300 },
  }).releases, false);
});

test("an unscrollable nested target hands the gesture straight to the transcript", () => {
  assert.equal(
    boundaryGestureReached({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 }, -50),
    true,
  );
  assert.equal(
    boundaryGestureReached({ scrollTop: 0, scrollHeight: 900, clientHeight: 300 }, 0),
    false,
  );
});

test("a pointer drag releases follow only after leaving the tail upward", () => {
  assert.equal(pointerShouldReleaseFollow({ distance: 400, upwardMove: 20 }), true);
  // Inside the bottom band the drag is selection, not a leave.
  assert.equal(pointerShouldReleaseFollow({ distance: 4, upwardMove: 20 }), false);
  // Downward and sub-pixel travel are not a leave either.
  assert.equal(pointerShouldReleaseFollow({ distance: 400, upwardMove: -20 }), false);
  assert.equal(pointerShouldReleaseFollow({ distance: 400, upwardMove: 1 }), false);
});

test("native selection autoscroll releases follow only when it moves upward", () => {
  assert.equal(selectionAutoScrollShouldReleaseFollow(-12), true);
  assert.equal(selectionAutoScrollShouldReleaseFollow(12), false);
  assert.equal(selectionAutoScrollShouldReleaseFollow(0), false);
});

test("selection remains active outside the viewport only while the primary button is held", () => {
  assert.equal(transcriptSelectionPrimaryButtonDown(1), true);
  assert.equal(transcriptSelectionPrimaryButtonDown(3), true);
  assert.equal(transcriptSelectionPrimaryButtonDown(0), false);
  assert.equal(transcriptSelectionPrimaryButtonDown(2), false);
});

test("selection outside the transcript stays on one stable boundary", () => {
  const region = (x, y) =>
    transcriptSelectionPointerRegion(x, y, 100, 100, 500, 500);
  assert.equal(region(300, 99), "above");
  assert.equal(region(101, -900), "above");
  assert.equal(region(300, 501), "below");
  assert.equal(region(499, 1_400), "below");
  assert.equal(region(99, 300), "side");
  assert.equal(region(501, 300), "side");
  assert.equal(region(300, 300), "inside");
});

test("only a chrome-pointer upward move counts as a reader scroll release", () => {
  assert.equal(readerScrollShouldReleaseFollow({
    programmatic: false,
    chromePointer: true,
    upwardMove: 30,
  }), true);
  // The timeline's own corrective write is never reader intent.
  assert.equal(readerScrollShouldReleaseFollow({
    programmatic: true,
    chromePointer: true,
    upwardMove: 30,
  }), false);
  // A scroll that did not start on the scrollbar/padding keeps follow.
  assert.equal(readerScrollShouldReleaseFollow({
    programmatic: false,
    chromePointer: false,
    upwardMove: 30,
  }), false);
});

test("growth follows the tail only when the viewport was at the bottom before it", () => {
  assert.equal(grewWhileAtBottom({ distanceBefore: 2, growth: 400 }), true);
  // A row above the reader resolving from its estimate must not yank the view.
  assert.equal(grewWhileAtBottom({ distanceBefore: 900, growth: 400 }), false);
  assert.equal(grewWhileAtBottom({ distanceBefore: 0, growth: 0 }), false);
});

test("a burst of programmatic writes stays attributable to the timeline", () => {
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
  assert.equal(programmaticWriteMatches({
    writes: [{ top: 1_200, time: now - 5_000 }],
    top: 1_200,
    now,
  }), false);
});
