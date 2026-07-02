// Diagnostic byte-parity matcher, line splitters, typographic normalization,
// nearest-line hints, and the V4A line-sequence locator. Moved verbatim from
// patch.mjs; matching/fuzz semantics mirror the native engine and are
// unchanged.

import { classifyEntry, stripDiffPrefix } from './paths.mjs';
import { normalizeOutputPath } from '../builtin.mjs';

export function collectUnifiedOldLines(hunk) {
  const oldLines = [];
  let lastWasOld = false;
  for (const raw of hunk?.lines || []) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const tag = raw[0];
    if (tag === '-' || tag === ' ') {
      oldLines.push({ tag, line: raw.slice(1), hasNewline: true });
      lastWasOld = true;
      continue;
    }
    if (tag === '\\') {
      if (lastWasOld && oldLines.length > 0) oldLines[oldLines.length - 1].hasNewline = false;
      lastWasOld = false;
      continue;
    }
    lastWasOld = false;
  }
  return oldLines;
}

export function collectUnifiedOps(hunk) {
  const ops = [];
  for (const raw of hunk?.lines || []) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const tag = raw[0];
    if (tag === ' ') ops.push('context');
    else if (tag === '-') ops.push('delete');
    else if (tag === '+') ops.push('add');
  }
  return ops;
}

export function computeUnifiedChangeBand(ops) {
  let first = null;
  let last = null;
  let oldCursor = 0;
  for (const op of ops) {
    if (op === 'context') {
      oldCursor += 1;
    } else if (op === 'delete') {
      const pos = (oldCursor + 1) * 2;
      first = first === null ? pos : Math.min(first, pos);
      last = last === null ? pos : Math.max(last, pos);
      oldCursor += 1;
    } else {
      const pos = oldCursor * 2 + 1;
      first = first === null ? pos : Math.min(first, pos);
      last = last === null ? pos : Math.max(last, pos);
    }
  }
  return { first, last };
}

export function firstMeaningfulUnifiedHunkLine(hunk) {
  for (const { line } of collectUnifiedOldLines(hunk)) {
    if (line.trim()) return { line, preferredLine: Math.max(0, (Number(hunk?.oldStart) || 1) - 1) };
  }
  return null;
}

export function firstFailingUnifiedHunkLineDetail(sourceLines, hunk) {
  const oldLines = collectUnifiedOldLines(hunk);
  if (!oldLines.length) return null;
  const lineEq = (actual, expected) => {
    const ab = toLineBytes(actual);
    const eb = toLineBytes(expected);
    return ab.equals(eb) || byteTrimPatchWhitespace(ab).equals(byteTrimPatchWhitespace(eb));
  };
  const prefixDepth = (start) => {
    let d = 0;
    while (d < oldLines.length && start + d < sourceLines.length && lineEq(sourceLines[start + d], oldLines[d].line)) d += 1;
    return d;
  };
  const declared = Math.max(0, (Number(hunk?.oldStart) || 1) - 1);
  const candidates = [];
  if (declared < sourceLines.length) candidates.push(declared);
  for (let i = 0; i < sourceLines.length && candidates.length < 8; i++) {
    if (i !== declared && lineEq(sourceLines[i], oldLines[0].line)) candidates.push(i);
  }
  let best = null;
  for (const start of candidates) {
    const depth = prefixDepth(start);
    if (depth >= oldLines.length) continue;
    if (!best || depth > best.depth) best = { start, depth };
  }
  if (!best || best.depth === 0) return null;
  return {
    line: oldLines[best.depth].line,
    preferredLine: best.start + best.depth,
  };
}

export function firstMeaningfulUnifiedEntryLine(entry) {
  const hunks = Array.isArray(entry?.hunks) ? entry.hunks : [];
  for (const hunk of hunks) {
    const expected = firstMeaningfulUnifiedHunkLine(hunk);
    if (expected) return expected;
  }
  return null;
}

// --- Byte-level diagnostic-matcher substrate (diagnostics ONLY) ---------------
export function toLineBytes(v) {
  return Buffer.isBuffer(v) ? v : Buffer.from(String(v ?? ''), 'utf8');
}

export function byteTrimPatchWhitespace(buf) {
  let start = 0;
  let end = buf.length;
  while (start < end && (buf[start] === 0x20 || buf[start] === 0x09)) start++;
  while (end > start && (buf[end - 1] === 0x20 || buf[end - 1] === 0x09)) end--;
  return buf.subarray(start, end);
}

const __utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function decodeValidUtf8OrNull(buf) {
  try {
    return __utf8FatalDecoder.decode(buf);
  } catch {
    return null;
  }
}

