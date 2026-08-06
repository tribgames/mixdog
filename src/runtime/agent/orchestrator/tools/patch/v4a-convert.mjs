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
  longestCommonSubstringLen,
  boundedEditDistance,
  EDIT_DISTANCE_ALLOWANCE_PER_LINE,
  splitTextLinesForPatch,
  firstMeaningfulPatchLine,
  nearestPatchLineHint,
  nearestPatchLineMatch,
  formatPatchSourceExcerpt,
  compactPatchPreviewLine,
  decodeValidUtf8OrNull,
  assertSafeReplacementPlan,
} from './matcher.mjs';

function v4AHunkLineStats(hunk) {
  let oldCount = 0;
  let newCount = 0;
  const oldLines = [];
  const newLines = [];
  const oldTags = [];
  for (const raw of hunk.lines || []) {
    if (!raw) continue;
    const tag = raw[0];
    const body = raw.slice(1);
    if (tag === ' ') {
      oldCount++;
      newCount++;
      oldLines.push(body);
      newLines.push(body);
      oldTags.push(' ');
    } else if (tag === '-') {
      oldCount++;
      oldLines.push(body);
      oldTags.push('-');
    } else if (tag === '+') {
      newCount++;
      newLines.push(body);
    }
  }
  return { oldCount, newCount, oldLines, newLines, oldTags };
}

