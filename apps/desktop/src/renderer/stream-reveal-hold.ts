/**
 * Where a streamed reply may stop painting.
 *
 * The live row paints a prefix of the received text. A prefix that ends
 * inside an unfinished markdown construct paints its raw syntax (a lone list
 * marker, a backtick, `[`, `**`, a half table row), so the cut is held back to
 * the start of that construct and the construct appears whole once the cut
 * passes its end:
 *
 * - Lines that appear whole: a heading, a table row (a line starting with a
 *   pipe, a header whose delimiter row follows, any line under a delimiter
 *   row), a fence line, and every line inside a fenced code block, so code
 *   reveals line by line and a possible closing fence never shows half typed.
 *   A table header waits for its delimiter row and both appear together.
 * - A line that is only a list marker (task box included) or a quote marker
 *   shows with the first glyph after it.
 * - Inline: an image until its `](…)` closes (it paints as one picture).
 *   Code spans, links and emphasis are not held: the streaming healer
 *   (streaming-markdown-heal) closes them in the painted tail and hides a
 *   marker with nothing after it and a link's unfinished destination, so
 *   their words stream like any other and take their style as they show.
 * - While the text still streams, a trailing `!`, `<` or `\` waits for the
 *   character after it.
 *
 * `text` is everything received; only `text.slice(0, cut)` paints, so the
 * characters after the cut serve as lookahead. Settled text (`live` false) is
 * never held at its end.
 *
 * A paced reveal (coding transcript) holds less: a line that is only a list
 * or heading marker, a closing fence still being typed, and a table row until
 * its newline arrives (a half row makes the columns jitter sideways);
 * everything else reveals word by word (pacedRevealCeiling, pacedRevealStep).
 */