export function unifiedOldLinesMatchAt(sourceLines, oldLines, startIdx, fuzz, band) {
  if (startIdx < 0 || startIdx + oldLines.length > sourceLines.length) return null;
  let fuzzUsed = 0;
  let normCount = 0;
  const srcFinalNewline = sourceLines.hasFinalNewline !== false;
  const lastSrcIdx = sourceLines.length - 1;
  for (let offset = 0; offset < oldLines.length; offset++) {
    const expected = oldLines[offset];
    const actualIdx = startIdx + offset;
    const actualBytes = toLineBytes(sourceLines[actualIdx]);
    const expectedBytes = toLineBytes(expected.line);
    const expectedNL = expected.hasNewline !== false;
    const actualNL = !(actualIdx === lastSrcIdx && !srcFinalNewline);
    const newlineOk = expectedNL === actualNL;
    if (newlineOk && actualBytes.equals(expectedBytes)) continue;
    if (newlineOk && fuzz > 0 && (expected.tag === ' ' || expected.tag === '-') && byteTrimPatchWhitespace(actualBytes).equals(byteTrimPatchWhitespace(expectedBytes))) continue;
    if (
      newlineOk
      && fuzz > 0
      && (expected.tag === ' ' || expected.tag === '-')
    ) {
      const actualStr = decodeValidUtf8OrNull(actualBytes);
      const expectedStr = actualStr === null ? null : decodeValidUtf8OrNull(expectedBytes);
      if (
        actualStr !== null
        && expectedStr !== null
        && normalizeTypographic(actualStr) === normalizeTypographic(expectedStr)
      ) {
        normCount++;
        continue;
      }
    }
    if (fuzz > 0 && expected.tag === ' ') {
      const ctxPos = (offset + 1) * 2;
      const isOuter = (!band || band.first === null || band.last === null)
        ? true
        : (ctxPos < band.first || ctxPos > band.last);
      if (!isOuter) return null;
      fuzzUsed++;
      if (fuzzUsed <= fuzz) continue;
    }
    return null;
  }
  return { fuzzUsed, normCount };
}

export function findUnifiedHunkMatch(sourceLines, hunk, minStartIdx, fuzz) {
  const oldLines = collectUnifiedOldLines(hunk);
  const band = computeUnifiedChangeBand(collectUnifiedOps(hunk));
  const oldStart = Math.max(0, (Number(hunk?.oldStart) || 1) - 1);
  if (oldLines.length === 0) {
    const insertIdx = Math.max(0, Number(hunk?.oldStart) || 0);
    return insertIdx >= minStartIdx && insertIdx <= sourceLines.length ? { start: insertIdx, end: insertIdx } : null;
  }
  if (oldStart >= minStartIdx && unifiedOldLinesMatchAt(sourceLines, oldLines, oldStart, 0, band) !== null) {
    return { start: oldStart, end: oldStart + oldLines.length };
  }
  if (fuzz <= 0) return null;
  let best = null;
  for (let start = minStartIdx; start <= sourceLines.length - oldLines.length; start++) {
    const matched = unifiedOldLinesMatchAt(sourceLines, oldLines, start, fuzz, band);
    if (matched === null) continue;
    const { fuzzUsed, normCount } = matched;
    const distance = Math.abs(start - oldStart);
    if (
      !best ||
      fuzzUsed < best.fuzzUsed ||
      (fuzzUsed === best.fuzzUsed && normCount < best.normCount) ||
      (fuzzUsed === best.fuzzUsed && normCount === best.normCount && distance < best.distance)
    ) {
      best = { start, distance, fuzzUsed, normCount };
    }
  }
  return best ? { start: best.start, end: best.start + oldLines.length } : null;
}

export function findFirstFailingUnifiedHunk(entry, sourceLines, fuzz) {
  const hunks = Array.isArray(entry?.hunks) ? entry.hunks : [];
  let minStartIdx = 0;
  for (const hunk of hunks) {
    const match = findUnifiedHunkMatch(sourceLines, hunk, minStartIdx, fuzz);
    if (!match) return hunk;
    minStartIdx = Math.max(minStartIdx, match.end);
  }
  return null;
}

