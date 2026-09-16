// Writes. tidy NEVER writes with fs directly: every byte goes through
// atomicWrite, and each written path runs the same post-write invalidation trio
// the builtin edit adapters run (external-tool-adapters.mjs:16-26) — result
// cache, code-graph dirty paths, read snapshot — so a formatted file is not
// served from a stale cache or hidden behind "[file unchanged]".
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { atomicWrite } from '../agent/orchestrator/tools/builtin/atomic-write.mjs';
import { invalidateBuiltinResultCache } from '../agent/orchestrator/tools/builtin/cache-layers.mjs';
import { recordReadSnapshot } from '../agent/orchestrator/tools/builtin/read-snapshot-runtime.mjs';
import {
  hasUnsafeWin32Component,
  isBlockedDevicePath,
  isUncPath,
  isWindowsDevicePath,
} from '../agent/orchestrator/tools/builtin/device-paths.mjs';
import { markCodeGraphDirtyPaths } from '../agent/orchestrator/tools/code-graph-state.mjs';

/** Same write-target guards the builtin edit surfaces enforce. */
export function guardTidyWritePath(fullPath) {
  if (isUncPath(fullPath)) return `cannot write UNC / SMB path: ${fullPath}`;
  if (isWindowsDevicePath(fullPath)) return `cannot write Windows device path: ${fullPath}`;
  if (hasUnsafeWin32Component(fullPath))
    return `cannot write path with a trailing dot/space or ADS component: ${fullPath}`;
  if (isBlockedDevicePath(fullPath)) return `cannot write device path: ${fullPath}`;
  return null;
}

export function fullPathFor(cwd, filePath) {
  const value = String(filePath || '');
  return isAbsolute(value) ? value : resolve(cwd, value);
}

/**
 * Order byte-range replacements for application: descending by start offset so
 * every earlier offset stays valid. Overlapping ranges are never applied —
 * the file is rejected whole, because a partial apply of conflicting fixes
 * produces text no rule asked for.
 */
export function planReplacements(fixes) {
  const usable = [];
  const invalid = [];
  for (const fix of fixes || []) {
    const range = fix?.byteOffset;
    const start = Number(range?.[0]);
    const end = Number(range?.[1]);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      typeof fix.text !== 'string'
    ) {
      invalid.push(fix);
      continue;
    }
    usable.push({ start, end, text: fix.text, ruleId: fix.ruleId || '' });
  }
  const ascending = [...usable].sort((a, b) => a.start - b.start || a.end - b.end);
  const overlaps = [];
  for (let index = 1; index < ascending.length; index += 1) {
    const previous = ascending[index - 1];
    const current = ascending[index];
    if (current.start < previous.end) overlaps.push({ previous, current });
  }
  return {
    replacements: [...ascending].reverse(),
    overlaps,
    invalid,
  };
}

/** Apply pre-ordered (descending) replacements to a buffer. */
export function applyReplacements(buffer, replacements) {
  let output = Buffer.from(buffer);
  for (const replacement of replacements) {
    if (replacement.start > output.length || replacement.end > output.length) {
      throw new Error(`replacement range [${replacement.start},${replacement.end}] is outside the file`);
    }
    output = Buffer.concat([
      output.subarray(0, replacement.start),
      Buffer.from(replacement.text, 'utf8'),
      output.subarray(replacement.end),
    ]);
  }
  return output;
}

/** Post-write bookkeeping for one path; every step is best-effort. */
export function noteWrittenFile(fullPath, { sessionId = null } = {}) {
  try {
    invalidateBuiltinResultCache([fullPath]);
  } catch {
    /* best-effort */
  }
  try {
    markCodeGraphDirtyPaths([fullPath]);
  } catch {
    /* best-effort */
  }
  try {
    recordReadSnapshot(fullPath, statSync(fullPath), sessionId || null, {
      source: 'tidy',
      isPartialView: false,
      replaceExisting: true,
    });
  } catch {
    /* best-effort */
  }
}

/** Engines that format in place still need the invalidation trio per file. */
export function noteWrittenFiles(fullPaths, options = {}) {
  for (const fullPath of fullPaths || []) noteWrittenFile(fullPath, options);
}

/** Write one file through the pipeline and invalidate. */
export async function writeThroughPipeline(fullPath, content, { sessionId = null, signal = null } = {}) {
  const guard = guardTidyWritePath(fullPath);
  if (guard) throw new Error(guard);
  await atomicWrite(fullPath, content, { sessionId, signal });
  noteWrittenFile(fullPath, { sessionId });
}

/**
 * Apply structural byte-range fixes, grouped per file.
 * `matchesByFile` maps a repo-relative path to its matches; only matches with a
 * `fix` participate. Returns applied files and per-file rejections.
 */
export async function applyStructuralFixes({ cwd, matchesByFile, sessionId = null, signal = null } = {}) {
  const applied = [];
  const rejected = [];
  for (const [file, matches] of Object.entries(matchesByFile || {})) {
    const fixes = matches.filter((match) => match?.fix).map((match) => ({ ...match.fix, ruleId: match.ruleId }));
    if (fixes.length === 0) continue;
    const fullPath = fullPathFor(cwd, file);
    const guard = guardTidyWritePath(fullPath);
    if (guard) {
      rejected.push({ file, reason: guard });
      continue;
    }
    const plan = planReplacements(fixes);
    if (plan.overlaps.length > 0) {
      rejected.push({
        file,
        reason: `overlapping fixes from ${[...new Set(plan.overlaps.flatMap((pair) => [pair.previous.ruleId, pair.current.ruleId]))].filter(Boolean).join(', ') || 'structural rules'}`,
        overlaps: plan.overlaps.length,
      });
      continue;
    }
    if (plan.invalid.length > 0) {
      rejected.push({ file, reason: `${plan.invalid.length} fix(es) carried an unusable byte range` });
      continue;
    }
    try {
      const next = applyReplacements(readFileSync(fullPath), plan.replacements);
      await writeThroughPipeline(fullPath, next, { sessionId, signal });
      applied.push({ file, fixes: plan.replacements.length });
    } catch (error) {
      rejected.push({ file, reason: error?.message || String(error) });
    }
  }
  return { applied, rejected };
}
