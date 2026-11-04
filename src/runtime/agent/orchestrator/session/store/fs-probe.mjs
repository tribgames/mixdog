/**
 * Existence probes that never conflate "not there" with "cannot look".
 *
 * `existsSync` returns false for EVERY stat failure — ENOENT, but also
 * EACCES/EIO/EBUSY/EPERM/ELOOP. Every store decision keyed on that boolean
 * therefore reads a temporarily unreadable file as a DELETED one: the sweep
 * queues its summary row for removal, sidecar rebuilds drop it, sidecars get
 * unlinked as orphans and in-memory state is allowed to stand in for it.
 * Absence is a fact; a failed probe is an unknown, and an unknown may never
 * authorize a deletion or a fallback.
 */
import { runFsStepsAsync, runFsStepsSync } from './fs-steps.mjs';

export const PROBE_PRESENT = 'present';
export const PROBE_ABSENT = 'absent';
const PROBE_UNREADABLE = 'unreadable';

// ONLY these mean "nothing is at this path". Everything else means a file is
// very likely there and we simply cannot look at it (same classification the
// session load path uses).
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

// The absent/unreadable verdict for a failed stat or read.
function _failureVerdict(err) {
  const code = err?.code || 'EUNKNOWN';
  return { state: ABSENT_CODES.has(code) ? PROBE_ABSENT : PROBE_UNREADABLE, code };
}

/**
 * `{ state, mtimeMs, size, code }` — state is exactly one of
 * present / absent / unreadable.
 */
export function probePath(path) {
  return runFsStepsSync(probePathStep(path));
}

/** `probePath` with the stat awaited. */
export function probePathAsync(path) {
  return runFsStepsAsync(probePathStep(path));
}

/** `probePath` as a store-read step (store/fs-steps.mjs). */
export function* probePathStep(path) {
  try {
    return _presentProbe(yield ['stat', path]);
  } catch (err) {
    return _failedProbe(err);
  }
}

/** `readTextFile` (or, with `bytes`, the raw Buffer) as a store-read step. */
export function* readFileStep(path, bytes = false) {
  try {
    const data = yield ['readFile', path, bytes ? undefined : 'utf8'];
    return bytes ? { state: PROBE_PRESENT, bytes: data, code: null } : { state: PROBE_PRESENT, text: data, code: null };
  } catch (err) {
    const { state, code } = _failureVerdict(err);
    return bytes ? { state, bytes: Buffer.alloc(0), code } : { state, text: '', code };
  }
}

function _presentProbe(info) {
  return {
    state: PROBE_PRESENT,
    mtimeMs: info.mtimeMs || 0,
    ctimeMs: info.ctimeMs,
    size: info.size,
    ino: info.ino,
    dev: info.dev,
    code: null,
  };
}

function _failedProbe(err) {
  const { state, code } = _failureVerdict(err);
  return { state, mtimeMs: 0, size: 0, code };
}

/**
 * Read a text file with the SAME three-way classification.
 * `{ state, text, code }` — 'present' carries the text, 'absent' means the
 * file is provably gone, 'unreadable' means it very likely exists and could
 * not be read (EACCES/EIO/EBUSY): the caller must retain whatever authority
 * it already had instead of treating the content as missing.
 */
export function readTextFile(path) {
  return runFsStepsSync(readFileStep(path));
}
