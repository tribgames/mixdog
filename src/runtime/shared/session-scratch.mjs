// Per-session scratch directory under Mixdog's data directory. Processes the
// `shell` tool starts see it as TEMP/TMP/TMPDIR, so scratch files never land in
// the project, and it is removed with its session (session-delete.mjs).
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePluginData } from './plugin-paths.mjs';

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** The session's scratch path (not created), or '' for an unusable id. */
export function sessionScratchDir(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId : '';
  return SESSION_ID.test(id) ? join(resolvePluginData(), 'scratch', id) : '';
}

/** Create the session's scratch directory if absent; returns its path ('' without a session id). */
export function ensureSessionScratchDir(sessionId) {
  const dir = sessionScratchDir(sessionId);
  if (dir) mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeSessionScratchDir(sessionId) {
  const dir = sessionScratchDir(sessionId);
  if (dir) rmSync(dir, { recursive: true, force: true });
}

/** Point an env's temp variables at the session's scratch directory. */
export function applySessionScratchEnv(env, sessionId) {
  const dir = ensureSessionScratchDir(sessionId);
  if (dir) {
    env.TEMP = dir;
    env.TMP = dir;
    env.TMPDIR = dir;
  }
  return env;
}
