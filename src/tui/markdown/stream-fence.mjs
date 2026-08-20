/**
 * markdown/stream-fence.mjs — streamed partial closing-fence trimming.
 *
 * While a fenced code block is still streaming in, marked may briefly emit the
 * partial closing fence (a lone ` or ``) as a final code-block line, which makes
 * the rendered block grow then shrink as the remaining backticks arrive — a
 * visible flicker. `trimPartialClosingFences` strips that trailing partial fence
 * from the LAST code token (recursing through trailing list/blockquote nesting)
 * so the block height stays stable across deltas.
 *
 * Kept in its own dependency-free module so it can be unit-tested without the
 * ink/JSX render stack.
 */
// The opening run of a code token: three or more of ONE fence char at the very
// start of `raw`. An indented (list/blockquote-nested) fence never matches, so
// its block is left alone rather than trimmed against the wrong marker.
const OPENING_RUN_RE = /^([`~])\1*/;
const CONTAINER_DESCENT_MAX = 64;

/** The tail `code` token, descending through trailing containers, or null. */
function tailCodeToken(tokens) {
  let siblings = tokens;
  for (let depth = 0; depth < CONTAINER_DESCENT_MAX; depth += 1) {
    const token = Array.isArray(siblings) ? siblings[siblings.length - 1] : undefined;
    if (!token) return null;
    if (token.type === 'code') return token;
    if (token.type === 'blockquote') {
      siblings = token.tokens ?? [];
      continue;
    }
    if (token.type === 'list') {
      const items = token.items ?? [];
      siblings = items[items.length - 1]?.tokens ?? [];
      continue;
    }
    return null;
  }
  return null;
}

export function trimPartialClosingFences(tokens) {
  const token = tailCodeToken(tokens);
  if (!token) return;
  const raw = String(token.raw ?? '');
  const opening = OPENING_RUN_RE.exec(raw)?.[0] ?? '';
  if (opening.length < 3) return;
  const tail = raw.slice(raw.lastIndexOf('\n') + 1);
  // A run that reaches the opening length IS the real closing fence and is
  // marked's business; only a shorter run of the same char is half-arrived.
  if (!tail || tail.length >= opening.length) return;
  for (let at = 0; at < tail.length; at += 1) {
    if (tail[at] !== opening[0]) return;
  }
  const text = String(token.text ?? '');
  const kept = text.slice(0, Math.max(0, text.length - tail.length));
  token.text = kept.endsWith('\n') ? kept.slice(0, -1) : kept;
}

/**
 * Locate the currently-open (unclosed) fenced code block that is safe to split
 * off cheaply, or null. Returns { index, lang } where `index` is the byte offset
 * of the opening fence line's first char. Pure line scan (no marked.lexer), so a
 * growing open code block avoids marked's catastrophic never-matched-closer
 * backtracking every delta.
 *
 * Only a TOP-LEVEL fence (opening line at column 0) is reported: a col-0 fence
 * is always a fresh top-level block in CommonMark (list/blockquote content is
 * never at column 0), so everything before it is complete blocks and the split
 * is render-invariant. An indented (possibly list/blockquote-nested) open fence
 * returns null so the caller falls back to the correct full marked.lexer path.
 *
 * Fence rules are marked/CommonMark-aligned:
 *   - opening: 0–3 spaces indent, run of ≥3 same fence char; a backtick fence's
 *     info string may not contain a backtick;
 *   - closing: 0–3 spaces indent, a run of fence chars that STARTS with the exact
 *     opening marker (same char, ≥ opening length) and may continue with any mix
 *     of backticks/tildes (marked's `\1[~`]*`), followed only by spaces/tabs.
 */
const OPEN_FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE_RE = /^ {0,3}([`~]+)[ \t]*$/;
const OPEN_FENCE_SCAN_LRU_MAX = 32;
const openFenceScanByStreamKey = new Map();

function isClosingFence(line, char, openLen) {
  const m = CLOSE_FENCE_RE.exec(line);
  if (!m) return false;
  const run = m[1];
  // marked closes on ` {0,3}\1[~`]* *`: the run must begin with the exact opening
  // marker (openLen × openChar); trailing chars may be the OPPOSITE fence char
  // (e.g. ``` closed by ```~~), so only the prefix is constrained.
  return run.startsWith(char.repeat(openLen));
}

function scanOpenFence(value, startAt = 0, initialOpen = null) {
  let open = initialOpen;
  let start = startAt;
  const checkpointIndex = value.lastIndexOf('\n') + 1;
  let openBeforeCheckpoint = start === checkpointIndex ? open : null;
  for (let i = startAt; i <= value.length; i++) {
    if (i !== value.length && value[i] !== '\n') continue;
    if (start === checkpointIndex) openBeforeCheckpoint = open;
    const line = value.slice(start, i);
    if (!open) {
      const m = OPEN_FENCE_RE.exec(line);
      if (m) {
        const char = m[2][0];
        const info = m[3];
        // A backtick fence's info string may not contain a backtick.
        if (!(char === '`' && info.indexOf('`') !== -1)) {
          open = { index: start, indent: m[1].length, char, len: m[2].length, lang: info.trim() };
        }
      }
    } else if (isClosingFence(line, open.char, open.len)) {
      open = null;
    }
    start = i + 1;
  }
  return { open, checkpointIndex, openBeforeCheckpoint };
}

function touchOpenFenceScan(key, entry) {
  if (openFenceScanByStreamKey.has(key)) openFenceScanByStreamKey.delete(key);
  openFenceScanByStreamKey.set(key, entry);
  while (openFenceScanByStreamKey.size > OPEN_FENCE_SCAN_LRU_MAX) {
    const oldest = openFenceScanByStreamKey.keys().next().value;
    if (oldest === undefined) break;
    openFenceScanByStreamKey.delete(oldest);
  }
}

export function resetOpenFenceScan(streamKey) {
  if (streamKey == null || streamKey === '') return;
  openFenceScanByStreamKey.delete(String(streamKey));
}

export function resetAllOpenFenceScans() {
  openFenceScanByStreamKey.clear();
}

export function findOpenFenceStart(text, streamKey = null) {
  const value = String(text ?? '');
  const key = streamKey == null || streamKey === '' ? null : String(streamKey);
  const cached = key ? openFenceScanByStreamKey.get(key) : null;
  if (cached?.text === value) return cached.result;
  const scanned = cached && value.startsWith(cached.text)
    ? scanOpenFence(value, cached.checkpointIndex, cached.openBeforeCheckpoint)
    : scanOpenFence(value);
  // Only fast-path unambiguously top-level (column-0) fences.
  const result = !scanned.open || scanned.open.indent !== 0
    ? null
    : { index: scanned.open.index, lang: scanned.open.lang };
  if (key) touchOpenFenceScan(key, { text: value, ...scanned, result });
  return result;
}
