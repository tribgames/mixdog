import assert from "node:assert/strict";
import test from "node:test";

import { bindPageHideFlush } from "./layout-persistence.ts";

test("page hide flushes the latest layout state and detaches cleanly", () => {
  let listener = null;
  const target = {
    addEventListener(type, next) {
      assert.equal(type, "pagehide");
      listener = next;
    },
    removeEventListener(type, next) {
      assert.equal(type, "pagehide");
      if (listener === next) listener = null;
    },
  };
  let flushes = 0;
  const dispose = bindPageHideFlush(target, () => { flushes += 1; });
  listener();
  assert.equal(flushes, 1);
  dispose();
  assert.equal(listener, null);
});