/** A line longer than this is prose, not a row or heading worth holding. */
const LINE_HOLD_MAX = 400;
const HEADING = /^ {0,3}(?:>[ \t]*)*#{1,6}(?:[ \t]|$)/;
const LIST_MARKER_ONLY = /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d{1,9}[.)]?)(?:[ \t]+(?:\[(?:[ xX](?:\][ \t]*)?)?)?)?$/;
const LIST_START = /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d{1,9}[.)])[ \t]/;
const THEMATIC_BREAK = /^[ \t>]*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const HTML_BLOCK = /^[ \t>]*<[A-Za-z/!?]/;
const QUOTE_MARKER_ONLY = /^[ \t]*(?:>[ \t]*)+$/;
const FENCE_LINE = /^[ \t>]*(?:`{3,}|~{3,})/;
const FENCE_OPEN = /^[ \t>]*(?:(`{3,})[^`]*|(~{3,}).*)$/;
const DELIMITER_BODY = /^[|:\- \t]+$/;
const CONTAINER_PREFIX = /^[ \t>]*/;
const TRAILING_WAIT = new Set(['!', '<', '\\']);
/** A cell separator (not escaped): the line can head a table. */
const HEADER_PIPE = /(?<!\\)\|/;
const CODE_SPAN = /`+[^`\n]*`+/g;
/** What a delimiter row may look like while it streams in. */
const PARTIAL_DELIMITER = /^[ \t>]*\|?[ \t:|-]*$/;
const TABLE_LOOKBACK_LINES = 64;

let fenceCache: { text: string; ranges: number[] } | null = null;

/** Content ranges of fenced code blocks, flat [start, end) pairs: from the
 *  line after an opening fence to the start of its closing fence line
 *  (Infinity while unclosed). */
function fencedRanges(text: string): number[] {
  if (fenceCache?.text === text) return fenceCache.ranges;
  const ranges: number[] = [];
  if (text.includes('```') || text.includes('~~~')) {
    let fence = '';
    let at = 0;
    while (at < text.length) {
      let end = text.indexOf('\n', at);
      if (end < 0) end = text.length;
      const line = text.slice(at, end).replace(CONTAINER_PREFIX, '');
      if (!fence) {
        const open = FENCE_OPEN.exec(text.slice(at, end));
        if (open) {
          fence = open[1] ?? open[2];
          ranges.push(end + 1);
        }
      } else if (line.startsWith(fence[0].repeat(fence.length)) && /^[`~]+[ \t]*$/.test(line) && line[0] === fence[0]) {
        ranges.push(at);
        fence = '';
      }
      at = end + 1;
    }
    if (fence) ranges.push(Number.POSITIVE_INFINITY);
  }
  fenceCache = { text, ranges };
  return ranges;
}

function insideCode(ranges: number[], at: number): boolean {
  for (let index = 0; index < ranges.length; index += 2) {
    if (at >= ranges[index] && at < ranges[index + 1]) return true;
  }
  return false;
}

function lineEndOf(text: string, from: number): number {
  const end = text.indexOf('\n', from);
  return end < 0 ? text.length : end;
}

function isDelimiterRow(line: string): boolean {
  const body = line.replace(CONTAINER_PREFIX, '').trimEnd();
  return body.includes('|') && body.includes('-') && DELIMITER_BODY.test(body);
}

/** A line that starts another block (heading, list item, fence): it ends a
 *  table instead of continuing it. */
function startsBlock(line: string): boolean {
  return (
    HEADING.test(line) || LIST_START.test(line) || FENCE_LINE.test(line) || THEMATIC_BREAK.test(line) || HTML_BLOCK.test(line)
  );
}

/** Nesting depth of the blockquote a line sits in (its leading `>` markers). */
function quoteDepth(line: string): number {
  return CONTAINER_PREFIX.exec(line)![0].split('>').length - 1;
}

/** A delimiter row sits among the non-blank lines right above `lineStart`
 *  with no other block start between, and in the same quote container. */
function tableAbove(text: string, lineStart: number): boolean {
  const depth = quoteDepth(text.slice(lineStart, lineEndOf(text, lineStart)));
  let end = lineStart - 1;
  for (let count = 0; end > 0 && count < TABLE_LOOKBACK_LINES; count += 1) {
    const start = text.lastIndexOf('\n', end - 1) + 1;
    const line = text.slice(start, end);
    if (!line.trim()) return false;
    if (quoteDepth(line) !== depth) return false;
    if (isDelimiterRow(line)) return true;
    if (startsBlock(line)) return false;
    end = start - 1;
  }
  return false;
}

/** The line at `lineStart` is a table row. */
function tableRow(text: string, lineStart: number, line: string): boolean {
  const body = line.replace(CONTAINER_PREFIX, '');
  if (body.startsWith('|')) return true;
  if (!body.trim()) return false;
  if (startsBlock(line)) return false;
  if (tableAbove(text, lineStart)) return true;
  if (!body.includes('|')) return false;
  const next = lineEndOf(text, lineStart) + 1;
  return next < text.length && isDelimiterRow(text.slice(next, lineEndOf(text, next)));
}

/** Closing parenthesis of a link destination opened at `from` (after `(`),
 *  on the same line; -1 when not received yet. */
function linkClose(text: string, from: number, lineEnd: number): number {
  let depth = 0;
  for (let at = from; at < lineEnd; at += 1) {
    const char = text[at];
    if (char === '\\') at += 1;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth === 0) return at;
      depth -= 1;
    }
  }
  return -1;
}

/** Start of an image opened in [lineStart, cut) and not closed by `cut`
 *  (outside code spans), or cut. */
function imageHold(text: string, lineStart: number, cut: number, live: boolean): number {
  const lineEnd = lineEndOf(text, lineStart);
  let codeRun = 0;
  let image = -1;
  let depth = 0;
  let at = lineStart;
  while (at < cut) {
    const char = text[at];
    if (char === '`') {
      let run = 1;
      while (at + run < cut && text[at + run] === '`') run += 1;
      if (!codeRun) codeRun = run;
      else if (run === codeRun) codeRun = 0;
      at += run;
      continue;
    }
    if (codeRun) {
      at += 1;
      continue;
    }
    if (char === '\\') {
      at += 2;
      continue;
    }
    if (image < 0) {
      if (char === '!' && text[at + 1] === '[') {
        image = at;
        depth = 1;
        at += 2;
        continue;
      }
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        const next = text[at + 1];
        if (next === undefined && live) break;
        if (next === '(') {
          const close = linkClose(text, at + 2, lineEnd);
          if (close < 0 || close >= cut) break;
          at = close;
        }
        image = -1;
      }
    }
    at += 1;
  }
  return image >= 0 ? image : cut;
}

/** A table header row (a line with a cell pipe, not inside a formed table)
 *  ends right before `at` and the line at `at` may still be its delimiter
 *  row: the cut goes back to the header, which paints with its delimiter
 *  (alone it parses as a paragraph of raw pipes). */
function tableHeadHold(text: string, at: number, live: boolean): number {
  if (at <= 0 || (!live && at >= text.length)) return at;
  // The line after the possible header: `at` starts it, or `at` is inside it
  // while it reads as a delimiter row so far.
  const below = text.lastIndexOf('\n', at - 1) + 1;
  if (below === 0) return at;
  const next = text.slice(below, lineEndOf(text, below));
  if (below < at && !(next.includes('-') && PARTIAL_DELIMITER.test(next))) return at;
  const start = text.lastIndexOf('\n', below - 2) + 1;
  const line = text.slice(start, below - 1);
  if (!HEADER_PIPE.test(line.replace(CODE_SPAN, '')) || isDelimiterRow(line)) return at;
  if (insideCode(fencedRanges(text), start) || tableAbove(text, start)) return at;
  if (below >= text.length) return live ? start : at;
  return next.trim() && PARTIAL_DELIMITER.test(next) ? start : at;
}

/** A line that is only a list marker (a task box being typed included). */
const BARE_LIST_MARKER =
  /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)]?)$|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[(?:[ xX](?:\][ \t]*)?)?)?$)/;
