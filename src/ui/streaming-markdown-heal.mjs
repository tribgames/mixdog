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

function closeInlineCode(text) {
  let open = 0;
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
    if (!open) open = run;
    else if (run === open) open = 0;
    index = end;
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
  for (let index = 0; index < masked.length;) {
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

function healIncompleteLink(text) {
  const masked = maskCode(text);
  const open = masked.lastIndexOf('[');
  if (open < 0) return text;
  const start = open > 0 && masked[open - 1] === '!' ? open - 1 : open;
  const label = masked.indexOf(']', open);
  if (label < 0) return `${text.slice(0, start)}${text.slice(open + 1)}`;
  if (masked[label + 1] !== '(' || masked.indexOf(')', label + 1) >= 0) return text;
  return `${text.slice(0, start)}${text.slice(open + 1, label)}`;
}

export function healStreamingMarkdownTail(text) {
  const value = String(text ?? '');
  if (!value || !HEALABLE_MARKDOWN_SYNTAX.test(value) || hasOpenFence(value)) return value;
  return closeEmphasis(healIncompleteLink(closeInlineCode(value)));
}
