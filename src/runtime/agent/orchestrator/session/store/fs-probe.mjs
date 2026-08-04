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
import { readFileSync, statSync } from 'fs';

export const PROBE_PRESENT = 'present';
export const PROBE_ABSENT = 'absent';
export const PROBE_UNREADABLE = 'unreadable';

// ONLY these mean "nothing is at this path". Everything else means a file is
// very likely there and we simply cannot look at it (same classification the
// session load path uses).
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

// Deterministic fault seam (tests only): invoked with the path before every
// stat and every read (`phase` is 'stat' or 'read'); returning an Error makes
// that syscall fail. Structurally gated — without the explicit test-mode env
// the hook cannot be installed and an already installed one goes inert.
const PROBE_FAULT_ENV = 'MIXDOG_SESSION_LOAD_FAULT_HOOKS';
let _probeFaultHook = null;

export function _setStatProbeFaultHook(hook) {
    if (process.env[PROBE_FAULT_ENV] !== '1') {
        _probeFaultHook = null;
        return false;
    }
    _probeFaultHook = typeof hook === 'function' ? hook : null;
    return _probeFaultHook !== null;
}

function _probeFault(path, phase) {
    if (!_probeFaultHook) return;
    if (process.env[PROBE_FAULT_ENV] !== '1') {
        _probeFaultHook = null; // gate revoked after install: stay inert
        return;
    }
    const injected = _probeFaultHook(path, phase);
    if (injected instanceof Error) throw injected;
}

/**
 * `{ state, mtimeMs, size, code }` — state is exactly one of
 * present / absent / unreadable.
 */
export function probePath(path) {
    try {
        _probeFault(path, 'stat');
        const info = statSync(path);
        return { state: PROBE_PRESENT, mtimeMs: info.mtimeMs || 0, size: info.size, code: null };
    } catch (err) {
        const code = err?.code || 'EUNKNOWN';
        if (ABSENT_CODES.has(code)) return { state: PROBE_ABSENT, mtimeMs: 0, size: 0, code };
        return { state: PROBE_UNREADABLE, mtimeMs: 0, size: 0, code };
    }
}

/**
 * Read a text file with the SAME three-way classification.
 * `{ state, text, code }` — 'present' carries the text, 'absent' means the
 * file is provably gone, 'unreadable' means it very likely exists and could
 * not be read (EACCES/EIO/EBUSY): the caller must retain whatever authority
 * it already had instead of treating the content as missing.
 */
export function readTextFile(path) {
    try {
        _probeFault(path, 'read');
        return { state: PROBE_PRESENT, text: readFileSync(path, 'utf8'), code: null };
    } catch (err) {
        const code = err?.code || 'EUNKNOWN';
        if (ABSENT_CODES.has(code)) return { state: PROBE_ABSENT, text: '', code };
        return { state: PROBE_UNREADABLE, text: '', code };
    }
}

/** True only for a positively observed file/dir. */
export function probeExists(path) {
    return probePath(path).state === PROBE_PRESENT;
}

/** True only when the path is PROVEN absent (never for an unreadable probe). */
export function probeAbsent(path) {
    return probePath(path).state === PROBE_ABSENT;
}
