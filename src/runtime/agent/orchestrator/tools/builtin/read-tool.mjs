/**
 * read-tool.mjs — the unified `read` entry point. One call can be an image
 * view, a head-glob survey, a per-file batch (reads[] / path[]), a glance
 * mode (head/tail/count/summary/hex) or a single windowed read; every shape
 * runs the same reachability preflight and string guards first. The stages
 * live under read-tool/: reach-preflight, image-fast-path, glob-survey,
 * batch-entries → batch-dispatch → batch-snapshot → batch-render.
 */
import { executeSingleReadTool } from './read-single-tool.mjs';
import { readPathStringGuardError } from './read-open.mjs';
import { coerceReadFamilyPathArg } from './path-utils.mjs';
import { readIoAdmission } from '../../../../shared/tool-workload-gates.mjs';
import { currentToolExecutionOwner } from '../../../../shared/tool-execution-owner.mjs';
import { readReachPreflight } from './read-tool/reach-preflight.mjs';
import { readImageFastPath } from './read-tool/image-fast-path.mjs';
import { readGlobSurvey } from './read-tool/glob-survey.mjs';
import { normalizeObjectBatchArgs, batchEntriesFromArgs, primaryReadIndexes } from './read-tool/batch-entries.mjs';
import { dispatchBatchReads } from './read-tool/batch-dispatch.mjs';
import { restoreCallerSlots, recordSlicedBatchSnapshots } from './read-tool/batch-snapshot.mjs';
import { renderBatchResults } from './read-tool/batch-render.mjs';

