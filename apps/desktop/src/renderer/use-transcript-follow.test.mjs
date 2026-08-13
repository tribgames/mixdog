import assert from "node:assert/strict";
import test from "node:test";

import {
  isTranscriptChromeTarget,
  pointerShouldReleaseFollow,
  readerScrollShouldReleaseFollow,
} from "./use-transcript-follow.ts";

test("script content clicks are not transcript chrome", () => {
  const root = { id: "transcript" };
  const script = { id: "code" };
  assert.equal(isTranscriptChromeTarget(root, root), true);
  assert.equal(isTranscriptChromeTarget(root, script), false);
  assert.equal(isTranscriptChromeTarget(root, null), false);
});

test("pointer release stays armed at the tail", () => {
  assert.equal(pointerShouldReleaseFollow({ distance: 0, upwardMove: 0 }), false);
  assert.equal(pointerShouldReleaseFollow({ distance: 4, upwardMove: 8 }), false);
  assert.equal(pointerShouldReleaseFollow({ distance: 9, upwardMove: 20 }), false);
});

test("pointer release unlocks only after an upward leave", () => {
  assert.equal(pointerShouldReleaseFollow({ distance: 10, upwardMove: 1 }), false);
  assert.equal(pointerShouldReleaseFollow({ distance: 32, upwardMove: 2 }), true);
  assert.equal(pointerShouldReleaseFollow({ distance: 80, upwardMove: 0 }), false);
});

test("content and tool resizes do not release follow", () => {
  assert.equal(readerScrollShouldReleaseFollow({
    programmatic: false, chromePointer: false, upwardMove: 40,
  }), false);
  assert.equal(readerScrollShouldReleaseFollow({
    programmatic: true, chromePointer: true, upwardMove: 40,
  }), false);
});

test("scrollbar leave releases follow", () => {
  assert.equal(readerScrollShouldReleaseFollow({
    programmatic: false, chromePointer: true, upwardMove: 2,
  }), true);
});
