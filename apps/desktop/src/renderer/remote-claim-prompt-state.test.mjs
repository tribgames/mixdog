import assert from "node:assert/strict";
import test from "node:test";

import {
  isRemoteClaimPromptActive,
  setRemoteClaimPromptActive,
  subscribeRemoteClaimPromptActive,
} from "./remote-claim-prompt-state.ts";

test("remote approval prompts are armed only by the Connection panel", () => {
  setRemoteClaimPromptActive(false);
  const seen = [];
  const unsubscribe = subscribeRemoteClaimPromptActive((active) => seen.push(active));
  try {
    setRemoteClaimPromptActive(true);
    setRemoteClaimPromptActive(true);
    setRemoteClaimPromptActive(false);
    assert.deepEqual(seen, [true, false]);
    assert.equal(isRemoteClaimPromptActive(), false);
  } finally {
    unsubscribe();
    setRemoteClaimPromptActive(false);
  }
});
