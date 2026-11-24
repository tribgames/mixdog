const FENCE_LINE = /^ {0,3}(`{3,}|~{3,}|\${2,})(.*)$/;
const FENCED_BLOCK = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm;
const INLINE_CODE_SPAN = /`+[^`\n]*`+/g;
// Closes only on a run of exactly its own two `$`; `\$` is TeX inside it.
// Each longer run is taken whole, so a line of `$` is read once.
const INLINE_MATH_SPAN = /(?<![\\$])\$\$(?!\$)(?:[^$\n]|\$(?!\$)|\${3,}(?!\$))+?(?<!\$)\$\$(?!\$)/g;
const EMPHASIS_MARKERS = new Set(['*', '_', '~']);
const MARKDOWN_PUNCTUATION = /[!-/:-@[-`{-~\u00a1-\u00bf\u2010-\u2027\u2030-\u205e]/;
const HEALABLE_MARKDOWN_SYNTAX = /[`*_~[]/;

// Display math opens only where nothing after its `$$` holds a `$`: a line
// like `$$a$$` is inline math. The last line still waits for that closing
// run, and paints once its span closes.
function opensMathBlock(marks, rest, last) {
  if (!rest.includes('$')) return true;
  return last && !Array.from(rest.matchAll(/\\.|\$+/g)).some(([run]) => run.length === marks.length && run[0] === '$');
}

/** The fence still open at the end, and where each closed `$$` block spans. */
function scanFences(text) {
  let marker = '';
  let length = 0;
  let start = 0;
  let lineStart = 0;
  const mathBlocks = [];
  const lines = String(text ?? '').split('\n');
  for (const [index, rawLine] of lines.entries()) {
    const fence = FENCE_LINE.exec(rawLine.replace(/\r$/, ''));
    if (fence && (marker || fence[1][0] !== '$' || opensMathBlock(fence[1], fence[2], index === lines.length - 1))) {
      const marks = fence[1];
      if (!marker) {
        marker = marks[0];
        length = marks.length;
        start = lineStart;
      } else if (marks[0] === marker && marks.length >= length && !fence[2].trim()) {
        if (marker === '$') mathBlocks.push([start, lineStart + rawLine.length]);
        marker = '';
        length = 0;
      }
    }
    lineStart += rawLine.length + 1;
  }
  return { open: marker ? { marker, length, start } : null, mathBlocks };
}

function trimPartialOpeningFence(text, fence) {
  const lineEnd = text.indexOf('\n', fence.start);
  return lineEnd >= 0 && /\S/.test(text.slice(lineEnd + 1)) ? text : text.slice(0, fence.start);
}

const TEX_TOKEN = /\\(begin|end)\s*\{([^{}]*)\}|\\[a-zA-Z]+|\\[\s\S]|%[^\n]*|\S/g;

// The closers an unfinished formula still owes: an environment, group or
// `\left` that is open only because the rest has not arrived yet would
// otherwise fail to typeset.
function closeOpenTex(tex) {
  const owed = [];
  let delimiter = false;
  for (const [token, kind, name] of tex.matchAll(TEX_TOKEN)) {
    if (token[0] === '%') continue;
    if (delimiter) {
      delimiter = false;
      continue;
    }
    if (kind === 'begin') owed.push(`\\end{${name}}`);
    else if (kind === 'end') {
      const at = owed.lastIndexOf(`\\end{${name}}`);
      if (at >= 0) owed.length = at;
    } else if (token === '{') owed.push('}');
    else if (token === '}' && owed.at(-1) === '}') owed.pop();
    else if (token === '\\left') {
      owed.push('\\right.');
      delimiter = true;
    } else if (token === '\\right') {
      const at = owed.lastIndexOf('\\right.');
      if (at >= 0) owed.length = at;
      delimiter = true;
    }
  }
  return `${delimiter ? '.' : ''}${owed.reverse().join('')}`;
}

const PENDING_BLOCK_MARKER_LINE = /(?:^|\n)[ \t]*(?:[-+*=_#>~`]+|\$|\d{1,9}[.)]?)[ \t]*$/;

function trimPendingBlockMarker(text) {
  const pending = PENDING_BLOCK_MARKER_LINE.exec(text);
  if (!pending) return text;
  return text.slice(0, pending.index + (pending[0].startsWith('\n') ? 1 : 0));
}

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

// Math is literal like code: its `_`, `*` and `[` are TeX, never markdown.
function maskCode(text) {
  const blank = (block) => block.replace(/[^\n]/g, ' ');
  let masked = text;
  if (text.includes('$$')) {
    const parts = [];
    let cursor = 0;
    for (const [start, end] of scanFences(text).mathBlocks) {
      parts.push(text.slice(cursor, start), blank(text.slice(start, end)));
      cursor = end;
    }
    parts.push(text.slice(cursor));
    masked = parts.join('');
  }
  return masked
    .replace(FENCED_BLOCK, blank)
    .replace(INLINE_CODE_SPAN, blank)
    .replace(INLINE_MATH_SPAN, blank);
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
  const fence = /[`~$]/.test(source) ? scanFences(source).open : null;
  if (fence?.marker === '$') {
    // TeX cut mid-command fails to typeset: open math grows by whole lines.
    const shown = trimPartialOpeningFence(source.slice(0, source.lastIndexOf('\n') + 1), fence);
    if (shown.length === fence.start) return shown;
    return `${shown}${closeOpenTex(shown.slice(shown.indexOf('\n', fence.start) + 1))}`;
  }
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
