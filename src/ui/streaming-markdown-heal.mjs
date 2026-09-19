const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCED_BLOCK = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm;
const INLINE_CODE_SPAN = /`+[^`\n]*`+/g;
const EMPHASIS_MARKERS = new Set(['*', '_', '~']);
const MARKDOWN_PUNCTUATION = /[!-/:-@[-`{-~\u00a1-\u00bf\u2010-\u2027\u2030-\u205e]/;
const HEALABLE_MARKDOWN_SYNTAX = /[`*_~[]/;

function hasOpenFence(text) {
  let marker = '';
  let length = 0;
  for (const rawLine of String(text ?? '').split('\n')) {
    const fence = FENCE_LINE.exec(rawLine.replace(/\r$/, ''));
    if (!fence) continue;
    const marks = fence[1];
    if (!marker) {
      marker = marks[0];
      length = marks.length;
    } else if (marks[0] === marker && marks.length >= length && !fence[2].trim()) {
      marker = '';
      length = 0;
    }
  }
  return Boolean(marker);
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
  if (open && isPendingLocalPath?.(text.slice(openIndex + open))) {
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
    const before = index > 0 ? masked[index - 1] : '';
    const after = end < masked.length ? masked[end] : '';
    const beforeSpace = isMarkdownSpace(before);
    const afterSpace = isMarkdownSpace(after);
    const beforePunctuation = isMarkdownPunctuation(before);
    const afterPunctuation = isMarkdownPunctuation(after);
    const left = !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation);
    const right = !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation);
    if (marker === '~') {
      if (length >= 2) runs.push({ marker, length: 2, canOpen: left, canClose: right });
    } else if (marker === '_') {
      runs.push({
        marker,
        length,
        canOpen: left && (!right || beforePunctuation),
        canClose: right && (!left || afterPunctuation),
      });
    } else {
      runs.push({ marker, length, canOpen: left, canClose: right });
    }
    index = end;
  }
  return runs;
}

function closeEmphasis(text) {
  const open = [];
  for (const run of scanEmphasisRuns(maskCode(text))) {
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
    if (length > 0 && run.canOpen) open.push({ marker: run.marker, length });
  }
  let healed = text;
  for (let index = open.length - 1; index >= 0; index -= 1) {
    healed += open[index].marker.repeat(Math.min(open[index].length, 3));
  }
  return healed;
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

export function healStreamingMarkdownTail(text, isPendingLocalPath) {
  const value = String(text ?? '');
  const hasSyntax = HEALABLE_MARKDOWN_SYNTAX.test(value);
  if (!value || (!hasSyntax && !isPendingLocalPath) || hasOpenFence(value)) return value;
  const healed = hasSyntax
    ? closeEmphasis(healIncompleteLink(closeInlineCode(value, isPendingLocalPath), isPendingLocalPath))
    : value;
  // Only an unfinished final token can still grow into a compact file link.
  // Reuse the renderer's path grammar; code and completed links stay intact.
  const tail = isPendingLocalPath ? /\S+$/.exec(maskCode(healed)) : null;
  return tail && isPendingLocalPath(tail[0]) ? healed.slice(0, tail.index) : healed;
}
