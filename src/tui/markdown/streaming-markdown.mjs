/**
 * Pure streaming-markdown layout shared by StreamingMarkdown (render) and row
 * estimation (measure). Stable-prefix state is keyed by streamKey (assistant id).
 */
import { marked } from 'marked';
import { configureMarked, hasMarkdownSyntax } from './render-ansi.mjs';
import { trimPartialClosingFences } from './stream-fence.mjs';

const stablePrefixByStreamKey = new Map();
const STABLE_PREFIX_LRU_MAX = 32;

/** Lockstep with App streaming row estimate (leading/trailing newline trim). */
export function streamingLayoutText(text) {
  return String(text ?? '').replace(/^\n+|\n+$/g, '');
}

function isWhitespaceOnlyText(text) {
  return !String(text ?? '').trim();
}

function touchStablePrefixKey(key, value) {
  if (!key) return;
  if (stablePrefixByStreamKey.has(key)) stablePrefixByStreamKey.delete(key);
  stablePrefixByStreamKey.set(key, value);
  while (stablePrefixByStreamKey.size > STABLE_PREFIX_LRU_MAX) {
    const oldest = stablePrefixByStreamKey.keys().next().value;
    if (oldest === undefined) break;
    stablePrefixByStreamKey.delete(oldest);
  }
}

function getStablePrefixKey(key) {
  if (!key || !stablePrefixByStreamKey.has(key)) return '';
  const value = stablePrefixByStreamKey.get(key);
  stablePrefixByStreamKey.delete(key);
  stablePrefixByStreamKey.set(key, value);
  return value;
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

function hasOpenInlineCode(text) {
  let count = 0;
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch !== '`') continue;
    let run = 1;
    while (value[i + run] === '`') run += 1;
    if (run === 1) count += 1;
    i += run - 1;
  }
  return count % 2 === 1;
}

function hasUnclosedDelimiter(text, marker) {
  let count = 0;
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\') {
      i += 1;
      continue;
    }
    if (value.startsWith(marker, i)) {
      count += 1;
      i += marker.length - 1;
    }
  }
  return count % 2 === 1;
}

export function balanceStreamingMarkdown(text) {
  const value = String(text ?? '');
  if (!value || hasOpenFence(value)) return value;
  if (hasOpenInlineCode(value)) return `${value}\``;
  let rendered = value;
  if (hasUnclosedDelimiter(rendered, '**')) rendered += '**';
  if (hasUnclosedDelimiter(rendered, '__')) rendered += '__';
  return rendered;
}

export function resetStreamingMarkdownStablePrefix(streamKey) {
  if (streamKey == null || streamKey === '') return;
  stablePrefixByStreamKey.delete(String(streamKey));
}

export function resetAllStreamingMarkdownStablePrefixes() {
  stablePrefixByStreamKey.clear();
}

export function resolveStreamingMarkdownParts(text, streamKey) {
  const t = streamingLayoutText(text);
  const key = streamKey == null || streamKey === '' ? null : String(streamKey);

  if (!t) {
    if (key) stablePrefixByStreamKey.delete(key);
    return {
      plain: true,
      stablePrefix: '',
      unstableSuffix: '',
      unstableForRender: '',
    };
  }

  if (!hasMarkdownSyntax(t)) {
    if (key) stablePrefixByStreamKey.delete(key);
    return {
      plain: true,
      stablePrefix: '',
      unstableSuffix: t,
      unstableForRender: t,
    };
  }

  let stablePrefix = key ? getStablePrefixKey(key) : '';
  if (!t.startsWith(stablePrefix)) {
    stablePrefix = '';
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
      if (key && stablePrefix) touchStablePrefixKey(key, stablePrefix);
      else if (key && !stablePrefix) stablePrefixByStreamKey.delete(key);
    }
  } catch {
    stablePrefix = '';
    if (key) stablePrefixByStreamKey.delete(key);
  }

  if (isWhitespaceOnlyText(stablePrefix)) stablePrefix = '';

  const unstableSuffix = t.substring(stablePrefix.length);
  return {
    plain: false,
    stablePrefix,
    unstableSuffix,
    unstableForRender: balanceStreamingMarkdown(unstableSuffix),
  };
}
