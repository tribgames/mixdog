import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRendererComposerActionDiagnostic } from "./renderer-recovery.ts";

test("composer diagnostics retain action provenance without prompt content", () => {
  assert.deepEqual(normalizeRendererComposerActionDiagnostic({
    kind: "composer-action",
    action: "restore-queue",
    source: "arrow-up",
    turnBusy: true,
    queueCount: 2,
    draftLength: 14,
    composing: false,
    uptimeMs: 3210.4,
    targeted: true,
    text: "must not survive",
  }), {
    action: "restore-queue",
    source: "arrow-up",
    turnBusy: true,
    queueCount: 2,
    draftLength: 14,
    composing: false,
    uptimeMs: 3210,
    targeted: true,
  });
  assert.equal(normalizeRendererComposerActionDiagnostic({
    kind: "composer-action",
    action: "restore-queue",
    source: "unknown",
  }), null);
});
