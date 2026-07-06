// V4A hunk locator, in-memory apply, rename sections, and V4A -> unified
// conversion. Moved verbatim from patch.mjs; anchor/context matching, EOF
// handling, rename atomicity, and conversion output are all unchanged.

import { readFileSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { dirname as pathDirname } from 'node:path';
import {
  normalizeOutputPath,
  invalidateBuiltinResultCache,
  clearReadSnapshotForPath,
} from '../builtin.mjs';
import {
  rawContentCacheGet,
  rawContentCacheSet,
} from '../builtin/cache-layers.mjs';
import { atomicWrite } from '../builtin/atomic-write.mjs';
import { assertPathReachable, assertPathsReachable } from '../builtin/fs-reachability.mjs';
import { markCodeGraphDirtyPaths } from '../code-graph-state.mjs';
import { isSpecialFileStat } from '../builtin/device-paths.mjs';
import { resolveV4AEntryPath } from './paths.mjs';
import {
  isV4AEndOfFileMarker,
  parseUnifiedBareV4APatch,
  parseUnifiedCountedAsV4APatch,
} from './parsing.mjs';
import {
  findLineSequence,
  findLineSequenceEscapeEquiv,
  splitTextLinesForPatch,
  firstMeaningfulPatchLine,
  nearestPatchLineHint,
  compactPatchPreviewLine,
  decodeValidUtf8OrNull,
} from './matcher.mjs';

function v4AHunkLineStats(hunk) {
  let oldCount = 0;
  let newCount = 0;
  const oldLines = [];
  const newLines = [];
  for (const raw of hunk.lines || []) {
    if (!raw) continue;
    const tag = raw[0];
    const body = raw.slice(1);
    if (tag === ' ') {
      oldCount++;
      newCount++;
      oldLines.push(body);
      newLines.push(body);
    } else if (tag === '-') {
      oldCount++;
      oldLines.push(body);
    } else if (tag === '+') {
      newCount++;
      newLines.push(body);
    }
  }
  return { oldCount, newCount, oldLines, newLines };
}

function findAnchorLine(lines, anchors, fromLine) {
  let cursor = Math.max(0, fromLine || 0);
  for (const anchorRaw of anchors || []) {
    const anchor = String(anchorRaw || '').trim();
    if (!anchor) continue;
    const found = lines.findIndex((line, idx) => idx >= cursor && line.includes(anchor));
    if (found === -1) return -1;
    cursor = found + 1;
  }
  return cursor;
}

function formatV4AHunkLocator(hunk) {
  return (hunk.anchors || []).filter(Boolean).join(' > ') || '(no anchor)';
}

function formatV4AAnchorMissHint(sourceLines, hunk) {
  const anchors = (hunk?.anchors || []).filter(Boolean);
  const nearest = anchors.length > 0
    ? anchors.map((anchor) => nearestPatchLineHint(sourceLines, anchor, 0)).find(Boolean)
    : null;
  return anchors.length === 0
    ? ' use an existing @@ anchor from the current file or add exact context lines.'
    : ` use an existing @@ anchor from the current file or add exact context lines; no stubs.${nearest ? ` nearest anchor candidate: ${nearest}.` : ''}`;
}

function formatV4AContextMissHint(sourceLines, stats, anchorLine) {
  const expected = firstMeaningfulPatchLine(stats.oldLines);
  const parts = [];
  if (expected) {
    const nearest = nearestPatchLineHint(sourceLines, expected, anchorLine);
    parts.push(`expected first old line: ${JSON.stringify(compactPatchPreviewLine(expected))}`);
    if (nearest) parts.push(nearest);
    const divergence = firstV4ADivergenceHint(sourceLines, stats.oldLines, anchorLine);
    if (divergence) parts.push(divergence);
  }
  parts.push('use exact current context or a broader @@ anchor; no stubs.');
  return ` ${parts.join('; ')}`;
}

// When the FIRST old line does exist verbatim in the source, the real
// mismatch is some later line of the block — name it, with both sides
// JSON-escaped so invisible differences (real char vs literal \uXXXX
// escape, tabs, trailing spaces) become visible in the error.
function firstV4ADivergenceHint(sourceLines, oldLines, anchorLine) {
  const lines = oldLines || [];
  const firstIdx = lines.findIndex((l) => String(l ?? '').trim().length > 0);
  if (firstIdx < 0) return '';
  const first = lines[firstIdx];
  const starts = [];
  for (let i = 0; i < sourceLines.length; i++) {
    if (sourceLines[i] === first) starts.push(i - firstIdx);
  }
  const pref = Number.isFinite(anchorLine) && anchorLine >= 0 ? anchorLine : 0;
  const start = starts.filter((s) => s >= 0)
    .sort((a, b) => Math.abs(a - pref) - Math.abs(b - pref) || a - b)[0];
  if (start === undefined) return '';
  for (let k = 0; k < lines.length; k++) {
    const exp = lines[k];
    const act = sourceLines[start + k];
    if (act !== exp) {
      const actText = act === undefined ? '(past EOF)' : JSON.stringify(compactPatchPreviewLine(act));
      return `first divergent line: old[${k + 1}] expected ${JSON.stringify(compactPatchPreviewLine(exp))} vs file line ${start + k + 1} actual ${actText}`;
    }
  }
  return '';
}

function joinTextLinesForPatch(lines) {
  const body = (lines || []).join('\n');
  return lines?.hasFinalNewline !== false ? `${body}\n` : body;
}

function cloneTextLinesForPatch(sourceLines) {
  const lines = [...(sourceLines || [])];
  lines.hasFinalNewline = sourceLines?.hasFinalNewline !== false;
  return lines;
}

function resolveV4AHunkPosition(sourceLines, hunk, nextSearchLine, options = {}) {
  const stats = v4AHunkLineStats(hunk);
  if (stats.oldCount === 0 && stats.newCount === 0) return { skip: true };
  const fuzzy = options.fuzzy !== false;
  const eof = hunk?.isEndOfFile === true;
  const anchorLine = findAnchorLine(sourceLines, hunk.anchors, nextSearchLine);
  if (anchorLine < 0) {
    const msg = `V4A hunk anchor not found: ${formatV4AHunkLocator(hunk)};${formatV4AAnchorMissHint(sourceLines, hunk)}`;
    return { error: msg };
  }
  let oldLinesPattern = stats.oldLines;
  let newLinesPattern = stats.newLines;
  let oldStartIdx;
  let trimmedTrailing = 0;
  let trimmedTrailingNew = 0;
  if (stats.oldCount === 0) {
    oldStartIdx = eof ? sourceLines.length : anchorLine;
  } else {
    const searchFrom = Math.max(0, anchorLine - 1);
    oldStartIdx = findLineSequence(
      sourceLines,
      oldLinesPattern,
      searchFrom,
      searchFrom,
      { fuzzy, eof },
    );
    if (eof && oldStartIdx < 0 && oldLinesPattern.length > 0 && oldLinesPattern[oldLinesPattern.length - 1] === '') {
      oldLinesPattern = oldLinesPattern.slice(0, -1);
      trimmedTrailing = 1;
      if (newLinesPattern.length > 0 && newLinesPattern[newLinesPattern.length - 1] === '') {
        newLinesPattern = newLinesPattern.slice(0, -1);
        trimmedTrailingNew = 1;
      }
      oldStartIdx = findLineSequence(
        sourceLines,
        oldLinesPattern,
        searchFrom,
        searchFrom,
        { fuzzy, eof },
      );
    }
  }
  // Escape-equivalence fallback (fuzzy, non-EOF only): accept a window where each old
  // line matches the source verbatim OR as the file's literal `\uXXXX` escape
  // of the patch's real character. On match, remap old/context lines to the
  // file's on-disk form so untouched context stays byte-identical and the
  // escape representation survives the edit.
  if (oldStartIdx < 0 && fuzzy && !eof && oldLinesPattern.length > 0) {
    const from = Math.max(0, anchorLine - 1);
    const alt = findLineSequenceEscapeEquiv(sourceLines, oldLinesPattern, from, from);
    if (alt >= 0) {
      const remapped = new Map();
      let ambiguous = false;
      for (let k = 0; k < oldLinesPattern.length; k++) {
        const pat = oldLinesPattern[k];
        const src = sourceLines[alt + k];
        if (remapped.has(pat) && remapped.get(pat) !== src) { ambiguous = true; break; }
        remapped.set(pat, src);
      }
      if (!ambiguous) {
        newLinesPattern = newLinesPattern.map((l) => remapped.get(l) ?? l);
        oldLinesPattern = oldLinesPattern.map((_, k) => sourceLines[alt + k]);
        oldStartIdx = alt;
      }
    }
  }
  if (oldStartIdx < 0) {
    const msg = `V4A hunk context not found: ${formatV4AHunkLocator(hunk)};${formatV4AContextMissHint(sourceLines, stats, anchorLine)} Copy context lines verbatim from the latest read output — do not retype them from memory.`;
    return { error: msg };
  }
  const matchLen = stats.oldCount === 0 ? 0 : oldLinesPattern.length;
  return {
    oldStartIdx,
    matchLen,
    newLines: newLinesPattern,
    nextSearchLine: oldStartIdx + Math.max(1, matchLen),
    trimmedTrailing,
    trimmedTrailingNew,
  };
}

export function applyV4AHunksToLines(sourceLines, hunks, options = {}) {
  const lines = cloneTextLinesForPatch(sourceLines);
  const orderedHunks = orderV4AHunksByFilePosition(lines, hunks, options.fuzzy !== false);
  let nextSearchLine = 0;
  const replacements = [];
  for (const hunk of orderedHunks) {
    const loc = resolveV4AHunkPosition(lines, hunk, nextSearchLine, options);
    if (loc.skip) continue;
    if (loc.error) throw new Error(loc.error);
    replacements.push({
      oldStartIdx: loc.oldStartIdx,
      oldLen: loc.matchLen,
      newLines: loc.newLines,
    });
    nextSearchLine = loc.nextSearchLine;
  }
  for (const rep of replacements.reverse()) {
    lines.splice(rep.oldStartIdx, rep.oldLen, ...rep.newLines);
  }
  return lines;
}

// Order-independent hunk ordering for the V4A apply / V4A->unified conversion.
// Two-phase, semantics-preserving; see the original patch.mjs commentary.
function orderV4AHunksByFilePosition(sourceLines, hunks, fuzzy) {
  const list = hunks || [];
  if (list.length <= 1) return list;
  let nextSearchLine = 0;
  let inputOrderValid = true;
  for (const hunk of list) {
    const stats = v4AHunkLineStats(hunk);
    if (stats.oldCount === 0 && stats.newCount === 0) continue;
    let loc;
    try { loc = resolveV4AHunkPosition(sourceLines, hunk, nextSearchLine, { fuzzy }); }
    catch { loc = { error: true }; }
    if (!loc || loc.error || loc.skip || typeof loc.nextSearchLine !== 'number') {
      inputOrderValid = false;
      break;
    }
    nextSearchLine = loc.nextSearchLine;
  }
  if (inputOrderValid) return list;
  const keyed = [];
  for (let idx = 0; idx < list.length; idx++) {
    const hunk = list[idx];
    const stats = v4AHunkLineStats(hunk);
    if (stats.oldCount === 0 && stats.newCount === 0) {
      keyed.push({ hunk, key: Number.MAX_SAFE_INTEGER, idx });
      continue;
    }
    const seq = [];
    for (const ln of hunk.lines || []) {
      if (isV4AEndOfFileMarker(ln)) continue;
      const p = ln[0];
      if (p === ' ' || p === '-') seq.push(ln.slice(1));
    }
    if (seq.length === 0) return list;
    let pos = -1;
    let count = 0;
    for (let i = 0; i + seq.length <= sourceLines.length; i++) {
      let match = true;
      for (let j = 0; j < seq.length; j++) {
        if (sourceLines[i + j] !== seq[j]) { match = false; break; }
      }
      if (match) {
        if (pos < 0) pos = i;
        count++;
        if (count >= 2) break;
      }
    }
    if (count !== 1) return list;
    keyed.push({ hunk, key: pos, idx });
  }
  keyed.sort((a, b) => (a.key - b.key) || (a.idx - b.idx));
  return keyed.map((e) => e.hunk);
}

export function isV4ARenameSection(section) {
  return section?.kind === 'update' && !!section?.movePath;
}

function v4aRenamePathKey(absPath) {
  return process.platform === 'win32' ? String(absPath || '').toLowerCase() : String(absPath || '');
}

// True when src and dest point at the SAME physical file despite differing
// path strings — the case-only rename case on a case-insensitive fs (macOS,
// Windows). realpathSync collapses casing to the canonical on-disk form, so
// equal realpaths prove same-file. This is authoritative and requires BOTH
// paths to actually exist: if either realpath fails (e.g. dest missing on a
// case-SENSITIVE fs — a normal rename), the paths are NOT the same file, so
// the source must still be unlinked. Never guess "same file" from a
// lowercase string match: that false-positives on case-sensitive fs and turns
// a rename into a copy that leaks the source.
function renameTargetsSamePhysicalFile(srcFull, destFull) {
  if (srcFull === destFull) return false;
  try {
    return realpathSync(srcFull) === realpathSync(destFull);
  } catch {
    return false;
  }
}

function v4aSpecialFileStatMessage(displayPath) {
  return `apply_patch: cannot patch special file (FIFO / character / block device / socket): ${normalizeOutputPath(displayPath)}`;
}

function lstatV4APatchTarget(fullPath, displayPath) {
  const st = lstatSync(fullPath);
  if (isSpecialFileStat(st)) {
    throw new Error(v4aSpecialFileStatMessage(displayPath));
  }
  return st;
}

function validateV4ARenameSection(section, basePath, seenDestKeys) {
  const srcFull = resolveV4AEntryPath(basePath, section.path);
  const destFull = resolveV4AEntryPath(basePath, section.movePath);
  // Case-only rename (foo.js -> Foo.js) on a case-insensitive fs resolves to
  // the same key but is a legitimate rename. Reject "same path" only when the
  // raw paths are byte-identical; a case-only difference falls through.
  if (v4aRenamePathKey(srcFull) === v4aRenamePathKey(destFull) && srcFull === destFull) {
    return `apply_patch: V4A rename source and destination are the same path (${normalizeOutputPath(section.path)})`;
  }
  const caseOnlyRename = v4aRenamePathKey(srcFull) === v4aRenamePathKey(destFull) && srcFull !== destFull;
  const destKey = v4aRenamePathKey(destFull);
  if (seenDestKeys.has(destKey)) {
    return `apply_patch: duplicate V4A rename destination ${normalizeOutputPath(section.movePath)}`;
  }
  seenDestKeys.add(destKey);
  try {
    const st = lstatSync(srcFull);
    if (isSpecialFileStat(st)) {
      return v4aSpecialFileStatMessage(section.path);
    }
    if (!st.isFile()) {
      return `apply_patch: V4A rename source is not a regular file: ${normalizeOutputPath(section.path)}`;
    }
  } catch (err) {
    return `apply_patch: V4A rename source missing or unreadable: ${normalizeOutputPath(section.path)} (${err?.code || err?.message || String(err)})`;
  }
  try {
    const destSt = lstatSync(destFull);
    if (isSpecialFileStat(destSt)) {
      return v4aSpecialFileStatMessage(section.movePath);
    }
    if (destSt.isDirectory()) {
      return `apply_patch: V4A rename destination is a directory: ${normalizeOutputPath(section.movePath)}`;
    }
    if (!destSt.isFile()) {
      return `apply_patch: V4A rename destination is not a regular file: ${normalizeOutputPath(section.movePath)}`;
    }
    // Destination already exists. On a case-insensitive fs a case-only rename
    // (foo.js -> Foo.js) resolves dest to the SAME physical file as src — that
    // is the intended re-case, not a clobber, so allow it. Confirm via realpath
    // (canonical path collapses case) so the guard can't false-reject. Any
    // other existing destination would be clobbered by atomicWrite; refuse.
    if (!caseOnlyRename && !renameTargetsSamePhysicalFile(srcFull, destFull)) {
      return `apply_patch: V4A rename destination already exists: ${normalizeOutputPath(section.movePath)}; delete it first or choose a new name`;
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      return `apply_patch: V4A rename destination unreadable: ${normalizeOutputPath(section.movePath)} (${err?.code || err?.message || String(err)})`;
    }
  }
  if (!section.hunks?.length) {
    return `apply_patch: V4A rename for ${normalizeOutputPath(section.path)} has no update hunks`;
  }
  return null;
}

async function applyV4ARenameSection(section, basePath, options = {}) {
  const srcFull = resolveV4AEntryPath(basePath, section.path);
  const destFull = resolveV4AEntryPath(basePath, section.movePath);
  // Case-only rename on a case-insensitive fs: src and dest are the SAME
  // physical file. atomicWrite(destFull) rewrites (and re-cases) it; the
  // source unlink below would then delete the just-written file, so skip it.
  const caseOnlySameFile =
    (v4aRenamePathKey(srcFull) === v4aRenamePathKey(destFull) && srcFull !== destFull)
    || renameTargetsSamePhysicalFile(srcFull, destFull);
  const displaySrc = normalizeOutputPath(section.path);
  const displayDest = normalizeOutputPath(section.movePath);
  let sourceLines;
  try {
    sourceLines = v4aConversionSourceLines(srcFull, options.linesCache || new Map());
  } catch (err) {
    throw new Error(`apply_patch: V4A rename source unreadable: ${displaySrc} (${err?.code || err?.message || String(err)})`);
  }
  let updatedLines;
  try {
    updatedLines = applyV4AHunksToLines(sourceLines, section.hunks, options);
  } catch (err) {
    throw err;
  }
  const newContent = joinTextLinesForPatch(updatedLines);
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      displayPath: displayDest,
      linesChanged: section.hunks.reduce((n, h) => n + (h.lines?.length || 0), 0),
      srcFull,
      destFull,
    };
  }
  const originalContent = readFileSync(srcFull);
  let destBefore = null;
  try {
    destBefore = readFileSync(destFull);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  mkdirSync(pathDirname(destFull), { recursive: true });
  try {
    await atomicWrite(destFull, newContent, { sessionId: options.readStateScope });
    if (!caseOnlySameFile) await unlink(srcFull);
  } catch (err) {
    try {
      if (destBefore === null) {
        try { await unlink(destFull); } catch {}
      } else {
        await atomicWrite(destFull, destBefore, { sessionId: options.readStateScope });
      }
    } catch {}
    if (!caseOnlySameFile) {
      try {
        await atomicWrite(srcFull, originalContent, { sessionId: options.readStateScope });
      } catch {}
    }
    throw new Error(`apply_patch: V4A rename failed for ${displaySrc} → ${displayDest} (${err?.message || String(err)})`);
  }
  invalidateBuiltinResultCache([srcFull, destFull]);
  markCodeGraphDirtyPaths([srcFull, destFull]);
  clearReadSnapshotForPath(srcFull, options.readStateScope);
  clearReadSnapshotForPath(destFull, options.readStateScope);
  return {
    ok: true,
    displayPath: displayDest,
    fromPath: displaySrc,
    linesChanged: section.hunks.reduce((n, h) => n + (h.lines?.length || 0), 0),
    srcFull,
    destFull,
  };
}

