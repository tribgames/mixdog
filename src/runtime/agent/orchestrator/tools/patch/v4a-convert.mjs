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
  cloneTextLinesForPatch,
  spliceTextLinesForPatch,
  joinTextLinesForPatch,
  terminatorsForUnifiedOps,
  localTerminatorForWindow,
  decodeValidUtf8OrNull,
  decodePatchTargetBuffer,
  encodePatchTargetContent,
  assertSafeReplacementPlan,
} from './matcher.mjs';
import {
  v4AHunkLineStats,
  numericAnchorLineHint,
  findAnchorLine,
  noteV4AHunkAmbiguity,
  noteV4AEofSignalIgnored,
  formatV4AHunkLocator,
  formatV4AAnchorMissHint,
  formatV4AContextMissHint,
  formatV4AEnvelopeMarkerError,
  v4aEnvelopeMarkerInHunk,
} from './v4a-anchors.mjs';
// Facade re-export: pre-split importers reach the notice drain through this
// module.
export { drainV4AAmbiguityNotices } from './v4a-anchors.mjs';
import {
  findContextTolerantWindow,
  findEditDistanceWindow,
  findOuterContextTrimmedWindow,
  findIndentNormalizedWindow,
  restoreOpcodePrefixWindow,
  restorePlusAsContext,
  remapNewLineIndents,
  uniqueExactSequenceStart,
} from './v4a-windows.mjs';

// The peeled-`+` window may only REFINE an already-resolved match, never
// relocate it. Containment is half-open: `start + length` is the index one
// PAST the window — a different location, not a refinement — so a genuine
// addition whose text resembles an existing `+…` line cannot drag the hunk
// there (which silently turned the edit into a no-op).
export function plusWindowCoversMatch(windowStart, windowLength, oldStartIdx) {
  if (oldStartIdx < 0) return true;
  return oldStartIdx >= windowStart && oldStartIdx < windowStart + windowLength;
}

