// Per-session scratch directory under Mixdog's data directory. Processes the
// `shell` tool starts see it as TEMP/TMP/TMPDIR, so scratch files never land in
// the project, and it is removed with its session (session-delete.mjs).
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePluginData } from './plugin-paths.mjs';

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

// The folder is named by a short digest of the id, not the id itself: a desktop
// session id is 77 characters, and a TEMP that long leaves too little of
// Windows' 260-character path limit for what runs under it (Git refuses a
// $GIT_DIR over 220 characters, LibreOffice crashes on a profile past ~150).
// The "." is a character no session id has, so no id's legacy folder (named
// after the id itself) can ever be another session's digest folder.
const scratchName = (id) => `s.${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;

/** The session's scratch path (not created), or '' for an unusable id. */
export function sessionScratchDir(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId : '';
  return SESSION_ID.test(id) ? join(resolvePluginData(), 'scratch', scratchName(id)) : '';
}

/** Create the session's scratch directory if absent; returns its path ('' without a session id). */
export function ensureSessionScratchDir(sessionId) {
  const dir = sessionScratchDir(sessionId);
  if (dir) mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeSessionScratchDir(sessionId) {
  const dir = sessionScratchDir(sessionId);
  if (!dir) return;
  rmSync(dir, { recursive: true, force: true });
  // Earlier versions named the folder after the full id.
  rmSync(join(resolvePluginData(), 'scratch', sessionId), { recursive: true, force: true });
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