export function formatV4ARenameSuccessLines(results) {
  return (results || [])
    .filter((r) => r?.ok && !r.skipped)
    .map((r) => `OK ${r.displayPath} (renamed from ${r.fromPath}, ~${r.linesChanged} lines touched, engine=v4a-rename)`);
}

export async function planV4ARenameSections(sections, basePath) {
  const renameSections = (sections || []).filter(isV4ARenameSection);
  const remainingSections = (sections || []).filter((s) => !isV4ARenameSection(s));
  if (renameSections.length === 0) {
    return { renameSections: [], remainingSections };
  }
  if (renameSections.length > 1) {
    throw new Error('apply_patch: only one V4A rename (*** Move to:) per patch is supported; split into separate patches.');
  }
  if (remainingSections.length > 0) {
    throw new Error('apply_patch: V4A rename cannot be combined with other add/update/delete sections in the same patch; apply file edits in a separate patch first.');
  }
  await assertPathReachable(basePath);
  const renameReachPaths = renameSections.flatMap((section) => [
    resolveV4AEntryPath(basePath, section.path),
    resolveV4AEntryPath(basePath, section.movePath),
  ]);
  await assertPathsReachable(renameReachPaths);
  const seenDestKeys = new Set();
  for (const section of renameSections) {
    const errText = validateV4ARenameSection(section, basePath, seenDestKeys);
    if (errText) throw new Error(errText);
  }
  return {
    renameSections,
    remainingSections,
  };
}

