import assert from "node:assert/strict";
import test from "node:test";

import { createRoutePreferenceStore, mergeRoutePreference } from "./app-route-preference.ts";

test("switching models does not inherit Fast from the previous model", () => {
  const selection = mergeRoutePreference(
    { provider: "openai", model: "gpt-5.6", effort: "high", fast: true },
    { provider: "anthropic", model: "claude-fable", effort: "high" },
  );

  assert.deepEqual(selection, {
    provider: "anthropic",
    model: "claude-fable",
    effort: "high",
  });
});

test("partial changes for the same model preserve its existing tuning", () => {
  const selection = mergeRoutePreference(
    {
      provider: "openai",
      model: "gpt-5.6",
      effort: "high",
      fast: true,
      modelParameters: { context: "128k" },
    },
    { provider: "openai", model: "gpt-5.6", fast: false },
  );

  assert.deepEqual(selection, {
    provider: "openai",
    model: "gpt-5.6",
    effort: "high",
    fast: false,
    modelParameters: { context: "128k" },
  });
});

test("each model restores its own last-used tuning", () => {
  const store = createRoutePreferenceStore();
  store.remember({
    provider: "openai",
    model: "gpt-5.6",
    effort: "high",
    fast: true,
    modelParameters: { context: "128k" },
  });
  store.remember({
    provider: "anthropic",
    model: "claude-fable",
    effort: "medium",
    fast: false,
  });

  assert.deepEqual(store.get("openai", "gpt-5.6"), {
    provider: "openai",
    model: "gpt-5.6",
    effort: "high",
    fast: true,
    modelParameters: { context: "128k" },
  });
  assert.deepEqual(store.get("anthropic", "claude-fable"), {
    provider: "anthropic",
    model: "claude-fable",
    effort: "medium",
    fast: false,
  });
});
