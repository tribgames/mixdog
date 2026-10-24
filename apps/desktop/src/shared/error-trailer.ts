// One JSON trailer on an Error's message, for what a message-only hop would
// drop: Electron's IPC and `contextBridge` hand the page only `message` and
// `stack`, never `code` or `details`. The worktree failures carry their
// details this way (worktree-validation.ts writes it, worktree-branch-model.ts
// reads it), and room and schedule refusals carry their `{ code, params }`.
// This module is the framing only; each caller validates its own payload.

/** The marker keeps its original worktree wording: that wire format is fixed. */
export const ERROR_TRAILER_MARKER = '\n[worktree-details] ';

/** `message` with `payload` as its trailer; the message itself when it
 *  already has a trailer, the payload does not serialize, or its JSON is
 *  longer than `maxChars`. */
export function appendErrorTrailer(message: string, payload: unknown, maxChars = Number.POSITIVE_INFINITY): string {
  if (message.includes(ERROR_TRAILER_MARKER)) return message;
  try {
    const text = JSON.stringify(payload);
    return text !== undefined && text.length <= maxChars ? `${message}${ERROR_TRAILER_MARKER}${text}` : message;
  } catch {
    return message;
  }
}

/** `message` with the coded `{ code, params }` payload as its trailer, always
 *  appended: the message's own text may hold the marker, and the serialized
 *  JSON never holds a raw newline, so the last marker is this one. */
export function appendCodedTrailer(message: string, payload: { code: string; params?: unknown }): string {
  return `${message}${ERROR_TRAILER_MARKER}${JSON.stringify(payload)}`;
}

/** The text before the first (or, with `last`, the last) trailer marker and
 *  the JSON after it (null when that is not valid JSON), or null when there
 *  is no marker. */
export function splitErrorTrailer(text: string, { last = false } = {}): { message: string; payload: unknown } | null {
  const at = last ? text.lastIndexOf(ERROR_TRAILER_MARKER) : text.indexOf(ERROR_TRAILER_MARKER);
  if (at < 0) return null;
  try {
    return { message: text.slice(0, at), payload: JSON.parse(text.slice(at + ERROR_TRAILER_MARKER.length)) };
  } catch {
    return { message: text.slice(0, at), payload: null };
  }
}

export interface CodedTrailer {
  message: string;
  code: string;
  params?: Record<string, unknown>;
}

/** The `{ code, params }` trailer of `error`'s message, only when its code is
 *  in `allowed` and its params (if any) are an object; any other trailer, a
 *  malformed one, or none leaves the message to be read as it is. */
export function readCodedTrailer(error: unknown, allowed: ReadonlySet<string>): CodedTrailer | null {
  const text = (error as { message?: unknown } | null | undefined)?.message;
  const split = typeof text === 'string' ? splitErrorTrailer(text, { last: true }) : null;
  const payload = split?.payload;
  if (!split || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { code, params } = payload as { code?: unknown; params?: unknown };
  if (typeof code !== 'string' || !allowed.has(code)) return null;
  if (params === undefined) return { message: split.message, code };
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  return { message: split.message, code, params: params as Record<string, unknown> };
}

/** The `code` an error carries: its own, else its trailer's when `allowed`. */
export function carriedErrorCode(error: unknown, allowed: ReadonlySet<string>): unknown {
  const own = (error as { code?: unknown } | null | undefined)?.code;
  return typeof own === 'string' ? own : readCodedTrailer(error, allowed)?.code;
}

/** The `details` an error carries: its own, else its trailer's params. */
export function carriedErrorDetails(error: unknown, allowed: ReadonlySet<string>): unknown {
  return (error as { details?: unknown } | null | undefined)?.details ?? readCodedTrailer(error, allowed)?.params;
}
