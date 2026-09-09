import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeRemoteBrowserControl,
  normalizeRemoteBrowserFrameId,
  remoteBrowserImagePoint,
} from "./remote-browser.ts";

test("remote browser controls admit only bounded navigation and human input", () => {
  assert.deepEqual(
    normalizeRemoteBrowserControl({ type: "tap", frameId: "rbf_a9", x: 120.5, y: 44 }),
    { type: "tap", frameId: "rbf_a9", x: 120.5, y: 44 },
  );
  assert.deepEqual(
    normalizeRemoteBrowserControl({
      type: "swipe",
      frameId: "rbf_a9",
      from: { x: 10, y: 20 },
      to: { x: 30, y: 40 },
      ignored: "not forwarded",
    }),
    {
      type: "swipe",
      frameId: "rbf_a9",
      from: { x: 10, y: 20 },
      to: { x: 30, y: 40 },
    },
  );
  assert.equal(normalizeRemoteBrowserFrameId("rbf_a9"), "rbf_a9");
  for (const command of [{ type: "text", text: "hello" }, { type: "key", key: "Backspace" }]) {
    assert.deepEqual(
      normalizeRemoteBrowserControl({ ...command, frameId: "rbf_a9", documentId: "p2:17" }),
      { ...command, frameId: "rbf_a9", documentId: "p2:17" },
    );
    assert.deepEqual(
      normalizeRemoteBrowserControl({ ...command, frameId: "rbf_a9" }),
      { ...command, frameId: "rbf_a9" },
    );
    for (const documentId of ["", "p0:1", "p2", "p2:17\n", 17, null, "p2:" + "1".repeat(64)]) {
      assert.throws(
        () => normalizeRemoteBrowserControl({ ...command, frameId: "rbf_a9", documentId }),
        /document id is invalid/,
      );
    }
  }
  assert.throws(
    () => normalizeRemoteBrowserControl({ type: "text", text: "x".repeat(2_001) }),
    /text is invalid/,
  );
  assert.throws(
    () => normalizeRemoteBrowserControl({ type: "tap", x: 10, y: 20 }),
    /requires a frame id/,
  );
  assert.throws(
    () => normalizeRemoteBrowserControl({ type: "evaluate", script: "document.cookie" }),
    /unknown remote browser control/,
  );
});

test("remote browser taps map through contain sizing and ignore letterbox space", () => {
  assert.deepEqual(
    remoteBrowserImagePoint(
      { left: 0, top: 0, width: 400, height: 400 },
      { width: 800, height: 400 },
      { x: 200, y: 200 },
    ),
    { x: 400, y: 200 },
  );
  assert.equal(
    remoteBrowserImagePoint(
      { left: 0, top: 0, width: 400, height: 400 },
      { width: 800, height: 400 },
      { x: 200, y: 50 },
    ),
    null,
  );
});
