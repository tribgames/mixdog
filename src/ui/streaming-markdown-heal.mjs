const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCED_BLOCK = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm;
const INLINE_CODE_SPAN = /`+[^`\n]*`+/g;
const EMPHASIS_MARKERS = new Set(['*', '_', '~']);
const MARKDOWN_PUNCTUATION = /[!-/:-@[-`{-~\u00a1-\u00bf\u2010-\u2027\u2030-\u205e]/;
const HEALABLE_MARKDOWN_SYNTAX = /[`*_~[]/;

function openFence(text) {
  let marker = '';
  let length = 0;
  let start = 0;
  let lineStart = 0;
  for (const rawLine of String(text ?? '').split('\n')) {
    const fence = FENCE_LINE.exec(rawLine.replace(/\r$/, ''));
    if (fence) {
      const marks = fence[1];
      if (!marker) {
        marker = marks[0];
        length = marks.length;
        start = lineStart;
      } else if (marks[0] === marker && marks.length >= length && !fence[2].trim()) {
        marker = '';
        length = 0;
      }
    }
    lineStart += rawLine.length + 1;
  }
  return marker ? { marker, length, start } : null;
}

// The opening fence line arrives a token at a time: ``` → ```py → ```python.
// Rendered at once, the card opened unlabelled and then relabelled (and
// re-highlighted) per token. The card appears with its first code character:
// an opening line alone would paint an empty box before any code.
function trimPartialOpeningFence(text, fence) {
  const lineEnd = text.indexOf('\n', fence.start);
  return lineEnd >= 0 && /\S/.test(text.slice(lineEnd + 1)) ? text : text.slice(0, fence.start);
}

// A line holding only a block marker so far has no content to show, and the
// marker alone parses as something else: `-` or `=` under a paragraph is a
// setext underline (the paragraph flashed into a heading until the item text
// arrived), `2` is a lazy paragraph continuation until its `.` arrives, `#`
// grows into `##`, and a lone backtick run is literal text until it becomes a
// fence. Hold the line back until its first content character.
const PENDING_BLOCK_MARKER_LINE = /(?:^|\n)[ \t]*(?:[-+*=_#>~`]+|\d{1,9}[.)]?)[ \t]*$/;

function trimPendingBlockMarker(text) {
  const pending = PENDING_BLOCK_MARKER_LINE.exec(text);
  if (!pending) return text;
  return text.slice(0, pending.index + (pending[0].startsWith('\n') ? 1 : 0));
}

// A closing fence arrives a token at a time. Until its run is long enough to
// close, the partial marker line is not code: parsed, it became one more code
// line that vanished again once the fence closed — the block grew a line and
// shrank back (the source fallback already hides it the same way).
function trimPartialClosingFence(text, fence) {
  const partial = /(?:^|\r?\n) {0,3}([`~]+)$/.exec(text);
  const run = partial?.[1] || '';
  if (!partial || !run || run[0] !== fence.marker || run.length >= fence.length) return text;
  return text.slice(0, partial.index);
}

function closeInlineCode(text, isPendingLocalPath) {
  let open = 0;
  let openIndex = -1;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character !== '`') {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < text.length && text[end] === '`') end += 1;
    const run = end - index;
    if (!open) {
      open = run;
      openIndex = index;
    } else if (run === open) open = 0;
    index = end;
  }
  // An opener with nothing after it yet closes into an empty span, which
  // parses as a literal backtick run that then vanishes into code.
  if (open && (!text.slice(openIndex + open) || isPendingLocalPath?.(text.slice(openIndex + open)))) {
    return text.slice(0, openIndex);
  }
  return open > 0 ? `${text}${'`'.repeat(open)}` : text;
}

function maskCode(text) {
  FENCED_BLOCK.lastIndex = 0;
  return text
    .replace(FENCED_BLOCK, (block) => block.replace(/[^\n]/g, ' '))
    .replace(INLINE_CODE_SPAN, (span) => ' '.repeat(span.length));
}

function isMarkdownSpace(character) {
  return !character || /\s/.test(character);
}

function isMarkdownPunctuation(character) {
  return Boolean(character) && MARKDOWN_PUNCTUATION.test(character);
}

function scanEmphasisRuns(masked) {
  const runs = [];
  for (let index = 0; index < masked.length; ) {
    const marker = masked[index];
    if (marker === '\\') {
      index += 2;
      continue;
    }
    if (!EMPHASIS_MARKERS.has(marker)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (masked[end] === marker) end += 1;
    const length = end - index;
    const at = index;
    const before = index > 0 ? masked[index - 1] : '';
    const after = end < masked.length ? masked[end] : '';
    const beforeSpace = isMarkdownSpace(before);
    const afterSpace = isMarkdownSpace(after);
    const beforePunctuation = isMarkdownPunctuation(before);
    const afterPunctuation = isMarkdownPunctuation(after);
    const left = !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation);
    const right = !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation);
    if (marker === '~') {
      // A single tilde is inert, but at the end it may be half of `~~`.
      runs.push({
        marker,
        length: Math.min(length, 2),
        canOpen: left && length >= 2,
        canClose: right && length >= 2,
        at,
        end,
      });
    } else if (marker === '_') {
      runs.push({
        marker,
        length,
        canOpen: left && (!right || beforePunctuation),
        canClose: right && (!left || afterPunctuation),
        at,
        end,
      });
    } else {
      runs.push({ marker, length, canOpen: left, canClose: right, at, end });
    }
    index = end;
  }
  return runs;
}

function closeEmphasis(text) {
  const open = [];
  const runs = scanEmphasisRuns(maskCode(text));
  const last = runs[runs.length - 1];
  for (const run of runs) {
    let length = run.length;
    while (run.canClose && length > 0) {
      let match = -1;
      for (let index = open.length - 1; index >= 0; index -= 1) {
        if (open[index].marker === run.marker) {
          match = index;
          break;
        }
      }
      if (match < 0) break;
      const opener = open[match];
      const used = Math.min(opener.length, length);
      opener.length -= used;
      length -= used;
      open.length = opener.length > 0 ? match + 1 : match;
    }
    // A run ending the text that closed nothing has no content after it yet:
    // it painted as literal `**` until the next token turned it into style.
    if (run === last && run.end === text.length && length === run.length) {
      return closeEmphasis(text.slice(0, run.at));
    }
    if (length > 0 && run.canOpen) open.push({ marker: run.marker, length });
  }
  // Closers go before trailing whitespace: `**word ` closed after the space
  // could not close (a closing run must follow non-space) and stayed literal.
  const body = text.trimEnd();
  let closers = '';
  for (let index = open.length - 1; index >= 0; index -= 1) {
    closers += open[index].marker.repeat(Math.min(open[index].length, 3));
  }
  return closers ? `${body}${closers}${text.slice(body.length)}` : text;
}

function linkDestinationEnd(text, start) {
  let depth = 1;
  let delimiter = '';
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (delimiter) {
      if (character === delimiter) delimiter = '';
      continue;
    }
    if (character === '<' && !text.slice(start + 1, index).trim()) delimiter = '>';
    else if ((character === '"' || character === "'") && /\s/.test(text[index - 1])) delimiter = character;
    else if (character === '(') depth += 1;
    else if (character === ')' && --depth === 0) return index;
  }
  return -1;
}

function healIncompleteLink(text, isPendingLocalPath) {
  const masked = maskCode(text);
  let open = -1;
  let depth = 0;
  let label = -1;
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] === '\\') {
      index += 1;
      continue;
    }
    if (masked[index] === '[') {
      if (depth === 0) open = index;
      depth += 1;
    } else if (masked[index] === ']' && depth > 0 && --depth === 0) {
      label = index;
      if (masked[index + 1] === '(') {
        const end = linkDestinationEnd(masked, index + 1);
        if (end < 0) break;
        index = end;
      } else if (index === masked.length - 1) {
        break;
      }
      open = -1;
      label = -1;
    }
  }
  if (open < 0) return text;
  const caption = text.slice(open + 1, label < 0 ? undefined : label);
  // Footnotes and task boxes are not unfinished inline links.
  const linePrefix = text.slice(text.lastIndexOf('\n', open) + 1, open);
  if (
    caption.startsWith('^') ||
    caption.includes('\n\n') ||
    (/^ {0,3}(?:[-+*]|\d+[.)])\s+$/.test(linePrefix) && /^[ xX]?$/.test(caption))
  )
    return text;
  const image = open > 0 && masked[open - 1] === '!';
  const prefix = text.slice(0, image ? open - 1 : open);
  if (image) return `${prefix}${caption}`;
  if (label < 0 && isPendingLocalPath?.(caption)) return prefix;
  // Keep link typography from the first label token, including the `]` → `(`
  // boundary. An empty destination is inert in the renderer: a streamed URL
  // must never become clickable before its closing parenthesis arrives.
  return `${prefix}[${closeEmphasis(caption)}${']'.repeat(Math.max(0, depth - 1))}]()`;
}

const PIPE_ROW = /^ {0,3}\|/;
const DELIMITER_ROW = /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const PARTIAL_DELIMITER_ROW = /^ {0,3}\|?[\s:|-]*$/;

function tableCells(line) {
  const cells = line.trim().split(/(?<!\\)\|/);
  if (cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.length;
}

// A table streams in as its header row, then its delimiter row a token at a
// time. Until the delimiter is complete (and has the header's cell count) the
// rows are a paragraph of raw pipes, which then re-laid out as a table of a
// different height — the reply grew and shrank under a followed transcript.
// Hold both rows back until the table can form in one step. The head may end
// a block under paragraph lines (a table directly below its caption line),
// and a header row needs no leading pipe: such a row is held while it is the
// block's last line, and with a partial delimiter row below it.
function trimPendingTableHead(text) {
  let offset = 0;
  for (const blank of text.matchAll(/\n[ \t]*\r?\n/g)) offset = blank.index + blank[0].length;
  const block = text.slice(offset);
  const lines = block.split('\n').map((line) => line.replace(/\r$/, ''));
  // A row that ended with its newline is still the block's last row: the
  // empty line after it is not a (partial) delimiter row.
  let last = lines.length - 1;
  if (last >= 1 && !lines[last].trim()) last -= 1;
  let head = last;
  if (last >= 1 && PARTIAL_DELIMITER_ROW.test(lines[last]) && hasCellPipe(lines[last - 1])) {
    const delimiter = lines[last];
    if (DELIMITER_ROW.test(delimiter) && tableCells(delimiter) === tableCells(lines[last - 1])) return text;
    head = last - 1;
  }
  if (!(PIPE_ROW.test(lines[head]) || hasCellPipe(lines[head]))) return text;
  // Rows below a delimiter belong to a table that already formed.
  if (lines.slice(0, head).some((line) => DELIMITER_ROW.test(line))) return text;
  let start = offset;
  for (let index = 0; index < head; index += 1) start += lines[index].length + 1;
  return text.slice(0, start);
}

// A cell separator outside inline code: the line can head a table.
function hasCellPipe(line) {
  return /(?<!\\)\|/.test(line.replace(INLINE_CODE_SPAN, ''));
}

export function healStreamingMarkdownTail(text, isPendingLocalPath) {
  const source = String(text ?? '');
  const fence = source.includes('`') || source.includes('~') ? openFence(source) : null;
  if (fence) return trimPartialOpeningFence(trimPartialClosingFence(source, fence), fence);
  const unmarked = trimPendingBlockMarker(source);
  const value = unmarked.includes('|') ? trimPendingTableHead(unmarked) : unmarked;
  const hasSyntax = HEALABLE_MARKDOWN_SYNTAX.test(value);
  if (!value || (!hasSyntax && !isPendingLocalPath)) return value;
  const healed = hasSyntax
    ? closeEmphasis(healIncompleteLink(closeInlineCode(value, isPendingLocalPath), isPendingLocalPath))
    : value;
  // Only an unfinished final token can still grow into a compact file link.
  // Reuse the renderer's path grammar; code and completed links stay intact.
  const tail = isPendingLocalPath ? /\S+$/.exec(maskCode(healed)) : null;
  return tail && isPendingLocalPath(tail[0]) ? healed.slice(0, tail.index) : healed;
}
