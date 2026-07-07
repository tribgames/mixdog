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
 * ink/JSX render stack. Ref: earendil-works/pi packages/tui/src/components/markdown.ts.
 */
export function trimPartialClosingFences(tokens) {
  const token = tokens?.[tokens.length - 1];
  if (!token) return;
  if (token.type === 'list') {
    const items = token.items ?? [];
    trimPartialClosingFences(items[items.length - 1]?.tokens ?? []);
    return;
  }
  if (token.type === 'blockquote') {
    trimPartialClosingFences(token.tokens ?? []);
    return;
  }
  if (token.type !== 'code') return;
  const marker = /^(`{3,}|~{3,})/.exec(token.raw ?? '')?.[1];
  const lastLine = String(token.raw ?? '').split('\n').pop();
  if (!marker || !lastLine) return;
  // Only trim a partial fence: shorter than the opening marker and made up
  // solely of the same fence char. A complete closing fence is left intact.
  if (lastLine.length >= marker.length || lastLine !== marker[0].repeat(lastLine.length)) return;
  token.text = String(token.text ?? '').slice(0, -lastLine.length).replace(/\n$/, '');
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

function isClosingFence(line, char, openLen) {
  const m = CLOSE_FENCE_RE.exec(line);
  if (!m) return false;
  const run = m[1];
  // marked closes on ` {0,3}\1[~`]* *`: the run must begin with the exact opening
  // marker (openLen × openChar); trailing chars may be the OPPOSITE fence char
  // (e.g. ``` closed by ```~~), so only the prefix is constrained.
  return run.startsWith(char.repeat(openLen));
}

export function findOpenFenceStart(text) {
  const value = String(text ?? '');
  let open = null;
  let start = 0;
  for (let i = 0; i <= value.length; i++) {
    if (i !== value.length && value[i] !== '\n') continue;
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
  // Only fast-path unambiguously top-level (column-0) fences.
  if (!open || open.indent !== 0) return null;
  return { index: open.index, lang: open.lang };
}
