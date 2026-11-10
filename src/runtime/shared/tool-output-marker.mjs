// One marker vocabulary for every non-shell tool output that is not the whole
// answer. Two shapes, never mixed:
//   window  `[lines a-b of N; offset:N for more]`  the agent asked for this slice
//   cap     `[output capped at X KB; …; offset:N for more]`  the tool cut it
// A cap marker always carries the continuation (offset / cursor, else narrowing
// advice) and, when the complete output was saved, `full output: <path>`.

export function formatCapSize(bytes) {
  const n = Number(bytes);
  if (n < 1024) return `${Math.max(0, Math.trunc(n))} bytes`;
  const kb = n / 1024;
  return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} KB`;
}

/**
 * Requested window: `[lines 5-27 of 90; offset:28 for more]` (no continuation
 * at the end). `capBytes` marks a window the byte cap shortened:
 * `[lines 5-27 of 90; output capped at 50 KB; offset:28 for more]`.
 */
export function windowMarker({
  unit = 'lines',
  from,
  to,
  total = null,
  nextOffset = null,
  capBytes = null,
  offsetKey = 'offset',
}) {
  const of = total == null ? '' : ` of ${total}`;
  const cap = capBytes == null ? '' : `; output capped at ${formatCapSize(capBytes)}`;
  const more = nextOffset == null ? '' : `; ${offsetKey}:${nextOffset} for more`;
  return `[${unit} ${from}-${to}${of}${cap}${more}]`;
}

/**
 * Cap hit. `limit` is bytes (number) or a ready label ("500 rows"). `shown`
 * says what survived. Continuation is `nextOffset`, else `cursor`, else
 * `narrow` advice (a default is supplied so it is never missing).
 */
export function capMarker({
  limit,
  shown = '',
  nextOffset = null,
  offsetKey = 'offset',
  cursor = null,
  narrow = '',
  fullPath = '',
}) {
  const parts = [`output capped at ${typeof limit === 'number' ? formatCapSize(limit) : limit}`];
  if (shown) parts.push(shown);
  if (nextOffset != null) parts.push(`${offsetKey}:${nextOffset} for more`);
  else if (cursor != null) parts.push(`cursor:${cursor} for more`);
  if (narrow || (nextOffset == null && cursor == null)) {
    parts.push(`narrow: ${narrow || 'restrict the path, pattern or scope'}`);
  }
  if (fullPath) parts.push(`full output: ${fullPath}`);
  return `[${parts.join('; ')}]`;
}