// V4A parity: typographic punctuation is normalised to
// ASCII on the most permissive matching pass, so a patch authored in plain
// ASCII still locates context in a file containing smart quotes / en dashes.
function normalizeAnchorText(value) {
  return String(value).trim().replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018-\u201B]/g, "'")
    .replace(/[\u201C-\u201F]/g, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

// The anchor seek now falls through the SAME decreasing-strictness passes the
// body seek uses (exact -> rstrip -> trim -> normalised).
// An anchor that is present but differs by trailing whitespace or a smart
// quote must not report as "anchor not found". Exact stays first, so every
// currently-resolving patch keeps its existing position.
function seekAnchor(lines, anchor, cursor) {
  const passes = [
    (line) => line.includes(anchor),
    (line) => line.trimEnd().includes(anchor.trimEnd()),
    (line) => line.trim().includes(anchor.trim()),
    (line) => normalizeAnchorText(line).includes(normalizeAnchorText(anchor)),
  ];
  for (const matches of passes) {
    const found = lines.findIndex((line, idx) => idx >= cursor && matches(line));
    if (found >= 0) return found;
  }
  return -1;
}

function seekAnchorChain(lines, anchors, fromLine) {
  let cursor = Math.max(0, fromLine || 0);
  for (const anchor of anchors) {
    const found = seekAnchor(lines, anchor, cursor);
    if (found === -1) return -1;
    cursor = found + 1;
  }
  return cursor;
}

function countAnchorHits(lines, anchor, cap = 2) {
  let hits = 0;
  for (const line of lines) {
    if (line.includes(anchor)) {
      hits += 1;
      if (hits >= cap) break;
    }
  }
  return hits;
}

function findAnchorLine(lines, anchors, fromLine) {
  const list = (anchors || []).map((anchor) => String(anchor || '').trim()).filter(Boolean);
  if (list.length === 0) return Math.max(0, fromLine || 0);
  const forward = seekAnchorChain(lines, list, fromLine);
  if (forward >= 0) return forward;
  // Hunks listed out of file order leave the cursor PAST an anchor that is
  // still present (orderV4AHunksByFilePosition re-sorts most such input; this
  // covers what its keying cannot resolve). Retrying from the top is only
  // safe when every anchor occurs exactly once in the file — the position is
  // then unambiguous, so no other occurrence can be selected instead.
  if ((fromLine || 0) > 0 && list.every((anchor) => countAnchorHits(lines, anchor) === 1)) {
    return seekAnchorChain(lines, list, 0);
  }
  return -1;
}

// Non-fatal ambiguity channel. V4A applies the FIRST
// context match after the previous hunk, with no uniqueness check — that is
// the spec, so a duplicate context stays a success. It is reported on the
// result instead, so a silently misplaced edit is visible in the same turn.
const _v4aAmbiguityNotices = new Set();
const V4A_AMBIGUITY_NOTICE_CAP = 4;

function countExactWindows(lines, pattern, cap = 2) {
  if (!Array.isArray(pattern) || pattern.length === 0) return 0;
  let hits = 0;
  outer: for (let i = 0; i + pattern.length <= lines.length; i++) {
    for (let k = 0; k < pattern.length; k++) {
      if (lines[i + k] !== pattern[k]) continue outer;
    }
    hits += 1;
    if (hits >= cap) break;
  }
  return hits;
}

function noteV4AHunkAmbiguity(displayPath, sourceLines, loc) {
  if (_v4aAmbiguityNotices.size >= V4A_AMBIGUITY_NOTICE_CAP) return;
  if (loc.anchored || !(loc.matchLen > 0)) return;
  if (countExactWindows(sourceLines, loc.pattern) < 2) return;
  _v4aAmbiguityNotices.add(
    `${displayPath}: hunk context matches more than one place; applied at line ${loc.oldStartIdx + 1} `
    + '(first match after the previous hunk). Add an @@ anchor to target a different one.',
  );
}

// `*** End of File` was relaxed to locate this hunk: report where it actually
// landed so a mid-file hunk that carried the marker by mistake is visible in
// the same turn instead of silently looking like an end-of-file edit.
function noteV4AEofSignalIgnored(displayPath, loc) {
  if (_v4aAmbiguityNotices.size >= V4A_AMBIGUITY_NOTICE_CAP) return;
  if (!loc?.eofSignalIgnored) return;
  _v4aAmbiguityNotices.add(
    `${displayPath}: hunk carried *** End of File but its context is at line ${loc.oldStartIdx + 1}, `
    + 'not the end of file; the marker was ignored. Drop it unless the hunk really ends the file.',
  );
}

export function drainV4AAmbiguityNotices() {
  if (_v4aAmbiguityNotices.size === 0) return [];
  const list = [..._v4aAmbiguityNotices];
  _v4aAmbiguityNotices.clear();
  return list;
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
  let centerIdx = -1;
  if (expected) {
    const nearest = nearestPatchLineHint(sourceLines, expected, anchorLine);
    parts.push(`expected first old line: ${JSON.stringify(compactPatchPreviewLine(expected))}`);
    if (nearest) parts.push(nearest);
    const divergence = firstV4ADivergenceHint(sourceLines, stats.oldLines, anchorLine);
    if (divergence) {
      parts.push(divergence.text);
      centerIdx = divergence.fileIdx;
    } else {
      const match = nearestPatchLineMatch(sourceLines, expected, anchorLine);
      if (match) centerIdx = match.index;
    }
  }
  if (centerIdx < 0 && Number.isFinite(anchorLine) && anchorLine >= 0) centerIdx = anchorLine;
  parts.push('use exact current context or a broader @@ anchor; no stubs.');
  const head = ` ${parts.join('; ')} Copy the context lines verbatim from the excerpt below — do not retype them from memory.`;
  return `${head}${formatPatchSourceExcerpt(sourceLines, centerIdx, (stats.oldLines || []).length)}`;
}

// When the FIRST old line does exist verbatim in the source, the real
// mismatch is some later line of the block — name it, with both sides
// JSON-escaped so invisible differences (real char vs literal \uXXXX
// escape, tabs, trailing spaces) become visible in the error. Returns the
// message plus the file index it points at, so the caller can centre the
// source excerpt on the true divergence instead of the anchor.
function firstV4ADivergenceHint(sourceLines, oldLines, anchorLine) {
  const lines = oldLines || [];
  const firstIdx = lines.findIndex((l) => String(l ?? '').trim().length > 0);
  if (firstIdx < 0) return null;
  const first = lines[firstIdx];
  const starts = [];
  for (let i = 0; i < sourceLines.length; i++) {
    if (sourceLines[i] === first) starts.push(i - firstIdx);
  }
  const pref = Number.isFinite(anchorLine) && anchorLine >= 0 ? anchorLine : 0;
  const start = starts.filter((s) => s >= 0)
    .sort((a, b) => Math.abs(a - pref) - Math.abs(b - pref) || a - b)[0];
  if (start === undefined) return null;
  for (let k = 0; k < lines.length; k++) {
    const exp = lines[k];
    const act = sourceLines[start + k];
    if (act !== exp) {
      const actText = act === undefined ? '(past EOF)' : JSON.stringify(compactPatchPreviewLine(act));
      return {
        text: `first divergent line: old[${k + 1}] expected ${JSON.stringify(compactPatchPreviewLine(exp))} vs file line ${start + k + 1} actual ${actText}`,
        fileIdx: start + k,
      };
    }
  }
  return null;
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

// V4A parity (compute_replacements): a chunk
// with no old lines is a pure addition and is inserted at end-of-file — before
// the trailing empty line when the file ends with a blank line — never at the
// current anchor cursor.
function eofInsertionIndex(sourceLines) {
  const len = (sourceLines || []).length;
  return len > 0 && sourceLines[len - 1] === '' ? len - 1 : len;
}

// Bounded context-tolerance tier (fuzzy, non-EOF, last resort before the
// context-miss error). Recovers the measured top remaining failure class —
// 1-2 nearby context lines drifted since the model last saw the file — under
// guards that make mis-application practically impossible:
//   - every '-' (deletion) line must match the file byte-exactly;
//   - only ' ' (context) lines may mismatch, at most 2, and each drifted
//     line must still resemble the file line (shared substring >= half);
//   - at least 2 exact non-blank matches must anchor the window;
//   - the qualifying window must be UNIQUE across the ENTIRE file;
//   - the caller REMAPS tolerated context to the file's on-disk lines, so a
//     drifted patch line never overwrites file content it did not target.
function findContextTolerantWindow(sourceLines, oldLines, oldTags) {
  const n = oldLines.length;
  if (n < 3 || !Array.isArray(oldTags) || oldTags.length !== n) return null;
  const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const similar = (a, b) => {
    const ca = collapse(a);
    const cb = collapse(b);
    if (!ca || !cb) return false;
    return longestCommonSubstringLen(ca, cb) >= Math.max(4, Math.ceil(Math.max(ca.length, cb.length) / 2));
  };
  const windows = [];
  for (let i = 0; i + n <= sourceLines.length && windows.length < 2; i++) {
    let mismatches = 0;
    let exactNonBlank = 0;
    let ok = true;
    for (let k = 0; k < n; k++) {
      const pat = oldLines[k];
      const src = sourceLines[i + k];
      if (src === pat) {
        if (collapse(pat)) exactNonBlank++;
        continue;
      }
      if (oldTags[k] !== ' ' || ++mismatches > 2 || !similar(pat, src)) { ok = false; break; }
    }
    if (ok && mismatches > 0 && exactNonBlank >= 2) windows.push(i);
  }
  return windows.length === 1 ? { start: windows[0] } : null;
}

// Bounded edit-distance tier (fuzzy, after the context-tolerance tier).
// Recovers the block a model retyped from memory with a couple of characters
// off — a dropped bracket, a mistyped short token — where the tolerance tier
// refuses because the drift sits on a deletion line. Guards keep it safe:
//   - TOTAL distance across the block stays within ~0.34 characters per line
//     (3 lines buy exactly 1 character), measured on trimmed text;
//   - at least 2 non-blank lines must match byte-exactly as anchors;
//   - the qualifying window must be UNIQUE across the ENTIRE file;
//   - the caller REMAPS every old line to the file's on-disk text, so the
//     emitted hunk stays byte-exact for the applier.
function findEditDistanceWindow(sourceLines, oldLines) {
  const n = (oldLines || []).length;
  const maxDistance = Math.floor(n * EDIT_DISTANCE_ALLOWANCE_PER_LINE);
  if (n < 3 || maxDistance <= 0) return null;
  const windows = [];
  for (let i = 0; i + n <= sourceLines.length && windows.length < 2; i++) {
    let total = 0;
    let exact = 0;
    let ok = true;
    for (let k = 0; k < n; k++) {
      const pat = String(oldLines[k] ?? '');
      const src = String(sourceLines[i + k] ?? '');
      if (src === pat) {
        if (pat.trim()) exact++;
        continue;
      }
      total += boundedEditDistance(src.trim(), pat.trim(), maxDistance - total);
      if (total > maxDistance) { ok = false; break; }
    }
    if (ok && total > 0 && exact >= 2) windows.push(i);
  }
  return windows.length === 1 ? { start: windows[0] } : null;
}

// Recovery for outer context the model got wrong — a stray copied line, or a
// whole surrounding block retyped from memory — around an edit whose deletion
// lines are current. Trim only contiguous outer ' ' lines — never '-' or '+'
// lines — smallest trim first, and accept the shortened old block only when it
// matches byte-exactly at exactly one place in the ENTIRE file. That
// uniqueness IS the position proof, so the trim budget runs to all available
// outer context: a byte-exact, file-unique deletion core cannot land anywhere
// else, whatever the caller wrote around it. Requiring a deletion keeps this
// off insertion-only hunks (they carry no payload to anchor on), and any
// competing trim plan or duplicate occurrence stays a hard context miss.
function findOuterContextTrimmedWindow(sourceLines, hunk, stats) {
  const body = (hunk?.lines || []).filter(
    (line) => typeof line === 'string'
      && line.length > 0
      && !isV4AEndOfFileMarker(line)
      && (line[0] === ' ' || line[0] === '-' || line[0] === '+'),
  );
  if (!body.some((line) => line[0] === '-')) return null;

  let leadingAvailable = 0;
  while (leadingAvailable < body.length && body[leadingAvailable][0] === ' ') leadingAvailable++;
  let trailingAvailable = 0;
  while (
    trailingAvailable < body.length - leadingAvailable
    && body[body.length - 1 - trailingAvailable][0] === ' '
  ) trailingAvailable++;
  if (leadingAvailable === 0 && trailingAvailable === 0) return null;

  const maxTrimmed = leadingAvailable + trailingAvailable;
  for (let totalTrimmed = 1; totalTrimmed <= maxTrimmed; totalTrimmed++) {
    const plans = [];
    let ambiguous = false;
    for (let leading = 0; leading <= Math.min(totalTrimmed, leadingAvailable); leading++) {
      const trailing = totalTrimmed - leading;
      if (trailing > trailingAvailable) continue;
      const remainingBody = body.slice(leading, body.length - trailing);
      if (!remainingBody.some((line) => line[0] === '-')) continue;
      const oldLines = stats.oldLines.slice(leading, stats.oldLines.length - trailing);
      const newLines = stats.newLines.slice(leading, stats.newLines.length - trailing);
      if (oldLines.length === 0) continue;

      const starts = [];
      outer: for (let i = 0; i + oldLines.length <= sourceLines.length; i++) {
        for (let k = 0; k < oldLines.length; k++) {
          if (sourceLines[i + k] !== oldLines[k]) continue outer;
        }
        starts.push(i);
        if (starts.length > 1) break;
      }
      if (starts.length > 1) {
        ambiguous = true;
      } else if (starts.length === 1) {
        plans.push({
          start: starts[0],
          oldLines,
          newLines,
          leading,
          trailing,
        });
      }
    }
    if (ambiguous || plans.length > 1) return null;
    if (plans.length === 1) return plans[0];
  }
  return null;
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
  if (oldStartIdx < 0) {
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
  // V4A parity (compute_replacements sorts by start index before
  // apply_replacements walks them in reverse): descending application is only
  // position-safe when the list is ordered by start index. Resolution order is
  // normally already ascending; the sort is stable, so equal starts keep their
  // resolution order.
  replacements.sort((a, b) => a.oldStartIdx - b.oldStartIdx);
  assertSafeReplacementPlan(replacements.map((rep) => ({ start: rep.oldStartIdx, oldLen: rep.oldLen })));
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
function v4aLinesCacheKey(fullPath) {
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
      const droppedOuterContext = new Set();
      let leadingToDrop = loc.trimmedLeadingContext || 0;
      for (let i = 0; i < hunk.lines.length && leadingToDrop > 0; i++) {
        const line = hunk.lines[i];
        if (isV4AEndOfFileMarker(line)) continue;
        if (!line || line[0] !== ' ') break;
        droppedOuterContext.add(i);
        leadingToDrop--;
      }
      let trailingToDrop = loc.trimmedTrailingContext || 0;
      for (let i = hunk.lines.length - 1; i >= 0 && trailingToDrop > 0; i--) {
        const line = hunk.lines[i];
        if (isV4AEndOfFileMarker(line)) continue;
        if (!line || line[0] !== ' ') break;
        droppedOuterContext.add(i);
        trailingToDrop--;
      }
      // Emit the body FIRST and derive the header counts from what was
      // actually emitted: the trailing-newline sentinel drop can remove a line
      // from one side only, so a header computed from the raw hunk stats can
      // disagree with the body and make the emitted unified patch unparseable.
      const bodyLines = [];
      let emittedOld = 0;
      let emittedNew = 0;
      let srcIdx = loc.oldStartIdx;
      const srcEnd = loc.oldStartIdx + loc.matchLen;
      for (let i = 0; i < hunk.lines.length; i++) {
        const line = hunk.lines[i];
        if (droppedOuterContext.has(i)) continue;
        if (isV4AEndOfFileMarker(line)) continue;
        const prefix = line[0];
        if (prefix === ' ' || prefix === '-') {
          if (i === dropOldAt) {
            // The sentinel line leaves the OLD side. When it is a context line
            // that the new side still keeps (the new slice is only trimmed
            // when it ends with the sentinel), it survives as an addition.
            if (prefix === ' ' && i !== dropNewAt) {
              bodyLines.push(`+${line.slice(1)}`);
              emittedNew++;
            }
            continue;
          }
          if (i === dropNewAt) continue;
          if (srcIdx < srcEnd && srcIdx < sourceLines.length) {
            bodyLines.push(prefix + sourceLines[srcIdx]);
          } else {
            bodyLines.push(line);
          }
          emittedOld++;
          if (prefix === ' ') emittedNew++;
          srcIdx++;
        } else {
          if (i === dropNewAt) continue;
          bodyLines.push(line);
          emittedNew++;
        }
      }
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
  return out.join('\n') + '\n';
}
