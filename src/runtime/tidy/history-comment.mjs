// Post-process `no-history-comment` matches. The graph/ast-grep rule can only
// flag a comment NODE that contains a history phrase; applying `fix: ""` to
// that node deletes mixed prose, a single `//` line out of a paragraph, or a
// whole `/** */` header. This module re-reads the file, expands contiguous
// line-comment runs, and:
//   - drops comments whose history words sit inside other sentences
//   - auto-deletes a comment/block only when EVERY sentence is history
//   - reports mixed comments as manual (no fix) with the offending sentence

const HISTORY_COMMENT_RULE_ID = 'no-history-comment';

const LOCATION_TOKEN = String.raw`(?:\.\.?/)*[\w][\w.-]*(?:/[\w.-]+)*`;

const HISTORY_SENTENCE_RE = new RegExp(
  `^(?:(?:extracted|moved|copied|lifted|split)(?:\\s+verbatim)?\\s+(?:from|out of)\\s+${LOCATION_TOKEN}` +
    `(?:\\s+\\((?:behaviou?r-preserving|no behaviou?r change)\\))?` +
    `|behaviou?r-preserving\\s+(?:move|extraction)` +
    `|previously\\s+(?:lived|defined)\\s+in\\s+${LOCATION_TOKEN}` +
    `|formerly\\s+${LOCATION_TOKEN})\\.?$`,
  'i'
);

const HISTORY_PHRASE_RE =
  /\b(?:(?:extracted|moved|copied|lifted|split)\s+(?:verbatim\s+)?(?:from|out of)|moved(?:\s+here)?\s+from|behaviou?r-preserving\s+(?:move|extraction)|previously\s+(?:lived|defined)\s+in|was\s+previously\s+in|formerly)\b/i;

export function isHistorySentence(text) {
  const sentence = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sentence) return false;
  return HISTORY_SENTENCE_RE.test(sentence);
}

