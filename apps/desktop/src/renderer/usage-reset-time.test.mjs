import assert from "node:assert/strict";
import test from "node:test";

import {
  formatUsageResetRemaining,
  nextUsageResetVerificationAt,
  usageResetPresentation,
} from "./usage-reset-time.ts";

test("usage reset time includes minutes when less than one day remains", () => {
  assert.equal(formatUsageResetRemaining(5 * 3_600_000 + 17 * 60_000), "5h 17m");
  assert.equal(formatUsageResetRemaining(5 * 3_600_000), "5h 0m");
  assert.equal(formatUsageResetRemaining(42 * 60_000), "42m");
  assert.equal(formatUsageResetRemaining(23 * 3_600_000 + 59 * 60_000), "23h 59m");
});

test("usage reset time stays compact for days and rounds partial units up", () => {
  assert.equal(formatUsageResetRemaining(4 * 86_400_000 + 20 * 3_600_000 + 1), "4d 21h");
  assert.equal(formatUsageResetRemaining(10_000), "1m");
  assert.equal(formatUsageResetRemaining(0), "");
});

test("expired usage shows 0% until verification, then dashes when still unknown", () => {
  assert.deepEqual(usageResetPresentation({
    percent: 100,
    resetAt: 1_000,
    refreshedAt: 900,
    verificationFailed: false,
    now: 1_001,
  }), { percent: 0, resetTextOverride: "—" });
  assert.deepEqual(usageResetPresentation({
    percent: 100,
    resetAt: 1_000,
    refreshedAt: 900,
    verificationFailed: true,
    now: 1_001,
  }), { percent: null, resetTextOverride: "—" });
  assert.deepEqual(usageResetPresentation({
    percent: 100,
    resetAt: 1_000,
    refreshedAt: 1_001,
    verificationFailed: false,
    now: 1_001,
  }), { percent: null, resetTextOverride: "—" });
  assert.deepEqual(usageResetPresentation({
    percent: 97,
    resetAt: 1_000,
    refreshedAt: 900,
    verificationFailed: false,
    now: 999,
  }), { percent: 97, resetTextOverride: null });
});

test("reset verification selects the earliest unconfirmed reset", () => {
  assert.equal(nextUsageResetVerificationAt([3_000, 1_000, 2_000], 900, new Set()), 1_000);
  assert.equal(nextUsageResetVerificationAt([3_000, 1_000, 2_000], 1_500, new Set()), 2_000);
  assert.equal(nextUsageResetVerificationAt([3_000, 2_000], 1_500, new Set([2_000])), 3_000);
});
