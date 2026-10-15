// In-process line diffs for the turn-change paths, bounded the way codex
// bounds its own: every file gets a short timeout, every operation (one tool
// call, one review or seal pass) a total budget. A file over the size limits,
// past its timeout or past the spent budget gets one replacement hunk between
// its common line prefix and suffix instead — still an exact patch that
// applies, only not a minimal one. Results are cached by content, so the same
// pair is not diffed again across calls and reviews.
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { formatPatch, structuredPatch } from 'diff';

/** Longest a single file's Myers diff may run (codex's per-file value). */
export const LINE_DIFF_FILE_TIMEOUT_MS = 100;
/** Total Myers diff time one operation may spend across its files. */
// Kept well under the lag target: an operation also renders, hashes and
// bounds its patches outside the diff itself.
export const LINE_DIFF_OPERATION_BUDGET_MS = 150;
// A side over either limit is never Myers-diffed.
const LINE_DIFF_MAX_CHARS = 1024 * 1024;
const LINE_DIFF_MAX_LINES = 20_000;
const CONTEXT_LINES = 3;
const CACHE_MAX_ENTRIES = 512;
// Cached hunks reference their texts: bound the cache by their length.
const CACHE_MAX_CHARS = 32 * 1024 * 1024;

/** One operation's diff budget; pass it to every lineDiffHunks call of it. */
export function createLineDiffBudget(totalMs = LINE_DIFF_OPERATION_BUDGET_MS) {
  return { remainingMs: totalMs };
}

const _cache = new Map();
let _cachedChars = 0;
const _hashByBytes = new WeakMap();

const sha1 = (value) => createHash('sha1').update(value).digest('hex');

/** Content hash of one side: a byte array is hashed once per object. A text
 *  hashes to the same id as its UTF-8 bytes; one that has no exact UTF-8 form
 *  (a lone surrogate) gets no id. */
function sideHash(source, text) {
  if (source && typeof source === 'object') {
    let hash = _hashByBytes.get(source);
    if (!hash) {
      hash = sha1(source);
      _hashByBytes.set(source, hash);
    }
    return hash;
  }
  return text.isWellFormed() ? sha1(text) : null;
}

function cacheKey(sources, oldText, newText) {
  const before = sideHash(sources[0], oldText);
  const after = before && sideHash(sources[1], newText);
  return after ? `${before}:${after}` : null;
}

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  _cache.delete(key);
  _cache.set(key, entry);
  return entry.result;
}

function cacheSet(key, result, chars) {
  if (chars > CACHE_MAX_CHARS) return;
  _cachedChars -= _cache.get(key)?.chars || 0;
  _cache.delete(key);
  _cache.set(key, { result, chars });
  _cachedChars += chars;
  while (_cache.size > CACHE_MAX_ENTRIES || _cachedChars > CACHE_MAX_CHARS) {
    const [oldest, entry] = _cache.entries().next().value;
    _cache.delete(oldest);
    _cachedChars -= entry.chars;
  }
}

function overLimits(text) {
  if (text.length > LINE_DIFF_MAX_CHARS) return true;
  let lines = 0;
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    lines += 1;
    if (lines > LINE_DIFF_MAX_LINES) return true;
  }
  return false;
}

/** Lines with their `\n` (the last one may lack it), as jsdiff tokenizes. */
function lineTokens(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const tokens = lines.map((line, index) => (index < lines.length - 1 ? `${line}\n` : line));
  if (tokens.at(-1) === '') tokens.pop();
  return tokens;
}

/** The one hunk replacing everything between the texts' common line prefix
 *  and suffix, with up to three context lines each side, in jsdiff's hunk
 *  shape (`\ No newline at end of file` included). */
function replacementHunks(oldText, newText) {
  const before = lineTokens(oldText);
  const after = lineTokens(newText);
  const shortest = Math.min(before.length, after.length);
  let start = 0;
  while (start < shortest && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < shortest - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  const lead = Math.min(CONTEXT_LINES, start);
  const trail = Math.min(CONTEXT_LINES, end);
  const lines = [];
  const push = (mark, tokens) => {
    for (const token of tokens) {
      if (token.endsWith('\n')) lines.push(mark + token.slice(0, -1));
      else lines.push(mark + token, '\\ No newline at end of file');
    }
  };
  push(' ', before.slice(start - lead, start));
  push('-', before.slice(start, before.length - end));
  push('+', after.slice(start, after.length - end));
  push(' ', before.slice(before.length - end, before.length - end + trail));
  const first = start - lead;
  return [
    {
      oldStart: first + 1,
      oldLines: before.length - end + trail - first,
      newStart: first + 1,
      newLines: after.length - end + trail - first,
      lines,
    },
  ];
}

/**
 * Hunks (context 3, jsdiff's structuredPatch shape) turning `oldText` into
 * `newText`: jsdiff's own when its diff finishes within the file timeout and
 * what is left of `budget` (`exact`), else the replacement hunk. `sources`
 * are the raw sides the texts came from (bytes or the texts), used only as
 * the cache key. The returned value is shared: never mutate it.
 */
export function lineDiffHunks(oldText, newText, budget, sources = [oldText, newText]) {
  if (oldText === newText) return { hunks: [], exact: true };
  const key = cacheKey(sources, oldText, newText);
  const cached = key ? cacheGet(key) || budget.fallbacks?.get(key) : null;
  if (cached) return cached;
  let result = null;
  // A fallback forced by the operation's spent budget is not this pair's own
  // outcome: it is not cached, so a later operation can still diff it.
  let repeatable = true;
  if (!overLimits(oldText) && !overLimits(newText)) {
    if (budget.remainingMs > 0) {
      const timeout = Math.min(LINE_DIFF_FILE_TIMEOUT_MS, budget.remainingMs);
      const startedAt = performance.now();
      const patch = structuredPatch('', '', oldText, newText, '', '', { context: CONTEXT_LINES, timeout });
      budget.remainingMs -= performance.now() - startedAt;
      if (patch) result = { hunks: patch.hunks, exact: true };
      else repeatable = timeout >= LINE_DIFF_FILE_TIMEOUT_MS;
    } else {
      repeatable = false;
    }
  }
  result ||= { hunks: replacementHunks(oldText, newText), exact: false };
  if (key && repeatable) cacheSet(key, result, oldText.length + newText.length);
  // Within its own operation it is final: the budget never grows back.
  else if (key) (budget.fallbacks ||= new Map()).set(key, result);
  return result;
}

/** The `--- `/`+++ ` headers and hunks of `hunks`, as jsdiff formats them,
 *  ending in exactly one newline. */
export function unifiedHunksBody(oldHeader, newHeader, hunks) {
  const generated = formatPatch({ oldFileName: oldHeader, newFileName: newHeader, oldHeader: '', newHeader: '', hunks });
  let end = generated.length;
  // Linear trim: a /\n*$/ regex rescans from every position of a large patch.
  while (end > 0 && generated.charCodeAt(end - 1) === 10) end -= 1;
  return `${generated.slice(generated.search(/^--- /m), end)}\n`;
}

export function _resetLineDiffCacheForTest() {
  _cache.clear();
  _cachedChars = 0;
}
