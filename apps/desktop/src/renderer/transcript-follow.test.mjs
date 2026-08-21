import assert from "node:assert/strict";
import test from "node:test";

import { shouldDeferTranscriptScrollAdjustment } from "./TranscriptList.tsx";
import { touchMoveShouldReleaseFollow } from "./use-transcript-follow.ts";

test("every active reader gesture defers corrective transcript scroll writes", () => {
  assert.equal(shouldDeferTranscriptScrollAdjustment(true), true);
  assert.equal(shouldDeferTranscriptScrollAdjustment(false), false);
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