function emitUnifiedReplacement(oldLines, newLines) {
  const old = Array.isArray(oldLines) ? oldLines : [];
  const neu = Array.isArray(newLines) ? newLines : [];
  const body = [];
  let a = 0;
  let b = 0;
  while (a < old.length && b < neu.length && old[a] === neu[b]) {
    body.push(` ${old[a]}`);
    a += 1;
    b += 1;
  }
  let oldEnd = old.length - 1;
  let newEnd = neu.length - 1;
  while (oldEnd >= a && newEnd >= b && old[oldEnd] === neu[newEnd]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  for (let i = a; i <= oldEnd; i++) body.push(`-${old[i]}`);
  for (let i = b; i <= newEnd; i++) body.push(`+${neu[i]}`);
  for (let i = oldEnd + 1; i < old.length; i++) body.push(` ${old[i]}`);
  return body;
}

// V4A parity (compute_replacements): a chunk
// with no old lines is a pure addition and is inserted at end-of-file — before
// the trailing empty line when the file ends with a blank line — never at the
// current anchor cursor.
function eofInsertionIndex(sourceLines) {
  const len = (sourceLines || []).length;
  return len > 0 && sourceLines[len - 1] === '' ? len - 1 : len;
}

function resolveV4AHunkPosition(sourceLines, hunk, nextSearchLine, options = {}) {
  const stats = v4AHunkLineStats(hunk);
  if (stats.oldCount === 0 && stats.newCount === 0) return { skip: true };
  const fuzzy = options.fuzzy !== false;
  const eof = hunk?.isEndOfFile === true;
  let anchorLine = findAnchorLine(sourceLines, hunk.anchors, nextSearchLine);
  if (anchorLine < 0) {
    // A semantic/synthetic @@ label (for example Class.method) can be absent
    // even though the hunk's current old-side body is byte-exact. Rebase from
    // that body only when it has exactly one whole-file location; duplicate or
    // stale bodies retain the hard anchor miss instead of choosing a target.
    const uniqueBody = fuzzy ? uniqueExactSequenceStart(sourceLines, stats.oldLines) : -1;
    if (uniqueBody < 0) {
      const msg = `V4A hunk anchor not found: ${formatV4AHunkLocator(hunk)};${formatV4AAnchorMissHint(sourceLines, hunk)}`;
      return { error: msg };
    }
    anchorLine = uniqueBody + 1;
  }
  let oldLinesPattern = stats.oldLines;
  let newLinesPattern = stats.newLines;
  let oldStartIdx;
  let trimmedTrailing = 0;
  let trimmedTrailingNew = 0;
  let trimmedLeadingContext = 0;
  let trimmedTrailingContext = 0;
  if (stats.oldCount === 0) {
    oldStartIdx = eofInsertionIndex(sourceLines);
  } else {
    const searchFrom = Math.max(0, anchorLine - 1);
    oldStartIdx = findLineSequence(
      sourceLines,
      oldLinesPattern,
      searchFrom,
      searchFrom,
      { fuzzy, eof },
    );
    // V4A parity (compute_replacements): when the first seek fails and the
    // pattern's last line is the empty string that stands in for the region's
    // terminating newline, retry without it. The retry runs for EVERY
    // chunk, not only `*** End of File` ones, so a hunk whose trailing blank
    // context line sits at end-of-file resolves instead of reporting a context
    // miss. When the retry empties the pattern (the old side was that single
    // blank line) the seek returns the cursor, i.e. the hunk becomes a
    // zero-length insertion at the anchor cursor; `anchorLine` IS that cursor
    // (`line_index`), so use it directly instead of the seek's
    // preferred-line fallback.
    if (oldStartIdx < 0 && oldLinesPattern.length > 0 && oldLinesPattern[oldLinesPattern.length - 1] === '') {
      oldLinesPattern = oldLinesPattern.slice(0, -1);
      trimmedTrailing = 1;
      if (newLinesPattern.length > 0 && newLinesPattern[newLinesPattern.length - 1] === '') {
        newLinesPattern = newLinesPattern.slice(0, -1);
        trimmedTrailingNew = 1;
      }
      oldStartIdx = oldLinesPattern.length === 0
        ? anchorLine
        : findLineSequence(
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
  // `*** End of File` is a HINT, not a hard constraint. When the EOF-anchored
  // seek misses, retry the pattern as an ordinary in-file search: a mid-file
  // hunk that carried the marker by mistake used to fail with a "context not
  // found" that pointed at its own byte-perfect context, costing a whole retry
  // turn. Once that happens the EOF signal is exhausted, so every recovery
  // tier below treats the hunk as unmarked.
  let eofSignalIgnored = false;
  if (oldStartIdx < 0 && eof && oldLinesPattern.length > 0) {
    const relaxedFrom = Math.max(0, anchorLine - 1);
    const relaxed = findLineSequence(sourceLines, oldLinesPattern, relaxedFrom, relaxedFrom, { fuzzy, eof: false });
    if (relaxed >= 0) {
      oldStartIdx = relaxed;
      eofSignalIgnored = true;
    }
  }
  // Numeric-anchor position retry: a bare line-number anchor whose digits
  // also occur as TEXT in some line content-matches that line instead, and a
  // cursor set past the hunk's real position makes the forward-only body seek
  // miss byte-perfect context. The declared 1-based line is a positional
  // claim, so retry the exact body seek from it (backed off by the hunk's
  // leading context, for anchors naming the first changed line) before any
  // fuzzy tier can resolve elsewhere.
  if (oldStartIdx < 0 && oldLinesPattern.length > 0) {
    const lineHint = numericAnchorLineHint(hunk.anchors, sourceLines.length);
    if (lineHint !== null) {
      let leading = 0;
      for (const tag of stats.oldTags || []) {
        if (tag !== ' ') break;
        leading += 1;
      }
      const from = Math.max(0, lineHint - 1 - leading);
      const at = findLineSequence(sourceLines, oldLinesPattern, from, from, { fuzzy, eof: false });
      if (at >= 0) {
        oldStartIdx = at;
        if (eof) eofSignalIgnored = true;
      }
    }
  }
  if (oldStartIdx < 0 && fuzzy && oldLinesPattern.length > 0) {
    const restored = restoreOpcodePrefixWindow(sourceLines, hunk);
    if (restored) {
      oldStartIdx = restored.start;
      oldLinesPattern = restored.oldLines;
      newLinesPattern = restored.newLines;
      if (eof) eofSignalIgnored = true;
    }
  }
  // Recovery tier. A `+ TODO` line that IS a file line must be peeled back to
  // context even when the rest of the hunk already matched exactly — but the
  // peeled window may then only REFINE that match, never relocate it: a
  // genuine addition whose text resembles an existing `+…` line elsewhere used
  // to drag the hunk to that other place and silently no-op the edit.
  if (fuzzy) {
    const plusRestored = restorePlusAsContext(sourceLines, hunk);
    const plusCoversMatch = plusRestored
      && plusWindowCoversMatch(plusRestored.start, plusRestored.oldLines.length, oldStartIdx);
    if (plusRestored && plusCoversMatch) {
      oldStartIdx = plusRestored.start;
      oldLinesPattern = plusRestored.oldLines;
      newLinesPattern = plusRestored.newLines;
      if (eof) eofSignalIgnored = true;
    }
  }
  if (oldStartIdx < 0 && fuzzy && oldLinesPattern.length > 0) {
    const indent = findIndentNormalizedWindow(sourceLines, oldLinesPattern);
    if (indent) {
      const remapped = new Map();
      let ambiguous = false;
      for (let k = 0; k < oldLinesPattern.length; k++) {
        const pat = oldLinesPattern[k];
        const src = sourceLines[indent.start + k];
        if (remapped.has(pat) && remapped.get(pat) !== src) { ambiguous = true; break; }
        remapped.set(pat, src);
      }
      if (!ambiguous) {
        newLinesPattern = newLinesPattern.map((line) => remapped.get(line) ?? line);
        oldLinesPattern = oldLinesPattern.map((_, k) => sourceLines[indent.start + k]);
        oldStartIdx = indent.start;
        if (eof) eofSignalIgnored = true;
      }
    }
  }
  if (oldStartIdx < 0 && fuzzy && oldLinesPattern.length > 0) {
    if (eof) eofSignalIgnored = true;
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
  // Context-tolerance tier: see findContextTolerantWindow. Tolerated context
  // lines are remapped to the file's actual lines on BOTH the old and new
  // side (same shape as the escape-equiv remap above); remapping bails on any
  // string ambiguity so an unrelated occurrence can never be rewritten.
  if (oldStartIdx < 0 && fuzzy && oldLinesPattern.length >= 3) {
    const tolTags = trimmedTrailing ? stats.oldTags.slice(0, -1) : stats.oldTags;
    const tol = findContextTolerantWindow(sourceLines, oldLinesPattern, tolTags);
    if (tol) {
      const remapped = new Map();
      let ambiguous = false;
      for (let k = 0; k < oldLinesPattern.length; k++) {
        const pat = oldLinesPattern[k];
        const src = sourceLines[tol.start + k];
        if (src === pat) continue;
        if (
          oldLinesPattern.filter((l) => l === pat).length > 1
          || (remapped.has(pat) && remapped.get(pat) !== src)
        ) { ambiguous = true; break; }
        remapped.set(pat, src);
      }
      if (!ambiguous) {
        newLinesPattern = newLinesPattern.map((l) => remapped.get(l) ?? l);
        oldLinesPattern = oldLinesPattern.map((_, k) => sourceLines[tol.start + k]);
        oldStartIdx = tol.start;
      }
    }
  }
  // A stray copied line outside the edit should not cost a failed tool turn.
  // This fallback is deliberately narrower than the context-tolerance tier:
  // fuzzy mode only, non-EOF, no newline-sentinel interaction, deletion hunks
  // only, byte-exact remaining block, and one unique whole-file location.
  if (oldStartIdx < 0 && fuzzy && trimmedTrailing === 0) {
    const trimmed = findOuterContextTrimmedWindow(sourceLines, hunk, stats);
    if (trimmed) {
      oldStartIdx = trimmed.start;
      oldLinesPattern = trimmed.oldLines;
      newLinesPattern = trimmed.newLines;
      trimmedLeadingContext = trimmed.leading;
      trimmedTrailingContext = trimmed.trailing;
    }
  }
  // Edit-distance tier: same remap contract as the context-tolerance tier —
  // the window's on-disk lines replace the patch's near-miss lines on BOTH
  // sides, and any string ambiguity abandons the rescue.
  if (oldStartIdx < 0 && fuzzy && oldLinesPattern.length >= 3) {
    const near = findEditDistanceWindow(sourceLines, oldLinesPattern);
    if (near) {
      const remapped = new Map();
      let ambiguous = false;
      for (let k = 0; k < oldLinesPattern.length; k++) {
        const pat = oldLinesPattern[k];
        const src = sourceLines[near.start + k];
        if (src === pat) continue;
        if (
          oldLinesPattern.filter((l) => l === pat).length > 1
          || (remapped.has(pat) && remapped.get(pat) !== src)
        ) { ambiguous = true; break; }
        remapped.set(pat, src);
      }
      if (!ambiguous) {
        newLinesPattern = newLinesPattern.map((l) => remapped.get(l) ?? l);
        oldLinesPattern = oldLinesPattern.map((_, k) => sourceLines[near.start + k]);
        oldStartIdx = near.start;
      }
    }
  }
  // Fuzzy locate can accept indent/trim-equivalent lines, then emit the
  // patch's context bytes. Remap to the file so native apply stays exact.
  if (oldStartIdx >= 0 && oldLinesPattern.length > 0) {
    const sourceSlice = sourceLines.slice(oldStartIdx, oldStartIdx + oldLinesPattern.length);
    newLinesPattern = remapNewLineIndents(oldLinesPattern, sourceSlice, newLinesPattern);
    const remapped = new Map();
    let ambiguous = false;
    for (let k = 0; k < oldLinesPattern.length; k++) {
      const pat = oldLinesPattern[k];
      const src = sourceLines[oldStartIdx + k];
      if (pat === src) continue;
      if (remapped.has(pat) && remapped.get(pat) !== src) { ambiguous = true; break; }
      remapped.set(pat, src);
    }
    if (!ambiguous && remapped.size > 0) {
      newLinesPattern = newLinesPattern.map((line) => remapped.get(line) ?? line);
      oldLinesPattern = oldLinesPattern.map((_, k) => sourceLines[oldStartIdx + k]);
    }
  }
  if (oldStartIdx < 0) {
    // Envelope damage is a patch-text defect, not a context miss: name it
    // instead of pointing at an unrelated region of the file.
    const marker = v4aEnvelopeMarkerInHunk(sourceLines, stats.oldLines);
    if (marker) return { error: formatV4AEnvelopeMarkerError(marker) };
    const msg = `V4A hunk context not found: ${formatV4AHunkLocator(hunk)};${formatV4AContextMissHint(sourceLines, stats, anchorLine)}`;
    return { error: msg };
  }
  const matchLen = stats.oldCount === 0 ? 0 : oldLinesPattern.length;
  return {
    oldStartIdx,
    matchLen,
    newLines: newLinesPattern,
    // V4A parity: a zero-length replacement never advances the cursor
    // (compute_replacements `continue`s on the pure-addition branch), so a
    // following hunk can still resolve against lines before the insertion
    // point instead of being pushed past end-of-file.
    nextSearchLine: matchLen === 0 ? Math.max(0, nextSearchLine || 0) : oldStartIdx + matchLen,
    trimmedTrailing,
    trimmedTrailingNew,
    trimmedLeadingContext,
    trimmedTrailingContext,
    // Ambiguity-notice inputs: the pattern actually matched, and whether the
    // hunk carried an @@ anchor (an anchored hunk is never ambiguous).
    pattern: oldLinesPattern,
    anchored: (hunk.anchors || []).filter(Boolean).length > 0,
    // True when the hunk's `*** End of File` marker had to be relaxed to
    // locate it (drives the non-fatal notice on the success output).
    eofSignalIgnored,
  };
}

// Op sequence of a V4A hunk, but ONLY when it still describes the window the
// resolver actually matched. Recovery tiers can restructure that window (peeled
// opcodes, trimmed outer context); there the splice falls back to its
// conservative same-offset identity rule rather than guessing a mapping.
function v4aOpsForResolvedHunk(hunk, loc) {
  const ops = [];
  for (const raw of hunk?.lines || []) {
    if (typeof raw !== 'string' || raw.length === 0 || isV4AEndOfFileMarker(raw)) continue;
    const tag = raw[0];
    const line = raw.slice(1);
    if (tag === '-') ops.push({ op: 'delete', line });
    else if (tag === '+') ops.push({ op: 'add', line });
    else ops.push({ op: 'context', line: tag === ' ' ? line : raw });
  }
  const oldCount = ops.reduce((n, entry) => n + (entry.op === 'add' ? 0 : 1), 0);
  const newCount = ops.reduce((n, entry) => n + (entry.op === 'delete' ? 0 : 1), 0);
  if (oldCount !== loc.matchLen) return null;
  if (newCount !== (loc.newLines?.length || 0)) return null;
  return ops;
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
      ops: v4aOpsForResolvedHunk(hunk, loc),
      oldStartIdx: loc.oldStartIdx,
      oldLen: loc.matchLen,
      newLines: loc.newLines,
    });
    nextSearchLine = loc.nextSearchLine;
  }
  // V4A parity (compute_replacements sorts by start index before
  // apply_replacements walks them in reverse): descending application is only
  // position-safe when the list is ordered by start index. Resolution order is
  // normally already ascending; the sort is stable, so equal starts keep their
  // resolution order.
  replacements.sort((a, b) => a.oldStartIdx - b.oldStartIdx);
  assertSafeReplacementPlan(replacements.map((rep) => ({ start: rep.oldStartIdx, oldLen: rep.oldLen })));
  for (const rep of replacements.reverse()) {
    const oldTerms = Array.isArray(lines.terminators)
      ? lines.terminators.slice(rep.oldStartIdx, rep.oldStartIdx + rep.oldLen)
      : [];
    const newTerms = rep.ops
      ? terminatorsForUnifiedOps(
        rep.ops,
        oldTerms,
        localTerminatorForWindow(lines, rep.oldStartIdx, rep.oldLen),
      )
      : null;
    spliceTextLinesForPatch(lines, rep.oldStartIdx, rep.oldLen, rep.newLines, newTerms);
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

export function validateV4ARenameSection(section, basePath, seenDestKeys) {
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

export async function applyV4ARenameSection(section, basePath, options = {}) {
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
  const newContent = encodePatchTargetContent(
    joinTextLinesForPatch(updatedLines),
    sourceLines.encoding,
  );
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
  await assertPathReachable(basePath);
  const renameReachPaths = renameSections.flatMap((section) => [
    resolveV4AEntryPath(basePath, section.path),
    resolveV4AEntryPath(basePath, section.movePath),
  ]);
  await assertPathsReachable(renameReachPaths);
  // Renames coexist with add/update/delete sections and with each other, but
  // never on overlapping paths: renames apply BEFORE the non-rename waves, so
  // a shared target would silently reorder operations. Refuse overlaps and
  // duplicate sources up front.
  const remainingKeys = new Set(remainingSections.map(
    (section) => v4aRenamePathKey(resolveV4AEntryPath(basePath, section.path)),
  ));
  const seenDestKeys = new Set();
  const seenSrcKeys = new Set();
  for (const section of renameSections) {
    const srcKey = v4aRenamePathKey(resolveV4AEntryPath(basePath, section.path));
    const destKey = v4aRenamePathKey(resolveV4AEntryPath(basePath, section.movePath));
    if (seenSrcKeys.has(srcKey)) {
      throw new Error(`apply_patch: duplicate V4A rename source ${normalizeOutputPath(section.path)}`);
    }
    seenSrcKeys.add(srcKey);
    if (remainingKeys.has(srcKey) || remainingKeys.has(destKey)) {
      throw new Error(`apply_patch: V4A rename ${normalizeOutputPath(section.path)} → ${normalizeOutputPath(section.movePath)} touches a path another section edits; split into separate patches.`);
    }
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
function v4aLinesCacheKey(fullPath) {
  return process.platform === 'win32' ? String(fullPath).toLowerCase() : String(fullPath);
}

function v4aConversionSourceLines(fullPath, linesCache) {
  const cacheKey = v4aLinesCacheKey(fullPath);
  if (linesCache.has(cacheKey)) return linesCache.get(cacheKey);
  // BOM-driven decode + refusal for non-UTF-8/UTF-16 bytes: the rename path
  // rewrites the WHOLE file from these lines.
  const { text, enc } = decodePatchTargetBuffer(readRawBufForV4AConversion(fullPath), fullPath);
  const lines = splitTextLinesForPatch(text);
  lines.encoding = enc;
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
    // Resolved-position ordering for the emitted unified hunks: the unique-
    // verbatim fallback in findLineSequence can resolve a later-listed hunk
    // BEFORE an earlier one, and the native engine applies unified hunks with
    // a forward-only cursor — emission must therefore be sorted by resolved
    // start (stable on ties) instead of resolution order.
    const sectionHunkEntries = [];
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
      const tail = (hunk.anchors || []).filter(Boolean).join(' ');
      // Emit from the remapped old/new window, not the original hunk tags.
      // Recovery tiers (opcode-prefix restore, indent, outer-trim) may keep a
      // parsed '-' line as context; walking hunk.lines would still delete it.
      const oldLines = loc.matchLen === 0 ? [] : (loc.pattern || []);
      const newLines = loc.newLines || [];
      const bodyLines = emitUnifiedReplacement(oldLines, newLines);
      const emittedOld = oldLines.length;
      const emittedNew = newLines.length;
      // A zero-length old range is an insertion: its header start is the 0-based
      // insertion index (`-N,0` inserts after source line N), while a real
      // replacement starts at the 1-based first replaced line.
      const oldStart = emittedOld === 0 ? loc.oldStartIdx : loc.oldStartIdx + 1;
      sectionHunkEntries.push({
        start: loc.oldStartIdx,
        order: sectionHunkEntries.length,
        lines: [
          `@@ -${oldStart},${emittedOld} +${oldStart},${emittedNew} @@${tail ? ` ${tail}` : ''}`,
          ...bodyLines,
        ],
      });
      noteV4AHunkAmbiguity(displayPath, sourceLines, loc);
      noteV4AEofSignalIgnored(displayPath, loc);
      nextSearchLine = loc.nextSearchLine;
    }
    sectionHunkEntries.sort((a, b) => (a.start - b.start) || (a.order - b.order));
    for (const entry of sectionHunkEntries) sectionHunks.push(...entry.lines);
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
  return out.length > 0 ? `${out.join('\n')}\n` : '';
}
