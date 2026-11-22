import assert from 'node:assert/strict';
import test from 'node:test';

import { usagePinStackFits, usagePinStackHeight, usagePinVisibleCount } from './rail-usage-pin-room.ts';

test('visible slots honour the limit, shrink on a short rail and reserve chevron room', () => {
  const base = { navHeight: 100, settingsHeight: 44, total: 8, limit: 5 };
  // Five 44px slots = 220, plus two 12px chevrons.
  assert.equal(usagePinVisibleCount({ ...base, railHeight: 100 + 44 + 220 + 24 }), 5);
  assert.equal(usagePinVisibleCount({ ...base, railHeight: 100 + 44 + 220 + 23 }), 4);
  // Everything shown needs no chevrons.
  assert.equal(usagePinVisibleCount({ ...base, total: 3, limit: 5, railHeight: 100 + 44 + 132 }), 3);
  // Not even one slot (44 + 24) fits: the pie fallback.
  assert.equal(usagePinVisibleCount({ ...base, railHeight: 100 + 44 + 67 }), 0);
  assert.equal(usagePinVisibleCount({ ...base, limit: 3, railHeight: 5000 }), 3);
});

test('the pinned usage stack folds to the glyph once the rail runs short', () => {
  // Three slots on the 44px rail pitch.
  assert.equal(usagePinStackHeight(3), 132);
  assert.equal(usagePinStackHeight(0), 0);
  const base = { navHeight: 8 * 44, settingsHeight: 44, rowCount: 3 };
  assert.equal(usagePinStackFits({ ...base, railHeight: 352 + 132 + 44 }), true);
  assert.equal(usagePinStackFits({ ...base, railHeight: 352 + 132 + 43 }), false);
  // Nothing pinned never folds anything.
  assert.equal(usagePinStackFits({ ...base, rowCount: 0, railHeight: 100 }), true);
});

test('one provider is budgeted at the 44 px rail cell it is drawn in', () => {
  // One slot is exactly one Settings-sized cell; no padding, no taller minimum.
  assert.equal(usagePinStackHeight(1), 44);
  const base = { navHeight: 8 * 44, settingsHeight: 44, total: 1, limit: Number.POSITIVE_INFINITY };
  assert.equal(usagePinVisibleCount({ ...base, railHeight: 352 + 44 + 44 }), 1);
  // A pixel short and the stack gives way to the pie glyph.
  assert.equal(usagePinVisibleCount({ ...base, railHeight: 352 + 44 + 43 }), 0);
});

test('five usage slots fit whole under nine destinations in a 700 px window; six scroll', () => {
  // 700 px window: 35 px title bar and a 1 px seam leave a 664 px rail; Settings is 44.
  const window700 = { railHeight: 664, settingsHeight: 44, navHeight: 9 * 44, limit: Number.POSITIVE_INFINITY };
  assert.equal(usagePinStackHeight(6), 264);
  assert.equal(usagePinVisibleCount({ ...window700, total: 5 }), 5);
  // Six leave 224 px for slots and chevrons: four slots between two chevrons.
  assert.equal(usagePinVisibleCount({ ...window700, total: 6 }), 4);
});