export function nativeFailurePathCandidates(parsed) {
  const candidates = new Set();
  for (const entry of Array.isArray(parsed) ? parsed : []) {
    const kind = classifyEntry(entry);
    const headerName = kind === 'create' ? entry.newFileName : entry.oldFileName;
    if (!headerName) continue;
    const stripped = stripDiffPrefix(headerName);
    const display = normalizeOutputPath(stripped);
    candidates.add(headerName);
    candidates.add(stripped);
    candidates.add(display);
    if (display) {
      candidates.add(`a/${display}`);
      candidates.add(`b/${display}`);
    }
  }
  return [...candidates].filter(Boolean).sort((a, b) => b.length - a.length);
}

export function extractNativeFailurePath(message, parsed) {
  const text = String(message || '').trim();
  if (!text) return '';
  const candidates = nativeFailurePathCandidates(parsed);
  for (const candidate of candidates) {
    if (text.startsWith(`${candidate}:`)) return candidate;
  }
  const hunkMatch = /(?:^|\b)hunk rejected in (.+?)(?: \(|$)/i.exec(text);
  if (hunkMatch?.[1]) return hunkMatch[1].trim();
  for (const candidate of candidates) {
    if (text.includes(candidate)) return candidate;
  }
  return '';
}

export function nativeFailureMatchesEntry(entry, failedPath) {
  if (!failedPath) return true;
  const kind = classifyEntry(entry);
  const headerName = kind === 'create' ? entry.newFileName : entry.oldFileName;
  if (!headerName) return false;
  const failed = normalizeOutputPath(stripDiffPrefix(failedPath));
  const display = normalizeOutputPath(stripDiffPrefix(headerName));
  if (!failed || !display) return false;
  if (failed === display) return true;
  return display.endsWith(`/${failed}`) || failed.endsWith(`/${display}`);
}

// --- typographic normalization + line splitters ------------------------------
const RUST_WS = '\\u0009\\u000A\\u000B\\u000C\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
const RUST_TRIM_RE = new RegExp(`^[${RUST_WS}]+|[${RUST_WS}]+$`, 'g');
function rustTrim(s) {
  return s.replace(RUST_TRIM_RE, '');
}
export function normalizeTypographic(s) {
  return rustTrim(String(s ?? ''))
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/g, ' ');
}

export function splitTextLinesForPatch(text) {
  const body = String(text ?? '').replace(/\r\n/g, '\n');
  if (body.length === 0) {
    const empty = [];
    empty.hasFinalNewline = true;
    return empty;
  }
  const lines = body.split('\n');
  let hasFinalNewline = true;
  if (lines[lines.length - 1] === '') lines.pop();
  else hasFinalNewline = false;
  lines.hasFinalNewline = hasFinalNewline;
  return lines;
}

export function splitBufferLinesForPatch(buf) {
  const empty = [];
  if (!buf || buf.length === 0) {
    empty.hasFinalNewline = true;
    return empty;
  }
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      let end = i;
      if (end > start && buf[end - 1] === 0x0d) end--;
      lines.push(buf.subarray(start, end));
      start = i + 1;
    }
  }
  let hasFinalNewline;
  if (start === buf.length) {
    hasFinalNewline = true;
  } else {
    lines.push(buf.subarray(start, buf.length));
    hasFinalNewline = false;
  }
  lines.hasFinalNewline = hasFinalNewline;
  return lines;
}

export function longestCommonSubstringLen(a, b, cap = 4000) {
  if (!a || !b) return 0;
  const A = a.length > cap ? a.slice(0, cap) : a;
  const B = b.length > cap ? b.slice(0, cap) : b;
  const la = A.length;
  const lb = B.length;
  if (la === 0 || lb === 0) return 0;
  let prev = new Int32Array(lb + 1);
  let curr = new Int32Array(lb + 1);
  let best = 0;
  for (let i = 1; i <= la; i++) {
    const ca = A.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      curr[j] = ca === B.charCodeAt(j - 1) ? prev[j - 1] + 1 : 0;
      if (curr[j] > best) best = curr[j];
    }
    const tmp = prev; prev = curr; curr = tmp;
    curr.fill(0);
  }
  return best;
}

