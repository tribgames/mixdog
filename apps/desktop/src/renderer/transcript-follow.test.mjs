import assert from "node:assert/strict";
import test from "node:test";

import { touchMoveShouldReleaseFollow } from "./use-transcript-follow.ts";

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
