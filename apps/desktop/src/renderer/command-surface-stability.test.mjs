import assert from "node:assert/strict";
import test from "node:test";

import {
  commandSurfaceCacheKey,
  commandSurfaceDisplaySnapshot,
  commandSurfaceSessionId,
} from "./command-surface-state.ts";

test("cold context surfaces keep their explicitly addressed session", () => {
  assert.equal(commandSurfaceSessionId("context", "session-a", {}), "session-a");
  assert.equal(commandSurfaceSessionId("inherit", "session-b", null), "session-b");
  assert.equal(
    commandSurfaceSessionId("context", "", { sessionId: "snapshot-session" }),
    "snapshot-session",
  );
});

test("context and inherit caches are isolated per session", () => {
  assert.equal(commandSurfaceCacheKey("context", "session-a"), "context:session-a");
  assert.equal(commandSurfaceCacheKey("context", "session-b"), "context:session-b");
  assert.equal(commandSurfaceCacheKey("inherit", "session-a"), "inherit:session-a");
  assert.equal(commandSurfaceCacheKey("usage", "session-a"), "usage");
});

test("capability snapshots win over empty lane placeholders", () => {
  const authoritative = { sessionId: "session-a", stats: { currentContextTokens: 50 } };
  assert.equal(
    commandSurfaceDisplaySnapshot({ snapshot: authoritative }, {}),
    authoritative,
  );
});
