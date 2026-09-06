import assert from "node:assert/strict";
import test from "node:test";
import { estimateRetainedChars } from "./renderer-value-weight.ts";

test("retained-size accounting covers text, container overhead and shared objects", () => {
  const child = { text: "x".repeat(10_000) };
  const single = estimateRetainedChars({ child }, 100_000);
  const shared = estimateRetainedChars({ left: child, right: child }, 100_000);
  const copies = estimateRetainedChars({ left: child, right: { ...child } }, 100_000);
  assert.ok(single > 10_000);
  assert.ok(shared > single && shared < 11_000);
  assert.ok(copies > 20_000);
  child.cycle = child;
  assert.ok(Number.isFinite(estimateRetainedChars(child, 100_000)));
});

test("oversized and unsupported values bypass the cache without losing the value", () => {
  const value = { text: "x".repeat(1_000_000) };
  assert.ok(estimateRetainedChars(value, 1_024) > 1_024);
  assert.equal(value.text.length, 1_000_000);
  assert.ok(estimateRetainedChars(new Date(), 1_024) > 1_024);
  let nested = {};
  for (let index = 0; index < 100; index += 1) nested = { child: nested };
  assert.ok(estimateRetainedChars(nested, 100_000) > 100_000);
});
