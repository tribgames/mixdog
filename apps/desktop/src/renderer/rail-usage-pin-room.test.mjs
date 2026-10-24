import assert from 'node:assert/strict';
import test from 'node:test';

import { usagePinStackFits, usagePinStackHeight, usagePinVisibleCount } from './rail-usage-pin-room.ts';

test('visible slots honour the limit, shrink on a short rail and reserve chevron room', () => {
  const base = { navHeight: 100, settingsHeight: 44, total: 8, limit: 5 };
  // Five slots: 17 + 5×40 + 4×12 = 265, plus two 12px chevrons.
  assert.equal(usagePinVisibleCount({ ...base, railHeight: 100 + 44 + 265 + 24 }), 5);
  assert.equal(usagePinVisibleCount({ ...base, railHeight: 100 + 44 + 265 + 23 }), 4);
  // Everything shown needs no chevrons.
  assert.equal(usagePinVisibleCount({ ...base, total: 3, limit: 5, railHeight: 100 + 44 + 161 }), 3);
  // Not even one slot (17 + 40 + 24 = 81) fits: the pie fallback.
  assert.equal(usagePinVisibleCount({ ...base, railHeight: 100 + 44 + 80 }), 0);
  assert.equal(usagePinVisibleCount({ ...base, limit: 3, railHeight: 5000 }), 3);
});

test('the pinned usage stack folds to the glyph once the rail runs short', () => {
  // Three brand rows: 17 padding + 3×40 + 2×12 = 161.
  assert.equal(usagePinStackHeight(3), 161);
  assert.equal(usagePinStackHeight(0), 0);
  const base = { navHeight: 8 * 44, settingsHeight: 44, rowCount: 3 };
  assert.equal(usagePinStackFits({ ...base, railHeight: 352 + 161 + 44 }), true);
  assert.equal(usagePinStackFits({ ...base, railHeight: 352 + 161 + 43 }), false);
  // Nothing pinned never folds anything.
  assert.equal(usagePinStackFits({ ...base, rowCount: 0, railHeight: 100 }), true);
});
