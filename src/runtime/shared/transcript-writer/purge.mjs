/**
 * transcript-writer/purge.mjs — removal of one deleted session's transcript.
 *
 * Per id, no folder scan: the paths this process's writers have used for the
 * id, plus the paths the caller's known session cwds map to. A purged id is
 * remembered so a still-running writer of the deleted session cannot recreate
 * its file (session ids are never reused).
 */
import { unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { discardBuffered } from '../buffered-appender.mjs';
import { cwdToProjectSlug } from './transcript-file.mjs';

const MAX_TRACKED_SESSIONS = 4096;
const knownPaths = new Map(); // sessionId -> Set<transcriptPath>
const purgedSessions = new Set();

function boundedAdd(set, value) {
  set.delete(value);
  set.add(value);
  if (set.size > MAX_TRACKED_SESSIONS) set.delete(set.values().next().value);
}

/** A writer of `sessionId` appends to `transcriptPath`. */
export function noteSessionTranscript(sessionId, transcriptPath) {
  let paths = knownPaths.get(sessionId);
  if (!paths) {
    paths = new Set();
    knownPaths.delete(sessionId);
    knownPaths.set(sessionId, paths);
    if (knownPaths.size > MAX_TRACKED_SESSIONS) knownPaths.delete(knownPaths.keys().next().value);
  }
  paths.add(transcriptPath);
}

export function isSessionTranscriptPurged(sessionId) {
  return purgedSessions.has(sessionId);
}

function removeFile(path) {
  discardBuffered(path);
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/**
 * Delete `<id>.jsonl` (and its rotated `.1`) of the session. Returns every
 * primary transcript path considered (existing or not) so the caller can drop
 * the memory ingest offsets keyed by them. A file that cannot be removed is
 * reported through `onError` and does not stop the others.
 */
export function purgeSessionTranscripts({ mixdogHome, sessionId, cwds = [], onError = () => {} }) {
  if (!sessionId) return [];
  boundedAdd(purgedSessions, sessionId);
  const paths = new Set(knownPaths.get(sessionId) || []);
  for (const cwd of cwds) {
    if (typeof cwd !== 'string' || !cwd) continue;
    paths.add(join(mixdogHome, 'projects', cwdToProjectSlug(resolve(cwd)), `${sessionId}.jsonl`));
  }
  knownPaths.delete(sessionId);
  for (const path of paths) {
    for (const target of [path, `${path}.1`]) {
      try {
        removeFile(target);
      } catch (error) {
        onError(target, error);
      }
    }
  }
  return [...paths];
}
