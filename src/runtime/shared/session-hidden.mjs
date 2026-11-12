// Sessions the daemon itself hides from its lists (session id → epoch-ms
// stamp), whether or not a desktop is attached. The session file stays; the
// desktop's archive view follows this set when a desktop is there.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseJsonText, writeJsonAtomicAsync } from './atomic-file.mjs';
import { resolvePluginData } from './plugin-paths.mjs';

const FILE = 'session-hidden.json';
let loaded = null; // { file, ids }

function state() {
  const file = join(resolvePluginData(), FILE);
  if (loaded?.file === file) return loaded;
  let ids = {};
  try {
    const raw = parseJsonText(readFileSync(file, 'utf8'))?.hidden;
    if (raw && typeof raw === 'object') ids = { ...raw };
  } catch (error) {
    if (error?.code !== 'ENOENT') process.stderr.write(`[session-hidden] ${file} unreadable: ${error.message}\n`);
  }
  loaded = { file, ids, writing: Promise.resolve() };
  return loaded;
}

/** id → stamp of every session the daemon hides. */
export function daemonHiddenSessions() {
  return { ...state().ids };
}

// One write at a time, each of the set as it is when that write starts: the
// file never ends on an older set than the one in memory.
function persist(current) {
  const write = () => writeJsonAtomicAsync(current.file, { version: 1, hidden: current.ids });
  const written = current.writing.then(write, write);
  current.writing = written.catch(() => {});
  return written;
}

/** Forgets ids whose session was deleted, so the set never outgrows the stored
 *  sessions. Resolves how many it held. */
export async function forgetHidden(sessionIds) {
  const current = state();
  let held = 0;
  for (const id of sessionIds) {
    if (current.ids[id] === undefined) continue;
    delete current.ids[id];
    held += 1;
  }
  if (held) await persist(current);
  return held;
}

/** Hides the ids; rejects when the set could not be written (they stay hidden
 *  for this run only). */
export async function hideInDaemon(sessionIds) {
  const current = state();
  const at = Date.now();
  for (const id of sessionIds) current.ids[id] ??= at;
  await persist(current);
}

/** A session that is used again is listed again. */
export async function unhideInDaemon(sessionId) {
  const current = state();
  if (current.ids[sessionId] === undefined) return;
  delete current.ids[sessionId];
  await persist(current);
}
