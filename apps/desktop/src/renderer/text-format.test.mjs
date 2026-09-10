import assert from "node:assert/strict";
import test from "node:test";
import { formatElapsed } from "./text-format.ts";
import { uiTimeUnit } from "./ui-format.ts";

test("elapsed time preserves sub-hour output and switches to hours at 60 minutes", () => {
  const cases = [
    [0, []],
    [999, []],
    [1_000, [[1, "second"]]],
    [60_000, [[1, "minute"]]],
    [3_599_999, [[59, "minute"], [59, "second"]]],
    [3_600_000, [[1, "hour"]]],
    [3_601_000, [[1, "hour"], [1, "second"]]],
    [3_660_000, [[1, "hour"], [1, "minute"]]],
    [8_785_000, [[2, "hour"], [26, "minute"], [25, "second"]]],
    [90_000_000, [[25, "hour"]]],
  ];
  for (const [elapsedMs, units] of cases) {
    assert.equal(
      formatElapsed(elapsedMs),
      units.map(([value, unit]) => uiTimeUnit(value, unit)).join(" "),
      `elapsedMs=${elapsedMs}`,
    );
  }
});
