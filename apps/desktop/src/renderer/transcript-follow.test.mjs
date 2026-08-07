// Transcript auto-follow: the content-commit bottom rule.
//
// Reference parity — Claude Code (render-node-to-output: `sticky || (grew &&
// scrollTop >= prevMaxScroll)`), opencode (createAutoScroll caller), Codex
// (pager_overlay: snapshot `is_scrolled_to_bottom()` BEFORE the mutation,
// re-pin after). All three ask whether the viewport was at the bottom BEFORE
// the growth, from a snapshot taken before it.
//
// Two regressions meet here: a turn that opens with a tool card and no preamble
// grows the transcript by a whole card in ONE commit and must keep the tail,
// while an IDLE transcript whose off-screen rows resolve from their estimate
// grows just as much ABOVE a reader parked far up — and must not move them.
// Only a pre-mutation snapshot separates the two; the old after-the-fact
// `distance < threshold + growth` accepted both.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOTTOM_THRESHOLD_PX, grewWhileAtBottom } from './use-transcript-follow.ts';

test('a commit that grew keeps the tail when the viewport sat at the previous bottom', () => {
  // Tool card lands in one commit: 420px of growth, viewport was pinned.
  assert.equal(grewWhileAtBottom({ distanceBefore: 0, growth: 420 }), true);
  assert.equal(grewWhileAtBottom({ distanceBefore: BOTTOM_THRESHOLD_PX - 1, growth: 420 }), true);
  // Streaming text growth, already pinned.
  assert.equal(grewWhileAtBottom({ distanceBefore: 0, growth: 18 }), true);
});

test('a reader parked above the tail is not dragged back by growth', () => {
  assert.equal(grewWhileAtBottom({ distanceBefore: 900, growth: 420 }), false);
  assert.equal(grewWhileAtBottom({ distanceBefore: BOTTOM_THRESHOLD_PX, growth: 420 }), false);
  // The idle rollback: a row above the reader resolves from its estimate, so
  // the distance AFTER the growth still looks like "one growth from the tail".
  assert.equal(grewWhileAtBottom({ distanceBefore: 436, growth: 770 }), false);
  assert.equal(grewWhileAtBottom({ distanceBefore: 40, growth: 0 }), false);
});

test('shrink and non-finite geometry never claim the bottom', () => {
  assert.equal(grewWhileAtBottom({ distanceBefore: 5, growth: -300 }), false);
  assert.equal(grewWhileAtBottom({ distanceBefore: Number.NaN, growth: 10 }), false);
  assert.equal(grewWhileAtBottom({ distanceBefore: 5, growth: Number.NaN }), false);
});

test('the threshold stays overridable for callers with their own band', () => {
  assert.equal(grewWhileAtBottom({ distanceBefore: 30, growth: 12, threshold: 32 }), true);
  assert.equal(grewWhileAtBottom({ distanceBefore: 32, growth: 12, threshold: 32 }), false);
});
