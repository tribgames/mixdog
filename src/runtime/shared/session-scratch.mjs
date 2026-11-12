// Per-session scratch directory under Mixdog's data directory. Processes the
// `shell` tool starts see it as TEMP/TMP/TMPDIR, so scratch files never land in
// the project, and it is removed with its session (session-delete.mjs).
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
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

const gone = (error) => error?.code === 'ENOENT';

// A link is removed as a link. A recursive `rmSync` deletes what a Windows
// junction points at (Node 24), and a session's processes make junctions in
// their TEMP — to a checkout's node_modules, for one — so the tree is walked
// here and nothing outside it is ever entered.
function removeLink(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (gone(error)) return;
    rmdirSync(path);
  }
}

function removeTree(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (gone(error)) return;
    throw error;
  }
  if (stat.isSymbolicLink()) return removeLink(path);
  if (!stat.isDirectory()) {
    try {
      unlinkSync(path);
    } catch (error) {
      if (!gone(error)) throw error;
    }
    return;
  }
  for (const name of readdirSync(path)) removeTree(join(path, name));
  try {
    rmdirSync(path);
  } catch (error) {
    if (!gone(error)) throw error;
  }
}

export function removeSessionScratchDir(sessionId) {
  const dir = sessionScratchDir(sessionId);
  if (!dir) return;
  removeTree(dir);
  // Earlier versions named the folder after the full id.
  removeTree(join(resolvePluginData(), 'scratch', sessionId));
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
