/**
 * Pure streaming-markdown layout shared by StreamingMarkdown (render) and row
 * estimation (measure). Stable-prefix state is keyed by streamKey (assistant id).
 */
import { marked } from 'marked';
import { configureMarked, hasMarkdownSyntax } from './render-ansi.mjs';
import {
  trimPartialClosingFences,
  findOpenFenceStart,
  resetAllOpenFenceScans,
  resetOpenFenceScan,
} from './stream-fence.mjs';
import { displayWidth } from '../display-width.mjs';

const stablePrefixByStreamKey = new Map();
const markdownSyntaxByStreamKey = new Map();
const plainWindowSyntaxByStreamKey = new Map();
// Reuse the current normalized-text split across measure → render → harvest.
const resolvedPartsByStreamKey = new Map();
const STABLE_PREFIX_LRU_MAX = 32;

/** Lockstep with App streaming row estimate (leading/trailing newline trim). */
export function streamingLayoutText(text) {
  return String(text ?? '').replace(/^\n+|\n+$/g, '');
}

export function windowPlainStreamingText(text, columns, maxRows, streamKey = null) {
  const value = streamingLayoutText(text);
  const rowBudget = Math.max(0, Math.floor(Number(maxRows) || 0));
  const key = streamKey == null || streamKey === '' ? null : String(streamKey);
  if (!value || rowBudget <= 0 || cachedStreamingHasMarkdownSyntax(
    plainWindowSyntaxByStreamKey,
    value,
    key,
  )) return value;
  const width = Math.max(1, Math.floor(Number(columns) || 80));
  let rows = 0;
  let end = value.length;
  let start = end;
  while (end >= 0) {
    const newline = value.lastIndexOf('\n', end - 1);
    const lineStart = newline + 1;
    const line = value.slice(lineStart, end);
    const lineRows = Math.max(1, Math.ceil(displayWidth(line) / width));
    if (rows > 0 && rows + lineRows > rowBudget) break;
    rows += lineRows;
    start = lineStart;
    if (rows >= rowBudget || newline < 0) break;
    end = newline;
  }
  return start > 0 ? value.slice(start) : value;
}

function isWhitespaceOnlyText(text) {
  return !String(text ?? '').trim();
}

