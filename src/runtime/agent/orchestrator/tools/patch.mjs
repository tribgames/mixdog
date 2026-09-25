// apply_patch — one-turn multi-file edits from a unified diff.
//
// This file is a FACADE over the cohesive modules under ./patch/; it
// re-exports the public surface importers use (session/loop.mjs, scripts/*,
// code-graph, memory, etc.):
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
// Executor: NATIVE-ONLY dispatch to the mixdog-patch Rust engine, no JS apply
// fallback.

// Side-effect import: schedules the native-patch prewarm on module load.
import { scheduleNativePatchPrewarm } from './patch/native-server.mjs';

export { PATCH_TOOL_DEFS } from './patch-tool-defs.mjs';
export { runServerEdit, closeNativePatchServerForTests } from './patch/native-server.mjs';
export { takeApplyPatchUiDiff, executePatchTool } from './patch/orchestrator.mjs';

scheduleNativePatchPrewarm();