function hasLineCoordinate(path) {
  return typeof path === 'string' && /(?:#L\d+|:\d+(?:-\d+)?(?::|$))/i.test(path);
}

// `file_path` alias — the official SDK schema uses `file_path`; mixdog has
// historically used `path`. Honor `file_path` so a CC-trained agent's call
// shape works without translation (its 1-based offset becomes 0-based).
function applyFilePathAlias(args) {
  if (!(typeof args.file_path === 'string' && !args.path)) return;
  args.path = args.file_path;
  const ccOffset = Number(args.offset);
  if (args.offset !== undefined && args.offset !== null && Number.isFinite(ccOffset) && ccOffset > 0) {
    args.offset = Math.trunc(ccOffset) - 1;
  }
}

// Unified-read dispatch (v0.6.283+):
//   reads: [{path, mode?, n?, offset?, limit?, full?}]
//                               → per-file batch (different
//                                 ranges per file in one call)
//   path: string[] | object[]   → parallel per-file batch
//                                 (top-level opts apply uniformly)
//   mode: 'head'|'tail'|'count' → head / tail / wc handlers
//   else                        → single-file read below.
// Single turn can touch many files or swap modes without
// the agent iterating across multiple tool names.
async function executeBatchRead(args, workDir, readStateScope, executeChildBuiltinTool, options, helpers) {
  const parsed = batchEntriesFromArgs(args, workDir, helpers);
  if (parsed.error) return parsed.error;
  const { entries, overrides } = parsed;
  // When origEntries/entryToDeduped are set (reads[] coalesce path), results
  // are re-ordered to match the caller's original entry order.
  const origEntries = Array.isArray(args._readsOrigEntries) ? args._readsOrigEntries : null;
  const entryMap = Array.isArray(args._readsEntryToDeduped) ? args._readsEntryToDeduped : null;
  const readIndexFor = primaryReadIndexes(entries, overrides, (p) => helpers.resolveAgainstCwd(p, workDir));
  const results = await dispatchBatchReads({
    entries,
    readIndexFor,
    workDir,
    options,
    helpers,
    executeChildBuiltinTool,
  });
  const orderedResults = origEntries ? restoreCallerSlots(results, origEntries, entryMap, options, helpers) : results;
  if (origEntries) await recordSlicedBatchSnapshots(orderedResults, workDir, readStateScope, helpers);
  return renderBatchResults(orderedResults, args, helpers);
}

// Mode routing. A window already dropped any conflicting head/tail/summary
// glance (so the window is served by executeSingleReadTool); what remains
// here is a mode-only read, or count/hex which are not text windows.
function executeModeRead(args, workDir, readStateScope, executeChildBuiltinTool, options, helpers) {
  const runReadIo = (task) =>
    readIoAdmission.run(options?.callerSessionId || options?.sessionId || currentToolExecutionOwner(), task, {
      signal: options?.signal || options?.abortSignal || null,
    });
  if (args.mode === 'head')
    return runReadIo(() => executeChildBuiltinTool('head', { path: args.path, n: args.n }, workDir));
  if (args.mode === 'tail')
    return runReadIo(() => executeChildBuiltinTool('tail', { path: args.path, n: args.n }, workDir));
  if (args.mode === 'count') return runReadIo(() => executeChildBuiltinTool('wc', { path: args.path }, workDir));
  if (args.mode === 'summary')
    return runReadIo(() =>
      executeChildBuiltinTool('summary', { path: args.path, n: args.n, limit: args.limit }, workDir)
    );
  if (args.mode === 'hex')
    return runReadIo(() =>
      executeChildBuiltinTool('hex', { path: args.path, n: args.n, offset: args.offset }, workDir)
    );
  return runReadIo(() => executeSingleReadTool(args, workDir, readStateScope, options, helpers));
}

export async function executeReadTool(
  args,
  workDir,
  readStateScope,
  executeChildBuiltinTool,
  options = {},
  helpers = {}
) {
  const { normalizeInputPath, normaliseReadLineWindowArgs } = helpers;
  applyFilePathAlias(args);
  args.path = coerceReadFamilyPathArg(args.path, workDir);
  // Reachability preflight up front (all shapes) — before
  // readPathStringGuardError / image stat.
  // options._skipReachPreflight: set only by the batch dispatcher on its
  // child reads. The parent batch call already ran this exact preflight over
  // EVERY candidate path in the array, so re-running it per child re-stats
  // the same mounts N times. The UNC/device/ADS string guards still run
  // inside the child (readPathStringGuardError / image fast-path) — only the
  // async reachability stat is skipped, never the security guards.
  if (options?._skipReachPreflight !== true) {
    const preflight = await readReachPreflight(args.path, workDir, helpers);
    if (preflight.error) return preflight.error;
    options = { ...options, _preflightStats: preflight.statsByPath };
  }
  const image = await readImageFastPath(args, workDir, options, helpers);
  if (image) return image;
  const survey = await readGlobSurvey(
    args,
    workDir,
    executeChildBuiltinTool,
    options,
    helpers,
    (surveyArgs, surveyOptions) =>
      executeReadTool(surveyArgs, workDir, readStateScope, executeChildBuiltinTool, surveyOptions, helpers)
  );
  if (survey !== null) return survey;
  const batch = normalizeObjectBatchArgs(args, workDir, helpers);
  if (batch.error) return batch.error;
  args = batch.args;
  if (Array.isArray(args.path)) {
    return executeBatchRead(args, workDir, readStateScope, executeChildBuiltinTool, options, helpers);
  }
  // Device-file / UNC / scope guards must run BEFORE mode dispatches so
  // head/tail/wc internal readers cannot bypass the /dev/* block that the
  // default-mode branch enforces.
  if (typeof args.path === 'string' && args.path) {
    const modeGuardErr = readPathStringGuardError(args.path, workDir);
    if (modeGuardErr) return `Error: ${modeGuardErr}`;
  }
  if (typeof args.path === 'string') {
    args.path = normalizeInputPath(args.path);
    // A window (offset/limit or a path:line coordinate) beats a glance mode
    // (head/tail/summary), which would otherwise read from a file end and
    // silently drop the window. Drop the glance mode BEFORE path:line
    // compatibility normalization so any path coordinate is converted to
    // offset/limit. count/hex are not text-window ops and keep their mode.
    const windowed = args.offset != null || args.limit != null || hasLineCoordinate(args.path);
    if (windowed && (args.mode === 'head' || args.mode === 'tail' || args.mode === 'summary')) {
      args = { ...args, mode: undefined };
    }
    args = normaliseReadLineWindowArgs(args, workDir);
    if (args._invertedRangeError) return args._invertedRangeError;
  }
  return executeModeRead(args, workDir, readStateScope, executeChildBuiltinTool, options, helpers);
}
