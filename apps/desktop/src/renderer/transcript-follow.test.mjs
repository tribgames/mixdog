// Transcript auto-follow: the content-commit bottom rule.
//
// Reference parity — Claude Code (render-node-to-output: `sticky || (grew &&
// scrollTop >= prevMaxScroll)`), opencode (createAutoScroll caller: `distance <
// 10 + max(0, delta)`), Codex (pager_overlay: snapshot `is_scrolled_to_bottom()`
// BEFORE the mutation, re-pin after). The regression this guards: a turn that
// opens with a tool card and no preamble grows the transcript by a whole card in
// ONE commit, so a fixed 10px band measured AFTER the growth reads as "reader
// left the tail" and the rest of the turn is buried below the fold.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOTTOM_THRESHOLD_PX, atBottomBeforeGrowth } from './use-transcript-follow.ts';

test('a commit that grew keeps the tail when the viewport sat at the previous bottom', () => {
  // Tool card lands in one commit: 420px of growth, viewport still where it was.
  assert.equal(atBottomBeforeGrowth({ distance: 420, growth: 420 }), true);
  assert.equal(atBottomBeforeGrowth({ distance: 420 + BOTTOM_THRESHOLD_PX - 1, growth: 420 }), true);
  // Streaming text growth, already pinned.
  assert.equal(atBottomBeforeGrowth({ distance: 0, growth: 18 }), true);
});

test('a reader parked above the tail is not dragged back by growth', () => {
  assert.equal(atBottomBeforeGrowth({ distance: 900, growth: 420 }), false);
  assert.equal(atBottomBeforeGrowth({ distance: 420 + BOTTOM_THRESHOLD_PX, growth: 420 }), false);
  assert.equal(atBottomBeforeGrowth({ distance: 40, growth: 0 }), false);
});

test('shrink and non-finite geometry never claim the bottom', () => {
  assert.equal(atBottomBeforeGrowth({ distance: 5, growth: -300 }), false);
  assert.equal(atBottomBeforeGrowth({ distance: Number.NaN, growth: 10 }), false);
  assert.equal(atBottomBeforeGrowth({ distance: 10, growth: Number.NaN }), false);
});

test('the threshold stays overridable for callers with their own band', () => {
  assert.equal(atBottomBeforeGrowth({ distance: 30, growth: 0, threshold: 32 }), true);
  assert.equal(atBottomBeforeGrowth({ distance: 32, growth: 0, threshold: 32 }), false);
});
