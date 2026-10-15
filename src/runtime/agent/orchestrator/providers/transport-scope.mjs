// transport-scope.mjs — a send's transport state scope, apart from its
// session identity. Providers key their session-scoped transport and
// continuation state (pooled sockets and their previous_response_id anchor,
// Codex turn-state routing tokens, sticky HTTP fallback, Cursor runs and
// conversations) by `opts.transportScope || opts.sessionId`, while prompt
// cache routing (prompt_cache_key, handshake session id) stays on
// `opts.sessionId`. A request forked from a session (/btw) runs in a scope of
// its own: it shares the session's prompt cache but reads and writes none of
// its transport state, and its scope is disposed once it is answered.
import { randomUUID } from 'node:crypto';

/** The reason a scope's provider connections are closed when it is disposed. */
export const TRANSPORT_SCOPE_DISPOSED = 'transport_scope_disposed';

/** A fresh transport scope for one request forked from `sessionId`. */
export function forkTransportScope(sessionId, label = 'fork') {
  return `${sessionId}#${label}:${randomUUID()}`;
}

/** Close every connection and drop every transport record of `scope`. */
export function disposeTransportScope(scope, provider) {
  if (!scope) return;
  try {
    globalThis.__mixdogCloseProviderConnectionsForSession?.(scope, TRANSPORT_SCOPE_DISPOSED);
  } finally {
    provider?.releaseTransportScope?.(scope);
  }
}
