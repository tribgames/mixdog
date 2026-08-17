// V4A fuzzy window-matching tiers: bounded context tolerance, bounded edit
// distance, outer-context trimming, indent normalization, and opcode-prefix /
// plus-as-context restoration. Moved verbatim from v4a-convert.mjs; every
// tier keeps its uniqueness guard so a rescue can never mis-anchor.
import {
  longestCommonSubstringLen,
  boundedEditDistance,
  EDIT_DISTANCE_ALLOWANCE_PER_LINE,
} from './matcher.mjs';
import { isV4AEndOfFileMarker } from './parsing.mjs';
import { v4AHunkLineStats } from './v4a-anchors.mjs';

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
export function findContextTolerantWindow(sourceLines, oldLines, oldTags) {
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
export function findEditDistanceWindow(sourceLines, oldLines) {
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
export function findOuterContextTrimmedWindow(sourceLines, hunk, stats) {
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

export function uniqueExactSequenceStart(sourceLines, pattern) {
  if (!Array.isArray(pattern) || pattern.length === 0) return -1;
  let found = -1;
  outer: for (let i = 0; i + pattern.length <= sourceLines.length; i++) {
    for (let k = 0; k < pattern.length; k++) {
      if (sourceLines[i + k] !== pattern[k]) continue outer;
    }
    if (found >= 0) return -1;
    found = i;
  }
  return found;
}

function trimLeadingWs(value) {
  return String(value ?? '').replace(/^[\t ]*/, '');
}

function leadingWs(value) {
  return String(value ?? '').match(/^[\t ]*/)[0];
}

export function remapNewLineIndents(oldLines, sourceSlice, newLines) {
  const prefixMap = new Map();
  for (let k = 0; k < oldLines.length; k++) {
    const pat = String(oldLines[k] ?? '');
    const src = String(sourceSlice[k] ?? '');
    if (trimLeadingWs(pat) !== trimLeadingWs(src)) continue;
    const from = leadingWs(pat);
    const to = leadingWs(src);
    if (from === to) continue;
    if (prefixMap.has(from) && prefixMap.get(from) !== to) return newLines;
    prefixMap.set(from, to);
  }
  if (prefixMap.size === 0) return newLines;
  return newLines.map((line) => {
    const lead = leadingWs(line);
    if (!prefixMap.has(lead)) return line;
    return prefixMap.get(lead) + String(line).slice(lead.length);
  });
}

// Observed (tool-failures): same text, wrong leading indent. Accept only a
// unique whole-window trim-start match so `});` cannot land on a guess.
export function findIndentNormalizedWindow(sourceLines, oldLines) {
  const n = (oldLines || []).length;
  if (n === 0) return null;
  const starts = [];
  for (let i = 0; i + n <= sourceLines.length; i++) {
    let ok = true;
    let changed = false;
    for (let k = 0; k < n; k++) {
      const pat = String(oldLines[k] ?? '');
      const src = String(sourceLines[i + k] ?? '');
      if (trimLeadingWs(pat) !== trimLeadingWs(src)) {
        ok = false;
        break;
      }
      if (pat !== src) changed = true;
    }
    if (ok && changed) starts.push(i);
  }
  return starts.length === 1 ? { start: starts[0] } : null;
}

// A leading '-' or '+' on a source line was eaten as the hunk opcode
// (`- Plan` parsed as delete of ` Plan`). Restore when the dashed form is
// the unique window. Mixed hunks keep that line (it was context); delete-only
// hunks still delete the dashed file line.
export function restoreOpcodePrefixWindow(sourceLines, hunk) {
  const stats = v4AHunkLineStats(hunk);
  const oldLines = stats.oldLines;
  if (!oldLines.length) return null;
  const starts = [];
  for (let i = 0; i + oldLines.length <= sourceLines.length; i++) {
    let ok = true;
    for (let k = 0; k < oldLines.length; k++) {
      const src = sourceLines[i + k];
      const pat = oldLines[k];
      if (src !== pat && src !== `-${pat}` && src !== `+${pat}`) {
        ok = false;
        break;
      }
    }
    if (ok) starts.push(i);
  }
  if (starts.length !== 1) return null;
  const start = starts[0];
  const restoredOld = oldLines.map((_, k) => sourceLines[start + k]);
  if (!restoredOld.some((src, k) => src !== oldLines[k])) return null;
  const hadPlus = (hunk.lines || []).some((line) => line[0] === '+');
  const restoredNew = [];
  let oldIdx = 0;
  for (const raw of hunk.lines || []) {
    if (!raw) continue;
    const tag = raw[0];
    const body = raw.slice(1);
    if (tag === ' ') {
      restoredNew.push(restoredOld[oldIdx]);
      oldIdx += 1;
    } else if (tag === '-') {
      const restored = restoredOld[oldIdx];
      if (hadPlus && restored !== body) restoredNew.push(restored);
      oldIdx += 1;
    } else if (tag === '+') {
      restoredNew.push(body);
    }
  }
  return { start, oldLines: restoredOld, newLines: restoredNew };
}

// A '+' line was eaten as an addition (`+ TODO` parsed as insert of ` TODO`)
// when the file line is `+ TODO`. Peel those pluses into the unique old
// window so they stay context instead of a duplicate insert.
export function restorePlusAsContext(sourceLines, hunk) {
  const stats = v4AHunkLineStats(hunk);
  if (!stats.oldCount) return null;
  const body = (hunk.lines || []).filter(
    (line) => typeof line === 'string' && line.length > 0 && !isV4AEndOfFileMarker(line),
  );
  const windowOld = [];
  const windowNew = [];
  let peeled = 0;
  for (const raw of body) {
    const tag = raw[0];
    const rest = raw.slice(1);
    if (tag === ' ') {
      windowOld.push(rest);
      windowNew.push(rest);
    } else if (tag === '-') {
      windowOld.push(rest);
    } else if (tag === '+') {
      const asFile = `+${rest}`;
      if (sourceLines.includes(asFile)) {
        windowOld.push(asFile);
        windowNew.push(asFile);
        peeled += 1;
      } else {
        windowNew.push(rest);
      }
    }
  }
  if (!peeled || !windowOld.length) return null;
  const start = uniqueExactSequenceStart(sourceLines, windowOld);
  if (start < 0) return null;
  return { start, oldLines: windowOld, newLines: windowNew };
}