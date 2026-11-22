import assert from 'node:assert/strict';
import test from 'node:test';

import { usagePinStackFits, usagePinStackHeight, usagePinVisibleCount } from './rail-usage-pin-room.ts';

test('visible slots honour the limit, shrink on a short rail and reserve chevron room', () => {
  const base = { navHeight: 100, settingsHeight: 44, total: 8, limit: 5 };
  // Five slots: 16 + 5×25 + 4×11 = 185, plus two 12px chevrons.
  assert.equal(usagePinVisibleCount({ ...base, railHeight: 100 + 44 + 185 + 24 }), 5);
  assert.equal(usagePinVisibleCount({ ...base, railHeight: 100 + 44 + 185 + 23 }), 4);
  // Everything shown needs no chevrons.
  assert.equal(usagePinVisibleCount({ ...base, total: 3, limit: 5, railHeight: 100 + 44 + 113 }), 3);
  // Not even one slot (16 + 25 + 24) fits: the pie fallback.
  assert.equal(usagePinVisibleCount({ ...base, railHeight: 100 + 44 + 64 }), 0);
  assert.equal(usagePinVisibleCount({ ...base, limit: 3, railHeight: 5000 }), 3);
});

test('the pinned usage stack folds to the glyph once the rail runs short', () => {
  // Three slots: 16 padding + 3×25 + 2×11 = 113.
  assert.equal(usagePinStackHeight(3), 113);
  assert.equal(usagePinStackHeight(0), 0);
  const base = { navHeight: 8 * 44, settingsHeight: 44, rowCount: 3 };
  assert.equal(usagePinStackFits({ ...base, railHeight: 352 + 113 + 44 }), true);
  assert.equal(usagePinStackFits({ ...base, railHeight: 352 + 113 + 43 }), false);
  // Nothing pinned never folds anything.
  assert.equal(usagePinStackFits({ ...base, rowCount: 0, railHeight: 100 }), true);
});

test('one provider is budgeted at the 41 px it is drawn at', () => {
  // 16 padding + one 25px slot; the stylesheet keeps no taller minimum.
  assert.equal(usagePinStackHeight(1), 41);
  const base = { navHeight: 8 * 44, settingsHeight: 44, total: 1, limit: Number.POSITIVE_INFINITY };
  assert.equal(usagePinVisibleCount({ ...base, railHeight: 352 + 44 + 41 }), 1);
  // A pixel short and the stack gives way to the pie glyph.
  assert.equal(usagePinVisibleCount({ ...base, railHeight: 352 + 44 + 40 }), 0);
});

test('six usage slots fit under nine destinations in a 700 px window, not under ten', () => {
  // 700 px window: 35 px title bar and a 1 px seam leave a 664 px rail; Settings is 44.
  const window700 = { railHeight: 664, settingsHeight: 44, total: 6, limit: Number.POSITIVE_INFINITY };
  assert.equal(usagePinStackHeight(6), 221);
  assert.equal(usagePinVisibleCount({ ...window700, navHeight: 9 * 44 }), 6);
  // Ten destinations leave room for fewer than all six, which the collapsed
  // rail answers with the pie glyph.
  assert.ok(usagePinVisibleCount({ ...window700, navHeight: 10 * 44 }) < 6);
});