export async function applyV4ARenameSections(renameSections, basePath, options = {}) {
  const linesCache = new Map();
  const results = [];
  for (const section of renameSections || []) {
    results.push(await applyV4ARenameSection(section, basePath, { ...options, linesCache }));
  }
  return results;
}

export function convertUnifiedBareV4AToUnifiedPatch(patchStr, basePath, options = {}) {
  return convertV4ASectionsToUnifiedPatch(parseUnifiedBareV4APatch(patchStr), basePath, options);
}

export function convertUnifiedCountedToUnifiedPatchViaV4A(patchStr, basePath, options = {}) {
  return convertV4ASectionsToUnifiedPatch(parseUnifiedCountedAsV4APatch(patchStr), basePath, options);
}

function readRawBufForV4AConversion(fullPath) {
  const st = lstatV4APatchTarget(fullPath, fullPath);
  const cached = rawContentCacheGet(fullPath, st);
  if (cached) return cached;
  const rawBuf = readFileSync(fullPath);
  const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
  rawContentCacheSet(fullPath, st, buf);
  return buf;
}

// win32 filesystems are case-insensitive, so `Foo` and `foo` are the same
// file: the V4A source-line cache MUST key on this normalized form at every
// get/set, otherwise a mixed-case duplicate section refreshed under one
// casing is missed under another and converts against stale/original lines.
export function v4aLinesCacheKey(fullPath) {
  return process.platform === 'win32' ? String(fullPath).toLowerCase() : String(fullPath);
}

