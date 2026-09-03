import assert from "node:assert/strict";
import test from "node:test";

import { usagePinStackFits, usagePinStackHeight } from "./rail-usage-pin-room.ts";

test("the pinned usage stack folds to the glyph once the rail runs short", () => {
  // Three brand rows: 17 padding + 3×34 + 2×10 = 139.
  assert.equal(usagePinStackHeight(3), 139);
  assert.equal(usagePinStackHeight(0), 0);
  const base = { navHeight: 8 * 44, settingsHeight: 44, rowCount: 3 };
  assert.equal(usagePinStackFits({ ...base, railHeight: 352 + 139 + 44 }), true);
  assert.equal(usagePinStackFits({ ...base, railHeight: 352 + 139 + 43 }), false);
  // Nothing pinned never folds anything.
  assert.equal(usagePinStackFits({ ...base, rowCount: 0, railHeight: 100 }), true);
});
