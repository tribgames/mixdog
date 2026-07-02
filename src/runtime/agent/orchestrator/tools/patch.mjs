// apply_patch — one-turn multi-file edits from a unified diff.
//
// This file is now a FACADE. The implementation was split into cohesive
// modules under ./patch/ during a behavior-preserving refactor; this module
// re-exports the identical public surface so existing importers
// (session/loop.mjs, scripts/*, code-graph, memory, etc.) are unaffected:
//
//   ./patch/native-server.mjs — NativePatchServer transport, env gating,
//     binary resolution, prewarm/idle lifecycle, runServerEdit,
//     closeNativePatchServerForTests, globalThis.__mixdogCloseNativePatchServers.
//   ./patch/constants.mjs     — shared literals / hunk-header regexes.
//   ./patch/paths.mjs         — path resolution, entry classification,
//     preValidateNativeBatch, header rewrite.
//   ./patch/matcher.mjs       — byte-parity diagnostic matcher, line splitters,
//     typographic normalization, nearest-line hints, V4A line-sequence search.
//   ./patch/parsing.mjs       — V4A + unified-as-V4A parsers, format detection.
//   ./patch/v4a-convert.mjs   — V4A hunk apply, rename sections, V4A→unified
//     conversion.
//   ./patch/dispatch.mjs      — native dispatch + failure-context formatting.
//   ./patch/orchestrator.mjs  — apply_patch orchestration + executePatchTool
//     + replay capture + UI-diff side-channel.
//
// Backend is unchanged: NATIVE-ONLY dispatch to the mixdog-patch Rust engine,
// no JS apply fallback. Public exports below match the pre-split surface.

// Side-effect import: schedules the native-patch prewarm on module load, as
// the original patch.mjs did at top level.
import { scheduleNativePatchPrewarm } from './patch/native-server.mjs';

export { PATCH_TOOL_DEFS } from './patch-tool-defs.mjs';
export { runServerEdit, closeNativePatchServerForTests } from './patch/native-server.mjs';
export { takeApplyPatchUiDiff, executePatchTool } from './patch/orchestrator.mjs';

// Test-only export: lets the regression harness exercise the interior-vs-outer
// change-band logic in findFirstFailingUnifiedHunk without spawning the native
// binary. Assembled here to preserve the original `__patchTestHooks` surface.
import {
  findFirstFailingUnifiedHunk,
  computeUnifiedChangeBand,
  collectUnifiedOps,
  unifiedOldLinesMatchAt,
  splitBufferLinesForPatch,
} from './patch/matcher.mjs';

export const __patchTestHooks = { findFirstFailingUnifiedHunk, computeUnifiedChangeBand, collectUnifiedOps, unifiedOldLinesMatchAt, splitBufferLinesForPatch };

scheduleNativePatchPrewarm();
