import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldPreserveComposerDraftOnScopeChange } from "./composer-draft.ts";

test("a New Task project switch preserves the composer draft", () => {
  assert.equal(
    shouldPreserveComposerDraftOnScopeChange(
      "new-task:C:\\Project\\one",
      "new-task:C:\\Project\\two",
    ),
    true,
  );
});

test("session transitions do not preserve an inactive composer draft", () => {
  assert.equal(
    shouldPreserveComposerDraftOnScopeChange("session-1", "session-2"),
    false,
  );
  assert.equal(
    shouldPreserveComposerDraftOnScopeChange("new-task:C:\\Project\\one", "session-1"),
    false,
  );
});
