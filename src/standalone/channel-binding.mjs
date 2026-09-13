import { readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';

export const ACTIVATE_TOOL = 'activate_channel_bridge';
export const REBIND_TOOL = 'rebind_current_transcript';
export const BINDING_TOOLS = new Set([ACTIVATE_TOOL, REBIND_TOOL]);

export function remoteSessionIdFromBinding(name, args) {
  if (!BINDING_TOOLS.has(name) || !args || typeof args !== 'object') return null;
  const explicit = String(args.sessionId || '').trim();
  if (/^[A-Za-z0-9_-]+$/.test(explicit)) return explicit;
  const transcriptPath = String(args.transcriptPath || '').trim();
  if (!transcriptPath) return null;
  const inferred = basename(transcriptPath).replace(/\.[^.]+$/, '');
  return /^[A-Za-z0-9_-]+$/.test(inferred) ? inferred : null;
}

export function normalizeRemoteIntent(value) {
  if (!value || typeof value !== 'object') return null;
  const sessionId = String(value.sessionId || '').trim();
  const transcriptPath = String(value.transcriptPath || '').trim();
  const cwd = value.cwd == null ? null : String(value.cwd);
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !transcriptPath) return null;
  const inferredSessionId = basename(transcriptPath).replace(/\.[^.]+$/, '');
  if (inferredSessionId !== sessionId) return null;
  return {
    version: 1,
    sessionId,
    transcriptPath,
    cwd,
    updatedAt: Number(value.updatedAt) || Date.now(),
  };
}

export function readRemoteIntent(path) {
  if (!path) return null;
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    // An unreadable file is not proof of a malformed binding. Preserve it and
    // report the original I/O failure rather than silently deleting user state.
    throw error;
  }
  try {
    const intent = normalizeRemoteIntent(JSON.parse(raw));
    if (!intent) {
      try { rmSync(path, { force: true }); } catch {}
      return null;
    }
    return intent;
  } catch {
    try { rmSync(path, { force: true }); } catch {}
    return null;
  }
}