function splitCommentSentences(text) {
  const cleaned = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(/[.!?;]+(?:\s+|$)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function commentBody(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  let inner = raw.trim();
  if (inner.startsWith('/*')) inner = inner.replace(/^\/\*+/, '').replace(/\*+\/\s*$/, '');
  else if (inner.startsWith('--[[')) inner = inner.replace(/^--\[\[/, '').replace(/\]\]\s*$/, '');
  else if (inner.startsWith('<!--')) inner = inner.replace(/^<!--/, '').replace(/-->\s*$/, '');
  const lines = inner.split('\n').map((line) => {
    let body = line.trim();
    if (body.startsWith('//')) body = body.slice(2);
    else if (body.startsWith('--')) body = body.slice(2);
    else if (body.startsWith('#')) body = body.slice(1);
    else if (body.startsWith('*')) body = body.slice(1);
    return body.trim();
  });
  return lines.filter(Boolean).join(' ').trim();
}

export function classifyHistoryComment(text) {
  const sentences = splitCommentSentences(commentBody(text));
  if (sentences.length === 0) return { kind: 'none', sentences: [], history: [], other: [] };
  const history = [];
  const other = [];
  for (const sentence of sentences) {
    if (isHistorySentence(sentence)) history.push(sentence);
    else other.push(sentence);
  }
  if (history.length === 0) return { kind: 'none', sentences, history, other };
  if (other.length === 0) return { kind: 'pure', sentences, history, other };
  return { kind: 'mixed', sentences, history, other, offending: history[0] };
}

function lineStart(buf, index) {
  let cursor = Math.max(0, Math.min(index, buf.length));
  while (cursor > 0 && buf[cursor - 1] !== 0x0a) cursor -= 1;
  return cursor;
}

function lineEnd(buf, index) {
  let cursor = Math.max(0, Math.min(index, buf.length));
  while (cursor < buf.length && buf[cursor] !== 0x0a && buf[cursor] !== 0x0d) cursor += 1;
  return cursor;
}

function lineCommentKind(line) {
  const trimmed = String(line || '').trimStart();
  if (trimmed.startsWith('//')) return '//';
  if (trimmed.startsWith('--')) return '--';
  if (trimmed.startsWith('#')) return '#';
  return '';
}

function isBlockCommentText(text) {
  const trimmed = String(text || '').trim();
  return trimmed.startsWith('/*') || trimmed.startsWith('--[[') || trimmed.startsWith('<!--');
}

function isFullLineComment(buf, start) {
  const prefix = buf.subarray(lineStart(buf, start), start).toString('utf8');
  return prefix.trim() === '';
}

function skipOneNewline(buf, index) {
  let cursor = index;
  if (cursor < buf.length && buf[cursor] === 0x0d) cursor += 1;
  if (cursor < buf.length && buf[cursor] === 0x0a) cursor += 1;
  return cursor;
}

function previousFullLineComment(buf, currentStart, kind) {
  if (currentStart <= 0) return null;
  const start = lineStart(buf, currentStart - 1);
  if (start >= currentStart) return null;
  const hi = lineEnd(buf, start);
  const body = buf.subarray(start, hi).toString('utf8');
  if (body.trim() === '') return null;
  if (lineCommentKind(body) !== kind) return null;
  return { start, end: hi };
}

function nextFullLineComment(buf, currentHi, kind) {
  const start = skipOneNewline(buf, currentHi);
  if (start >= buf.length || start === currentHi) return null;
  const end = lineEnd(buf, start);
  const body = buf.subarray(start, end).toString('utf8');
  if (body.trim() === '') return null;
  if (lineCommentKind(body) !== kind) return null;
  return { start, end };
}

function rangeIsCommentOnly(buf, start, end) {
  const text = buf.subarray(start, end).toString('utf8');
  if (isBlockCommentText(text))
    return /\/\*[\s\S]*\*\/\s*$/.test(text.trim()) || text.trim().startsWith('--[[') || text.trim().startsWith('<!--');
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return false;
  return lines.every((line) => {
    const trimmed = line.trim();
    if (trimmed === '') return true;
    return Boolean(lineCommentKind(line));
  });
}

/**
 * Comment-only byte range. A `//` run is from the first comment line's start
 * through the last comment line's end (the `\n`/`\r` is NOT consumed — that
 * newline belongs to source layout, and eating it plus the next line's indent
 * via lineEnd(end-1) used to swallow a sibling `continue;`). Trailing comments
 * on a code line stay on the comment node; never the following statement.
 */
function expandCommentRange(buf, start, end) {
  const nodeStart = Math.max(0, Math.min(Number(start) || 0, buf.length));
  const nodeEnd = Math.max(nodeStart, Math.min(Number(end) || nodeStart, buf.length));
  const slice = buf.subarray(nodeStart, nodeEnd).toString('utf8');
  if (isBlockCommentText(slice) || !isFullLineComment(buf, nodeStart)) {
    if (rangeIsCommentOnly(buf, nodeStart, nodeEnd)) return { start: nodeStart, end: nodeEnd };
    const lineHi = lineEnd(buf, nodeStart);
    const clamped = { start: nodeStart, end: Math.min(nodeEnd, lineHi) };
    if (rangeIsCommentOnly(buf, clamped.start, clamped.end)) return clamped;
    return { start: nodeStart, end: nodeStart };
  }
  const kind = lineCommentKind(buf.subarray(lineStart(buf, nodeStart), lineEnd(buf, nodeStart)).toString('utf8'));
  if (!kind) return { start: nodeStart, end: nodeEnd };
  let lo = lineStart(buf, nodeStart);
  let hi = lineEnd(buf, nodeStart);
  for (;;) {
    const prev = previousFullLineComment(buf, lo, kind);
    if (!prev) break;
    lo = prev.start;
  }
  for (;;) {
    const next = nextFullLineComment(buf, hi, kind);
    if (!next) break;
    hi = next.end;
  }
  let range = { start: lo, end: hi };
  if (!rangeIsCommentOnly(buf, range.start, range.end)) {
    range = {
      start: isFullLineComment(buf, nodeStart) ? lineStart(buf, nodeStart) : nodeStart,
      end: lineEnd(buf, nodeStart),
    };
  }
  if (!rangeIsCommentOnly(buf, range.start, range.end)) return { start: nodeStart, end: nodeEnd };
  return range;
}

function offsetsOf(match) {
  const range = match?.range?.byteOffset || match?.fix?.byteOffset;
  if (!Array.isArray(range) || range.length < 2) return null;
  const start = Number(range[0]);
  const end = Number(range[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null;
  return [start, end];
}

function mergeRanges(ranges) {
  const ordered = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of ordered) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * Refine graph matches for `no-history-comment`. `sourceFor(file)` returns a
 * Buffer of the file bytes (the same coordinate space as match byteOffset).
 */
export function refineHistoryCommentMatches(matches, { sourceFor } = {}) {
  const history = [];
  const rest = [];
  for (const match of matches || []) {
    if (match?.ruleId === HISTORY_COMMENT_RULE_ID) history.push(match);
    else rest.push(match);
  }
  if (history.length === 0) return matches || [];

  const byFile = new Map();
  for (const match of history) {
    const list = byFile.get(match.file) || [];
    list.push(match);
    byFile.set(match.file, list);
  }

  const refined = [];
  for (const [file, fileMatches] of byFile) {
    const source = sourceFor ? sourceFor(file) : null;
    let buf = null;
    if (Buffer.isBuffer(source)) buf = source;
    else if (typeof source === 'string') buf = Buffer.from(source, 'utf8');
    if (!buf) {
      for (const match of fileMatches) refined.push({ ...match, fix: null, manual: true });
      continue;
    }
    const expanded = [];
    for (const match of fileMatches) {
      const offsets = offsetsOf(match);
      if (!offsets) {
        refined.push({ ...match, fix: null, manual: true });
        continue;
      }
      const range = expandCommentRange(buf, offsets[0], offsets[1]);
      if (!HISTORY_PHRASE_RE.test(buf.subarray(range.start, range.end).toString('utf8'))) continue;
      expanded.push({ match, ...range });
    }
    for (const block of mergeRanges(expanded)) {
      const text = buf.subarray(block.start, block.end).toString('utf8');
      const classified = classifyHistoryComment(text);
      const sample = block.match || fileMatches[0];
      // Every refined row keeps the sample's identity but reports the expanded
      // block's byte range.
      const refine = (extra) => ({
        ...sample,
        file,
        range: { ...sample.range, byteOffset: [block.start, block.end] },
        ...extra,
      });
      if (classified.kind === 'none') continue;
      if (classified.kind === 'pure') {
        const blockComment = isBlockCommentText(text);
        const embedded =
          blockComment &&
          (!isFullLineComment(buf, block.start) ||
            buf.subarray(block.end, lineEnd(buf, block.end)).toString('utf8').trim() !== '');
        if (embedded) {
          refined.push(
            refine({
              fix: null,
              manual: true,
              message: 'History comment shares a line with code; preserve token boundaries and line terminators.',
            })
          );
          continue;
        }
        refined.push(
          refine({
            fix: {
              byteOffset: [block.start, block.end],
              text: blockComment ? (text.match(/\r\n|[\r\n\u2028\u2029]/g) || []).join('') : '',
            },
            manual: false,
            message: sample.message || 'Delete comments that only record a move or copy.',
          })
        );
        continue;
      }
      refined.push(
        refine({
          fix: null,
          manual: true,
          message: `History phrase mixed with other comment text; edit by hand: "${classified.offending}"`,
        })
      );
    }
  }
  return [...rest, ...refined];
}
