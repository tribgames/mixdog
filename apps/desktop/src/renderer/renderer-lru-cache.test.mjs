import assert from "node:assert/strict";
import test from "node:test";
import { RendererLruCache } from "./renderer-lru-cache.ts";
import { enforceRendererCacheBudget, totalBudgetedChars } from "./renderer-cache-budget.ts";

test("weighted LRU enforces count, replacement accounting and oversized bypass", () => {
  const cache = new RendererLruCache({
    name: "test-lru", maxEntries: 2, maxChars: 8, measure: (value) => value.length,
  });
  try {
    cache.set("a", "aa");
    cache.set("b", "bb");
    cache.get("a");
    cache.set("c", "cc");
    assert.equal(cache.get("b"), undefined);
    cache.set("a", "aaaa");
    assert.equal(cache.chars(), 6);
    cache.set("a", "x".repeat(9));
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.chars(), 2);
    cache.delete("c");
    assert.equal(cache.chars(), 0);
  } finally { cache.dispose(); }
});

test("shared pressure trims the largest cache and disposal unregisters it", () => {
  const baseline = totalBudgetedChars();
  const small = new RendererLruCache({ name: "test-small", maxEntries: 4, maxChars: 20, measure: v => v.length });
  const large = new RendererLruCache({ name: "test-large", maxEntries: 4, maxChars: 20, measure: v => v.length });
  try {
    small.set("s", "ss");
    large.set("old", "1234");
    large.set("new", "5678");
    enforceRendererCacheBudget(baseline + 6);
    assert.equal(small.get("s"), "ss");
    assert.equal(large.get("old"), undefined);
    assert.equal(large.get("new"), "5678");
    assert.ok(totalBudgetedChars() <= baseline + 6);
  } finally { small.dispose(); large.dispose(); }
  assert.equal(totalBudgetedChars(), baseline);
});

test("disposing an old registration cannot unregister its replacement", () => {
  const before = totalBudgetedChars();
  const options = { name: "replaced", maxEntries: 1, maxChars: 10, measure: v => v.length };
  const old = new RendererLruCache(options);
  const current = new RendererLruCache(options);
  current.set("a", "123");
  old.dispose();
  assert.equal(totalBudgetedChars(), before + 3);
  current.dispose();
  assert.equal(totalBudgetedChars(), before);
});