function touchLruKey(cache, key, value) {
  if (!key) return;
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > STABLE_PREFIX_LRU_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function touchStablePrefixKey(key, value) {
  touchLruKey(stablePrefixByStreamKey, key, value);
}

function getStablePrefixKey(key) {
  if (!key || !stablePrefixByStreamKey.has(key)) return { text: '', chunks: [] };
  const value = stablePrefixByStreamKey.get(key);
  touchStablePrefixKey(key, value);
  return value;
}

function stableStateForText(text, previous) {
  if (!text) return { text: '', chunks: [] };
  if (text.startsWith(previous.text)) {
    const appended = text.substring(previous.text.length);
    return appended
      ? { text, chunks: [...previous.chunks, appended] }
      : previous;
  }
  return { text, chunks: [text] };
}

function cachedStreamingHasMarkdownSyntax(cache, text, key) {
  if (!key) return hasMarkdownSyntax(text);
  const previous = cache.get(key);
  let value;
  if (previous && text.startsWith(previous.text)) {
    if (previous.value) {
      value = true;
    } else {
      const lineStart = previous.text.lastIndexOf('\n') + 1;
      value = hasMarkdownSyntax(text.substring(Math.max(0, lineStart - 1)));
    }
  } else {
    value = hasMarkdownSyntax(text);
  }
  touchLruKey(cache, key, { text, value });
  return value;
}

function streamingHasMarkdownSyntax(text, key) {
  return cachedStreamingHasMarkdownSyntax(markdownSyntaxByStreamKey, text, key);
}

function getResolvedPartsKey(key, text) {
  if (!key) return null;
  const entry = resolvedPartsByStreamKey.get(key);
  if (!entry || entry.text !== text) return null;
  return entry.parts;
}

function cacheResolvedPartsKey(key, text, parts) {
  if (!key) return parts;
  if (resolvedPartsByStreamKey.has(key)) resolvedPartsByStreamKey.delete(key);
  resolvedPartsByStreamKey.set(key, { text, parts });
  while (resolvedPartsByStreamKey.size > STABLE_PREFIX_LRU_MAX) {
    const oldest = resolvedPartsByStreamKey.keys().next().value;
    if (oldest === undefined) break;
    resolvedPartsByStreamKey.delete(oldest);
  }
  return parts;
}

function hasOpenFence(text) {
  let ticks = 0;
  let tildes = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*```/.test(line)) ticks += 1;
    if (/^\s*~~~/.test(line)) tildes += 1;
  }
  return ticks % 2 === 1 || tildes % 2 === 1;
}

const FENCED_BLOCK_RE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm;
const INLINE_CODE_SPAN_RE = /`+[^`\n]*`+/g;
const EMPHASIS_MARKERS = new Set(['*', '_', '~']);
const MARKDOWN_PUNCTUATION_RE = /[!-/:-@[-`{-~\u00a1-\u00bf\u2010-\u2027\u2030-\u205e]/;
const HEALABLE_SYNTAX_RE = /[`*_~[]/;

/** Close an inline code span the model has not finished typing. */
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

// Delimiter counting must ignore code, where `**` and `_` are ordinary
// characters. Masking preserves length, so it stays a pure counting aid.
function maskCode(text) {
  FENCED_BLOCK_RE.lastIndex = 0;
  INLINE_CODE_SPAN_RE.lastIndex = 0;
  return text
    .replace(FENCED_BLOCK_RE, (block) => block.replace(/[^\n]/g, ' '))
    .replace(INLINE_CODE_SPAN_RE, (span) => ' '.repeat(span.length));
}

function isMarkdownSpace(character) {
  return !character || /\s/.test(character);
}

function isMarkdownPunctuation(character) {
  return Boolean(character) && MARKDOWN_PUNCTUATION_RE.test(character);
}

// CommonMark flanking rules, so a literal "2 * 3", a "* item" bullet, or an
// intraword snake_case is never mistaken for an unfinished emphasis run.
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
      // GFM strikethrough only exists as a pair.
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
      // Delimiters opened INSIDE the span this closer terminates can never be
      // closed any more, so they leave with it.
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

// Text-only link healing: an unfinished link or image reads as its label until
// the destination closes, instead of showing "[docs](https://exa" and snapping.
function healIncompleteLink(text) {
  const masked = maskCode(text);
  const open = masked.lastIndexOf('[');
  if (open < 0) return text;
  const start = open > 0 && masked[open - 1] === '!' ? open - 1 : open;
  const label = masked.indexOf(']', open);
  if (label < 0) return `${text.slice(0, start)}${text.slice(open + 1)}`;
  // A reference use ("[docs][1]") or a task-list box stays exactly as typed.
  if (masked[label + 1] !== '(') return text;
  if (masked.indexOf(')', label + 1) >= 0) return text;
  return `${text.slice(0, start)}${text.slice(open + 1, label)}`;
}

/**
 * Close the inline markers the model has not finished typing yet, so `**계획`
 * renders bold WHILE it streams instead of showing raw markers that snap into
 * style when the closer lands. Emphasis (`*`, `_`, `~~`), inline code and
 * unfinished links are all healed — the same contract as the desktop pipeline.
 */
export function balanceStreamingMarkdown(text) {
  const value = String(text ?? '');
  if (!value || !HEALABLE_SYNTAX_RE.test(value) || hasOpenFence(value)) return value;
  return closeEmphasis(healIncompleteLink(closeInlineCode(value)));
}

export function resetStreamingMarkdownStablePrefix(streamKey) {
  if (streamKey == null || streamKey === '') return;
  const key = String(streamKey);
  stablePrefixByStreamKey.delete(key);
  markdownSyntaxByStreamKey.delete(key);
  plainWindowSyntaxByStreamKey.delete(key);
  resolvedPartsByStreamKey.delete(key);
  resetOpenFenceScan(key);
}

export function resetAllStreamingMarkdownStablePrefixes() {
  stablePrefixByStreamKey.clear();
  markdownSyntaxByStreamKey.clear();
  plainWindowSyntaxByStreamKey.clear();
  resolvedPartsByStreamKey.clear();
  resetAllOpenFenceScans();
}

export function resolveStreamingMarkdownParts(text, streamKey) {
  const t = streamingLayoutText(text);
  const key = streamKey == null || streamKey === '' ? null : String(streamKey);
  const cachedParts = getResolvedPartsKey(key, t);
  if (cachedParts) return cachedParts;

  if (!t) {
    if (key) stablePrefixByStreamKey.delete(key);
    return cacheResolvedPartsKey(key, t, {
      plain: true,
      stablePrefix: '',
      stableChunks: [],
      unstableSuffix: '',
      unstableForRender: '',
    });
  }

  if (!streamingHasMarkdownSyntax(t, key)) {
    if (key) stablePrefixByStreamKey.delete(key);
    return cacheResolvedPartsKey(key, t, {
      plain: true,
      stablePrefix: '',
      stableChunks: [],
      unstableSuffix: t,
      unstableForRender: t,
    });
  }

  let stableState = key ? getStablePrefixKey(key) : { text: '', chunks: [] };
  if (!t.startsWith(stableState.text)) {
    stableState = { text: '', chunks: [] };
  }
  let stablePrefix = stableState.text;

  // Open-fence fast path: never run marked.lexer on a growing unclosed code
  // block (its closing-fence regex never matches and backtracks over the whole
  // body every delta — the ~56ms/frame cost). Split cheaply at the fence line:
  // everything before it is settled markdown (lexed + cached once by the stable
  // <Markdown>), the open block is rendered flat until the closing fence lands.
  const open = findOpenFenceStart(t, key);
  if (open) {
    let openPrefix = t.substring(0, open.index);
    if (isWhitespaceOnlyText(openPrefix)) openPrefix = '';
    stableState = stableStateForText(openPrefix, stableState);
    if (key && openPrefix) touchStablePrefixKey(key, stableState);
    else if (key) stablePrefixByStreamKey.delete(key);
    const unstableSuffix = t.substring(openPrefix.length);
    return cacheResolvedPartsKey(key, t, {
      plain: false,
      openFence: true,
      stablePrefix: openPrefix,
      stableChunks: stableState.chunks,
      unstableSuffix,
      unstableForRender: unstableSuffix,
    });
  }

  try {
    configureMarked();
    const boundary = stablePrefix.length;
    const tokens = marked.lexer(t.substring(boundary));
    trimPartialClosingFences(tokens);
    let lastContentIdx = tokens.length - 1;
    while (lastContentIdx >= 0 && tokens[lastContentIdx]?.type === 'space') lastContentIdx -= 1;
    let firstContentIdx = 0;
    while (firstContentIdx < tokens.length && tokens[firstContentIdx]?.type === 'space') {
      firstContentIdx += 1;
    }
    let advance = 0;
    for (let i = firstContentIdx; i < lastContentIdx; i++) {
      advance += tokens[i]?.raw?.length ?? 0;
    }
    if (advance > 0) {
      stablePrefix = t.substring(0, boundary + advance);
      if (isWhitespaceOnlyText(stablePrefix)) stablePrefix = '';
      stableState = stableStateForText(stablePrefix, stableState);
      if (key && stablePrefix) touchStablePrefixKey(key, stableState);
      else if (key && !stablePrefix) stablePrefixByStreamKey.delete(key);
    }
  } catch {
    stablePrefix = '';
    stableState = { text: '', chunks: [] };
    if (key) stablePrefixByStreamKey.delete(key);
  }

  if (isWhitespaceOnlyText(stablePrefix)) {
    stablePrefix = '';
    stableState = { text: '', chunks: [] };
  }

  const unstableSuffix = t.substring(stablePrefix.length);
  return cacheResolvedPartsKey(key, t, {
    plain: false,
    stablePrefix,
    stableChunks: stableState.chunks,
    unstableSuffix,
    unstableForRender: balanceStreamingMarkdown(unstableSuffix),
  });
}
