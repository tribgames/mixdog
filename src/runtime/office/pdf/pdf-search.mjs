import { round2 } from './pdf-draw.mjs';

// Text search over a pdf-layout result: where a phrase sits on the page, as a
// box in the layout's top-left coordinates. Pure functions; the layout comes
// from extractPdfTextLayout in pdf-analysis.mjs.

const SEARCH_LINE_TOLERANCE = 2;

// A line is the runs that share a baseline: the same `top` for upright text,
// the same `x` for text standing on a rotated page. Runs are ordered along
// the reading direction, which a reversed run walks backwards.
function layoutLines(page) {
  const lines = [];
  for (const item of page.items || []) {
    if (!item.text) continue;
    const vertical = item.vertical === true;
    const key = vertical ? item.x : item.top;
    let line = lines.find((entry) => entry.vertical === vertical
      && entry.reversed === (item.reversed === true)
      && Math.abs(entry.key - key) <= SEARCH_LINE_TOLERANCE);
    if (!line) {
      line = { key, vertical, reversed: item.reversed === true, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }
  for (const line of lines) {
    const along = (item) => (line.vertical ? item.top : item.x);
    line.items.sort((left, right) => (line.reversed ? along(right) - along(left) : along(left) - along(right)));
  }
  // Row order follows the normal to the reading direction, not display y:
  // rotating a page must not turn its last row into the first match.
  const rowPosition = (line) => line.key * (line.vertical
    ? (line.reversed ? 1 : -1)
    : (line.reversed ? -1 : 1));
  return lines.sort((left, right) => rowPosition(left) - rowPosition(right));
}

// Space between two consecutive runs along the reading direction, and the glyph height that scales it.
function runGap(previous, item, line) {
  if (line.vertical) {
    return line.reversed ? previous.top - (item.top + item.height) : item.top - (previous.top + previous.height);
  }
  return line.reversed ? previous.x - (item.x + item.width) : item.x - (previous.x + previous.width);
}

function glyphHeight(item, line) {
  return line.vertical ? item.width : item.height;
}

// Helvetica advance widths (per 1000 em) for U+0020..U+007E. A text run comes
// back as one box, so a match inside it is placed by the share of the run's
// width its characters take; equal shares put a mark a letter off in
// proportional type, and these metrics are close to any Latin body face.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584,
];

function glyphWeight(code) {
  if (code >= 32 && code <= 126) return HELVETICA_WIDTHS[code - 32];
  if (code < 32 || (code >= 0xdc00 && code <= 0xdfff)) return 0;
  // Hangul, CJK, and fullwidth forms take a full em; other scripts about a Latin letter.
  const wide = (code >= 0x1100 && code <= 0x11ff)
    || (code >= 0x2e80 && code <= 0x9fff)
    || (code >= 0xac00 && code <= 0xd7af)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xff00 && code <= 0xff60)
    || code >= 0x20000;
  return wide ? 1000 : 556;
}

function runWeight(text, from, to) {
  let total = 0;
  for (let index = from; index < to; index += 1) total += glyphWeight(text.codePointAt(index));
  return total;
}

function matchBox(spans, start, end, line) {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const span of spans) {
    const from = Math.max(start, span.start);
    const to = Math.min(end, span.end);
    if (from >= to) continue;
    const { item } = span;
    const { text } = item;
    const total = Math.max(1, runWeight(text, 0, text.length));
    const shares = [runWeight(text, 0, from - span.start) / total, runWeight(text, 0, to - span.start) / total];
    // The match's share of the run, measured along the reading direction
    // (from the far end when the run is reversed); the other axis is the run's.
    const along = (origin, length) => shares.map((share) => (line.reversed ? origin + length - (length * share) : origin + (length * share)));
    if (line.vertical) {
      const [first, second] = along(item.top, item.height);
      top = Math.min(top, first, second);
      bottom = Math.max(bottom, first, second);
      left = Math.min(left, item.x);
      right = Math.max(right, item.x + item.width);
    } else {
      const [first, second] = along(item.x, item.width);
      left = Math.min(left, first, second);
      right = Math.max(right, first, second);
      top = Math.min(top, item.top);
      bottom = Math.max(bottom, item.top + item.height);
    }
  }
  return { x: round2(left), top: round2(top), width: round2(right - left), height: round2(bottom - top) };
}

// pdf.js hands text back as runs, and a phrase often spans several. Each line
// is joined into one string that remembers which run owns every character, so
// a match maps back to a box by the share of each run it covers.
// Literal occurrences by indexOf on the case-folded line; a pattern runs on
// the original text, case-insensitively.
function* occurrences(text, haystack, target, pattern) {
  if (pattern) {
    for (const found of text.matchAll(pattern)) {
      if (found[0].length > 0) yield [found.index, found.index + found[0].length];
    }
    return;
  }
  let from = 0;
  while (from + target.length <= haystack.length) {
    const start = haystack.indexOf(target, from);
    if (start < 0) break;
    const end = start + target.length;
    yield [start, end];
    from = end;
  }
}

export function findPdfText(layout, query, { limit = 200, wholeWord = false, regex = false } = {}) {
  const raw = String(query ?? '').trim();
  const needle = regex ? raw : raw.replace(/\s+/g, ' ');
  if (!needle) throw new Error('PDF text search needs query text');
  let pattern = null;
  if (regex) {
    try {
      pattern = new RegExp(needle, 'giu');
    } catch (error) {
      throw new Error(`PDF text search pattern is invalid: ${error.message}`);
    }
  }
  const wordChar = /[\p{L}\p{N}]/u;
  const bounded = (text, start, end) => !wholeWord
    || ((start === 0 || !wordChar.test(text[start - 1])) && (end >= text.length || !wordChar.test(text[end])));
  const matches = [];
  let truncated = false;
  for (const page of layout.pages || []) {
    for (const line of layoutLines(page)) {
      let text = '';
      const spans = [];
      for (const item of line.items) {
        const previous = spans.at(-1);
        // A gap wider than a third of the glyph height is a word break the runs did not carry.
        const gap = previous ? runGap(previous.item, item, line) : 0;
        if (previous && gap > glyphHeight(item, line) / 3 && !/\s$/.test(text) && !/^\s/.test(item.text)) text += ' ';
        spans.push({ item, start: text.length, end: text.length + item.text.length });
        text += item.text;
      }
      // Lower-casing can change a string's length (İ → i̇); match exactly when it does.
      const folded = text.toLowerCase();
      const exact = folded.length !== text.length;
      const haystack = exact ? text : folded;
      const target = exact ? needle : needle.toLowerCase();
      for (const [start, end] of occurrences(text, haystack, target, pattern)) {
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        if (bounded(text, start, end)) {
          matches.push({ page: page.page, text: text.slice(start, end), line: text.trim().slice(0, 200), ...matchBox(spans, start, end, line) });
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { query: needle, matchCount: matches.length, matches, truncated };
}