/** A line that is only heading hashes. */
const BARE_HEADING_MARKER = /^ {0,3}(?:>[ \t]*)*#{1,6}[ \t]*$/;
/** What a closing fence looks like while it is typed. */
const FENCE_BEING_TYPED = /^[ \t>]*(?:`+|~+)$/;

/** Start of the line holding `at` when the paced reveal may not stop at `at`:
 *  the line so far is only a list or heading marker, or, inside a code block,
 *  a fence still being typed. -1 when it may stop there. */
export function pacedHoldStart(text: string, at: number): number {
  if (at <= 0) return -1;
  const start = text.lastIndexOf('\n', at - 1) + 1;
  if (start === at) return -1;
  const line = text.slice(start, at);
  if (BARE_LIST_MARKER.test(line) || BARE_HEADING_MARKER.test(line)) return start;
  const code = insideCode(fencedRanges(text), start);
  if (code) return FENCE_BEING_TYPED.test(line) ? start : -1;
  const lineEnd = lineEndOf(text, start);
  if (at < lineEnd || lineEnd >= text.length) {
    const whole = text.slice(start, lineEnd);
    if (whole.length <= LINE_HOLD_MAX && tableRow(text, start, whole)) return start;
  }
  return -1;
}

/** Never end inside a surrogate pair. */
function wholeChar(text: string, at: number): number {
  return at > 0 && at < text.length && (text.charCodeAt(at) & 0xfc00) === 0xdc00 ? at - 1 : at;
}

/** How far the paced reveal of live `text` may go: everything but a last
 *  line that is only a marker, a closing fence being typed or a table row
 *  without its newline. Code lines and heading text stream within their
 *  line; the streaming healer closes their inline syntax. */
export function pacedRevealCeiling(text: string): number {
  const held = pacedHoldStart(text, text.length);
  return wholeChar(text, held === -1 ? text.length : held);
}

/** `size` characters on from `from`, never past `ceiling`, back to just
 *  after the last space when that keeps more than half the step. */
function wordStep(text: string, from: number, ceiling: number, size: number): number {
  const cut = Math.min(from + size, ceiling);
  if (cut < ceiling) {
    const space = text.lastIndexOf(' ', cut);
    if (space > from + size / 2) return space + 1;
  }
  return wholeChar(text, cut);
}

/** End of one paced reveal step of `size` characters from `from`: it never
 *  stops on a line that is only a marker or a fence being typed (it stops
 *  before that line, or steps on past it). */
export function pacedRevealStep(text: string, from: number, ceiling: number, size: number): number {
  let end = wordStep(text, from, ceiling, size);
  for (let held = pacedHoldStart(text, end); held !== -1; held = pacedHoldStart(text, end)) {
    if (held > from) return held;
    if (end >= ceiling) return ceiling;
    end = wordStep(text, end, ceiling, size);
  }
  return end;
}

/** The furthest cut at or before `cut` that paints no unfinished construct of
 *  `text`. */
export function revealHold(text: string, cut: number, live: boolean): number {
  return tableHeadHold(text, lineHold(text, cut, live), live);
}

function lineHold(text: string, cut: number, live: boolean): number {
  if (cut <= 0) return 0;
  if (cut >= text.length && !live) return text.length;
  const lineStart = text.lastIndexOf('\n', cut - 1) + 1;
  if (lineStart === cut) return cut;
  if (insideCode(fencedRanges(text), lineStart)) return lineStart;
  const lineEnd = lineEndOf(text, lineStart);
  const line = text.slice(lineStart, lineEnd);
  const prefix = text.slice(lineStart, cut);
  if (FENCE_LINE.test(prefix)) return lineStart;
  if (LIST_MARKER_ONLY.test(prefix) || QUOTE_MARKER_ONLY.test(prefix)) return lineStart;
  if (line.length <= LINE_HOLD_MAX && (HEADING.test(prefix) || tableRow(text, lineStart, line))) return lineStart;
  let hold = imageHold(text, lineStart, cut, live);
  if (live && cut === text.length && hold === cut && TRAILING_WAIT.has(text[cut - 1])) hold = cut - 1;
  return hold;
}
