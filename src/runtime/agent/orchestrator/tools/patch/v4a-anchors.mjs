// V4A anchor resolution, ambiguity notices, and context-miss hint formatting.
// Moved verbatim from v4a-convert.mjs.
import {
  nearestPatchLineHint,
  nearestPatchLineMatch,
  firstMeaningfulPatchLine,
  compactPatchPreviewLine,
  formatPatchSourceExcerpt,
} from './matcher.mjs';

export function v4AHunkLineStats(hunk) {
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

// A single anchor of pure digits is a 1-based line-number claim — models copy
// the number straight from `read`'s `N→…` gutter. Returns the line number
// when it names a real line of the file, else null.
export function numericAnchorLineHint(anchors, lineCount) {
  const list = (anchors || []).map((anchor) => String(anchor || '').trim()).filter(Boolean);
  if (list.length !== 1 || !/^\d{1,7}$/.test(list[0])) return null;
  const lineNo = Number.parseInt(list[0], 10);
  return lineNo >= 1 && lineNo <= lineCount ? lineNo : null;
}

export function findAnchorLine(lines, anchors, fromLine) {
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
    const fromTop = seekAnchorChain(lines, list, 0);
    if (fromTop >= 0) return fromTop;
  }
  // Line-number absorption: every content pass above ran first, so this fires
  // only when the digits appear in NO line of the file; the number is then
  // trusted as a 1-based position hint and the body seek still validates the
  // hunk's real context from that line.
  const hint = numericAnchorLineHint(list, lines.length);
  if (hint !== null) return hint;
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

export function noteV4AHunkAmbiguity(displayPath, sourceLines, loc) {
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
export function noteV4AEofSignalIgnored(displayPath, loc) {
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

export function formatV4AHunkLocator(hunk) {
  return (hunk.anchors || []).filter(Boolean).join(' > ') || '(no anchor)';
}

export function formatV4AAnchorMissHint(sourceLines, hunk) {
  const anchors = (hunk?.anchors || []).filter(Boolean);
  const nearest = anchors.length > 0
    ? anchors.map((anchor) => nearestPatchLineHint(sourceLines, anchor, 0)).find(Boolean)
    : null;
  return anchors.length === 0
    ? ' use an existing @@ anchor from the current file or add exact context lines.'
    : ` use an existing @@ anchor from the current file or add exact context lines; no stubs.${nearest ? ` nearest anchor candidate: ${nearest}.` : ''}`;
}

export function formatV4AContextMissHint(sourceLines, stats, anchorLine) {
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

// A V4A envelope marker sitting inside a hunk's old lines means the patch
// TEXT is broken — a section body ended early, or its `*** Update File:`
// header is missing, so the marker was swallowed as content. Reporting that
// as a context miss sent the model hunting through the file for a line that
// was never in it (observed: four identical retries in 38 seconds). A file
// that genuinely contains the line (documentation about the patch format) is
// ordinary content and keeps the normal context path.
const V4A_ENVELOPE_MARKER_RE = /^\*\*\* (?:Begin Patch|End Patch|Update File:|Add File:|Delete File:|Move to:)/i;

export function v4aEnvelopeMarkerInHunk(sourceLines, oldLines) {
  const lines = oldLines || [];
  for (let index = 0; index < lines.length; index++) {
    const text = String(lines[index] ?? '');
    if (!V4A_ENVELOPE_MARKER_RE.test(text.trim())) continue;
    if ((sourceLines || []).includes(text)) continue;
    return { index, line: text };
  }
  return null;
}

export function formatV4AEnvelopeMarkerError(marker) {
  return 'V4A hunk structure error (malformed patch envelope): '
    + `${JSON.stringify(compactPatchPreviewLine(marker.line))} appears as a content line at old[${marker.index + 1}]. `
    + 'The section body ended early or is missing its `*** Update File: <path>` header. '
    + 'Rebuild the envelope and resend; the file was never searched, so no context excerpt applies.';
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