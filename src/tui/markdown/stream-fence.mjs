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
