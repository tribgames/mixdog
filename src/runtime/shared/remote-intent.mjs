// Durable channel-link record (channel-remote-intent.json), read-side.
//
// The daemon's channel transport OWNS this file (writes/clears it); everything
// else only asks one question: "which session is pinned to the channel?".
// That session reclaims its link on boot
// instead of waiting for a manual toggle — the reconnect path that used to
// look like the channel had silently unlinked itself.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveRuntimeRoot } from './runtime-root.mjs';

export function remoteIntentPath(root = resolveRuntimeRoot()) {
  return join(root, 'channel-remote-intent.json');
}

export function readRemoteIntent(path = remoteIntentPath()) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const sessionId = String(value?.sessionId || '').trim();
    const transcriptPath = String(value?.transcriptPath || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !transcriptPath) return null;
    return {
      sessionId,
      transcriptPath,
      cwd: value?.cwd == null ? null : String(value.cwd),
    };
  } catch {
    return null;
  }
}

// cwd is compared only when the record carries one: the intent is session
// pinned, and a resumed session keeps its id across restarts.
export function remoteIntentMatchesSession(sessionId, cwd = null, path = undefined) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  const intent = readRemoteIntent(path);
  if (!intent || intent.sessionId !== id) return false;
  if (intent.cwd && cwd) {
    try {
      if (resolve(intent.cwd) !== resolve(cwd)) return false;
    } catch {
      return false;
    }
  }
  return true;
}