function v4aConversionSourceLines(fullPath, linesCache) {
  const cacheKey = v4aLinesCacheKey(fullPath);
  if (linesCache.has(cacheKey)) return linesCache.get(cacheKey);
  const lines = splitTextLinesForPatch(readRawBufForV4AConversion(fullPath).toString('utf-8'));
  linesCache.set(cacheKey, lines);
  return lines;
}

// options.rejectPartial (default true) — see original patch.mjs commentary.
export async function convertV4ASectionsToUnifiedPatch(sections, basePath, options = {}) {
  {
    const reachPaths = [];
    const _seenReach = new Set();
    for (const s of (sections || [])) {
      if (!s || s.kind === 'add' || typeof s.path !== 'string' || !s.path) continue;
      const fp = resolveV4AEntryPath(basePath, s.path);
      if (_seenReach.has(fp)) continue;
      _seenReach.add(fp);
      reachPaths.push(fp);
    }
    await assertPathsReachable(reachPaths);
  }
  const rejectPartial = options.rejectPartial !== false;
  const rejectedHunks = Array.isArray(options.rejectedHunks) ? options.rejectedHunks : null;
  const fuzzy = options.fuzzy !== false;
  const out = [];
  const v4aLinesCache = new Map();
  // Paths that appear as update targets more than once: their duplicate
  // sections must be converted against the PRIOR section's result so the
  // emitted unified hunks line up for sequential (wave) application. We
  // refresh v4aLinesCache after each such section below.
  const dupUpdatePaths = new Set();
  {
    const seenUpd = new Set();
    for (const s of sections || []) {
      if (!s || s.kind === 'add' || s.kind === 'delete' || typeof s.path !== 'string' || !s.path) continue;
      const fp = resolveV4AEntryPath(basePath, s.path);
      const key = v4aLinesCacheKey(fp);
      if (seenUpd.has(key)) dupUpdatePaths.add(key); else seenUpd.add(key);
    }
  }
  for (const section of sections) {
    const displayPath = section.path.replace(/\\/g, '/');
    if (section.kind === 'add') {
      out.push('--- /dev/null');
      out.push(`+++ b/${displayPath}`);
      out.push(`@@ -0,0 +1,${section.lines.length} @@`);
      for (const line of section.lines) out.push(`+${line}`);
      continue;
    }
    if (section.kind === 'delete') {
      const fullPath = resolveV4AEntryPath(basePath, section.path);
      let fileLines = [];
      try {
        const _delRaw = readFileSync(fullPath);
        if (decodeValidUtf8OrNull(_delRaw) !== null) {
          fileLines = v4aConversionSourceLines(fullPath, v4aLinesCache);
        }
      } catch {
        fileLines = [];
      }
      out.push(`--- a/${displayPath}`);
      out.push('+++ /dev/null');
      if (fileLines.length > 0) {
        out.push(`@@ -1,${fileLines.length} +0,0 @@`);
        for (const line of fileLines) out.push(`-${line}`);
      }
      continue;
    }

    const fullPath = resolveV4AEntryPath(basePath, section.path);
    let sourceLines;
    try {
      sourceLines = v4aConversionSourceLines(fullPath, v4aLinesCache);
    } catch (err) {
      throw new Error(`V4A update target unreadable: ${section.path} (${err?.code || err?.message || String(err)}).`);
    }
    const sectionHunks = [];
    const orderedHunks = orderV4AHunksByFilePosition(sourceLines, section.hunks, fuzzy);
    let nextSearchLine = 0;
    for (const hunk of orderedHunks) {
      const stats = v4AHunkLineStats(hunk);
      if (stats.oldCount === 0 && stats.newCount === 0) continue;
      const loc = resolveV4AHunkPosition(sourceLines, hunk, nextSearchLine, { fuzzy });
      if (loc.skip) continue;
      if (loc.error) {
        const msg = `${loc.error.replace(/^V4A hunk /, `V4A hunk ${section.path}: `)}`;
        if (rejectPartial) throw new Error(msg);
        if (rejectedHunks) rejectedHunks.push({ file: section.path, hunk, reason: msg });
        continue;
      }
      const oldStart = stats.oldCount === 0 ? loc.oldStartIdx : loc.oldStartIdx + 1;
      const newStart = oldStart;
      const tail = (hunk.anchors || []).filter(Boolean).join(' ');
      const oldCount = stats.oldCount === 0 ? 0 : loc.matchLen;
      const newCount = stats.newCount - (loc.trimmedTrailingNew || 0);
      sectionHunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${tail ? ` ${tail}` : ''}`);
      let dropOldAt = -1;
      let dropNewAt = -1;
      if (loc.trimmedTrailing) {
        for (let i = hunk.lines.length - 1; i >= 0; i--) {
          const ln = hunk.lines[i];
          if (isV4AEndOfFileMarker(ln)) continue;
          const p = ln[0];
          if (dropOldAt < 0 && (p === ' ' || p === '-')) dropOldAt = i;
          if (dropNewAt < 0 && loc.trimmedTrailingNew && (p === ' ' || p === '+')) dropNewAt = i;
          if (dropOldAt >= 0 && (!loc.trimmedTrailingNew || dropNewAt >= 0)) break;
        }
      }
      let srcIdx = loc.oldStartIdx;
      const srcEnd = loc.oldStartIdx + loc.matchLen;
      for (let i = 0; i < hunk.lines.length; i++) {
        const line = hunk.lines[i];
        if (isV4AEndOfFileMarker(line)) continue;
        const prefix = line[0];
        if (prefix === ' ' || prefix === '-') {
          if (i === dropOldAt || i === dropNewAt) continue;
          if (srcIdx < srcEnd && srcIdx < sourceLines.length) {
            sectionHunks.push(prefix + sourceLines[srcIdx]);
          } else {
            sectionHunks.push(line);
          }
          srcIdx++;
        } else {
          if (i === dropNewAt) continue;
          sectionHunks.push(line);
        }
      }
      nextSearchLine = loc.nextSearchLine;
    }
    if (sectionHunks.length > 0) {
      out.push(`--- a/${displayPath}`);
      out.push(`+++ b/${displayPath}`);
      for (const line of sectionHunks) out.push(line);
    }
    // If this path is edited again later, the next section must resolve
    // against this section's applied result, not the original file — apply
    // these hunks to the cached lines so duplicate V4A blocks convert to a
    // sequentially-appliable unified patch. Best-effort: on any mismatch we
    // keep the original cache and let native wave application surface it.
    if (dupUpdatePaths.has(v4aLinesCacheKey(fullPath))) {
      try {
        v4aLinesCache.set(v4aLinesCacheKey(fullPath), applyV4AHunksToLines(sourceLines, section.hunks, { fuzzy }));
      } catch { /* leave original cached lines */ }
    }
  }
  return out.join('\n') + '\n';
}