export function findLineSequence(lines, needle, fromLine, preferredLine = 0, options = {}) {
  if (!Array.isArray(needle) || needle.length === 0) return Math.max(0, preferredLine || fromLine || 0);
  const eof = options?.eof === true;
  let minStart = Math.max(0, fromLine || 0);
  if (eof && needle.length <= lines.length) {
    minStart = Math.max(minStart, lines.length - needle.length);
  }
  const preferred = Math.max(0, preferredLine || 0);
  const fuzzy = options && options.fuzzy === false ? false : true;
  const tiers = fuzzy
    ? [
      (a, b) => a === b,
      (a, b) => a.replace(/\s+$/, '') === b.replace(/\s+$/, ''),
      (a, b) => a.trim() === b.trim(),
      (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim(),
      (a, b) => normalizeTypographic(a) === normalizeTypographic(b),
    ]
    : [
      (a, b) => a === b,
    ];
  for (const eq of tiers) {
    const starts = [];
    for (let i = minStart; i <= lines.length - needle.length; i++) {
      let ok = true;
      for (let k = 0; k < needle.length; k++) {
        if (!eq(lines[i + k], needle[k])) { ok = false; break; }
      }
      if (ok) starts.push(i);
    }
    if (starts.length) {
      starts.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b);
      return starts[0];
    }
  }
  if (fuzzy && needle.length === 1) {
    const want = String(needle[0] ?? '').replace(/\s+/g, ' ').trim();
    if (want.length >= 40) {
      const minLcs = Math.max(40, Math.floor(want.length / 2));
      let bestIdx = -1;
      let bestLcs = 0;
      let bestTies = 0;
      for (let i = minStart; i < lines.length; i++) {
        const cand = String(lines[i] ?? '').replace(/\s+/g, ' ').trim();
        if (cand.length === 0) continue;
        const lcs = longestCommonSubstringLen(cand, want);
        if (lcs < minLcs) continue;
        if (lcs > bestLcs) { bestLcs = lcs; bestIdx = i; bestTies = 1; }
        else if (lcs === bestLcs) { bestTies++; }
      }
      if (bestIdx >= 0 && bestTies === 1) return bestIdx;
    }
  }
  return -1;
}

export function compactPatchPreviewLine(line, maxLen = 140) {
  const text = String(line ?? '').replace(/\t/g, '\\t');
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

export function escapeNonAsciiForPatch(line) {
  const s = String(line ?? '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += code > 0x7f
      ? String.fromCharCode(92) + 'u' + code.toString(16).padStart(4, '0')
      : s[i];
  }
  return out;
}

export function findLineSequenceEscapeEquiv(sourceLines, pattern, minStart, preferred) {
  if (!pattern || pattern.length === 0) return -1;
  const starts = [];
  const from = Math.max(0, Number.isFinite(minStart) ? minStart : 0);
  outer: for (let i = from; i + pattern.length <= sourceLines.length; i++) {
    let usedEquiv = false;
    for (let k = 0; k < pattern.length; k++) {
      const pat = pattern[k];
      const src = sourceLines[i + k];
      if (src === pat) continue;
      if (src === escapeNonAsciiForPatch(pat)) { usedEquiv = true; continue; }
      continue outer;
    }
    if (usedEquiv) starts.push(i);
  }
  if (starts.length === 0) return -1;
  const pref = Number.isFinite(preferred) && preferred >= 0 ? preferred : 0;
  starts.sort((a, b) => Math.abs(a - pref) - Math.abs(b - pref) || a - b);
  return starts[0];
}

export function firstMeaningfulPatchLine(lines) {
  return (lines || []).find((line) => String(line ?? '').trim().length > 0) || '';
}

function scoreSimilarPatchLine(candidate, target) {
  const cand = String(candidate ?? '').trim().replace(/\s+/g, ' ');
  const want = String(target ?? '').trim().replace(/\s+/g, ' ');
  if (!cand || !want) return 0;
  if (cand === want) return 100000;
  let score = 0;
  const lcs = longestCommonSubstringLen(cand, want);
  score += lcs * 20;
  if (cand.includes(want) || want.includes(cand)) score += 5000 + Math.min(cand.length, want.length);
  const words = new Set(want.split(/[^A-Za-z0-9_$]+/).filter((word) => word.length > 1));
  for (const word of words) {
    if (cand.includes(word)) score += Math.min(200, word.length * 12);
  }
  if (Math.max(cand.length, want.length) < 80) {
    score -= Math.abs(cand.length - want.length);
  }
  return score;
}

export function nearestPatchLineHint(sourceLines, expectedLine, preferredLine) {
  const expected = String(expectedLine || '');
  if (!expected.trim()) return '';
  let best = null;
  const preferred = Number.isFinite(preferredLine) && preferredLine >= 0 ? preferredLine : 0;
  for (let i = 0; i < sourceLines.length; i++) {
    const score = scoreSimilarPatchLine(sourceLines[i], expected) - (Math.abs(i - preferred) * 0.01);
    if (!best || score > best.score) best = { score, index: i, line: sourceLines[i] };
  }
  if (!best || best.score <= 0) return '';
  return `nearest line ${best.index + 1}: ${JSON.stringify(compactPatchPreviewLine(best.line))}`;
}
