// A session's own artifact directory, `<data>/tool-results/<sessionId>/`: the
// offloaded tool outputs live there, and deleting the session purges it (the
// purge hook in session/tool-result-offload.mjs removes its `.txt` files).
import { join } from 'node:path';
import { resolvePluginData } from './plugin-paths.mjs';

// Sanitize sessionId before using it as a path segment. A raw `..` or slash
// would let the sidecar dir — and clearOffloadSession's readdir+unlink — escape
// the tool-results root (arbitrary .txt deletion). Strip to [A-Za-z0-9_-];
// dropping '.' collapses '..' to '__'. Real ids are sess_<digits>, unaffected.
export function safeSessionSegment(sessionId) {
  return (
    String(sessionId ?? '')
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 200) || '_invalid'
  );
}

export function toolResultsSessionDir(sessionId) {
  return join(resolvePluginData(), 'tool-results', safeSessionSegment(sessionId));
}
