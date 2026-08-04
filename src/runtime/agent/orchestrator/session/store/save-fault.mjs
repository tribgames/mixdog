/**
 * Session-save commit faults and scratch-file hygiene.
 *
 * Two responsibilities, both about the *commit edge* of the store's atomic
 * save (write `<id>.json.<hex>.tmp`, then rename it onto `<id>.json`):
 *
 *  1. A deterministic commit fault, STRUCTURALLY GATED to explicit test mode
 *     (MIXDOG_SESSION_SAVE_FAULT_HOOKS=1). The synthetic error is raised
 *     BEFORE renameSync runs, so the destination is never unlinked, truncated
 *     or replaced — the last-good canonical JSON survives the fault byte for
 *     byte. This replaces destructive "make the path a directory" fault rigs,
 *     which prove nothing about canonical integrity because they destroy the
 *     canonical file first. There is deliberately NO env-driven fault
 *     configuration: nothing in a production environment can arm this.
 *  2. Conservative reclamation of the store's OWN abandoned scratch files.
 *     A failed commit can leave `<id>.json.<hex>.tmp` bytes behind; the store
 *     used to swallow the unlink failure and leak them forever. Only paths
 *     THIS realm minted and then failed to unlink are retried, and only when
 *     they match the store's exact scratch naming. The sessions directory is
 *     never scanned: an unregistered scratch file may be the save worker's or
 *     another process's ACTIVE commit, which no registry here can see.
 */
import { unlinkSync } from 'fs';
import { basename } from 'path';
import { _renameWithRetrySync } from './serialize.mjs';

// `<id>.json.<12 hex>.tmp` — exactly what the store mints
// (`sessionPath(id) + '.' + randomBytes(6).toString('hex') + '.tmp'`).
// Anything else in sessions/ is somebody else's file and is left alone.
const SAVE_TMP_RE = /^[A-Za-z0-9_-]+\.json\.[0-9a-f]{12}\.tmp$/;
const ORPHAN_TMP_SWEEP_LIMIT = 64;            // registered paths retried per chunk
const ORPHAN_TMP_DRAIN_MAX_ATTEMPTS = 4096;   // hard ceiling for one drain pass
const ORPHAN_TMP_TRACK_MAX = 256;             // soft cap: only reclaimed paths leave
const UNLINK_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

const _activeSaveTmp = new Set();   // scratch paths this thread is writing now
const _orphanSaveTmp = new Set();   // scratch paths whose unlink failed

export function _trackSaveTmp(tmp) {
    if (tmp) _activeSaveTmp.add(tmp);
    return tmp;
}

export function _untrackSaveTmp(tmp) {
    if (tmp) _activeSaveTmp.delete(tmp);
}

/**
 * Register a scratch path as explicitly orphaned by THIS realm — the only
 * class of file the sweeper may remove. Exported for the store's failure
 * paths and for tests.
 */
export function _registerOrphanSaveTmp(tmp) {
    if (!tmp) return;
    _activeSaveTmp.delete(tmp);
    _orphanSaveTmp.add(tmp);
    if (_orphanSaveTmp.size <= ORPHAN_TMP_TRACK_MAX) return;
    // Over the soft cap: try to RECLAIM the oldest entries instead of evicting
    // them. Dropping a path that is still on disk turns it into an orphan no
    // realm owns any more, which is exactly how scratch files leaked forever.
    // A path whose unlink still fails keeps its registry slot (retry ownership).
    for (const oldest of [..._orphanSaveTmp]) {
        if (_orphanSaveTmp.size <= ORPHAN_TMP_TRACK_MAX) break;
        if (oldest === tmp) continue;
        try {
            unlinkSync(oldest);
            _orphanSaveTmp.delete(oldest);
        } catch (err) {
            if (err?.code === 'ENOENT') _orphanSaveTmp.delete(oldest);
        }
    }
}

/**
 * Drop a scratch file. Retries the transient win32 codes once, and on final
 * failure registers the path so the bounded sweeper retries it later instead
 * of leaking it (the previous `catch { /* ignore *\/ }` was terminal).
 */
export function _discardSaveTmp(tmp) {
    if (!tmp) return true;
    _activeSaveTmp.delete(tmp);
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            unlinkSync(tmp);
            _orphanSaveTmp.delete(tmp);
            return true;
        } catch (err) {
            if (err?.code === 'ENOENT') {
                _orphanSaveTmp.delete(tmp);
                return true;
            }
            if (!UNLINK_RETRY_CODES.has(err?.code)) break;
        }
    }
    _registerOrphanSaveTmp(tmp);
    return false;
}

/**
 * Retry the unlink of scratch files THIS realm minted and abandoned.
 *
 * Bounded: at most `limit` registered paths are retried per chunk (default
 * 64). `drain: true` (exit) walks the WHOLE registry in such chunks, at most
 * ONE attempt per path and at most `maxAttempts` in total, so a registry
 * larger than one chunk cannot survive process exit while the pass still
 * terminates.
 * Conservative: no directory scan, so a scratch file this realm never
 * registered — possibly the save worker's or another process's in-flight
 * commit — is never even looked at, and a registered path whose name is not
 * the store's exact scratch pattern is dropped from the registry rather than
 * unlinked. A path whose unlink FAILS stays registered, so a transient
 * failure is retried by the next pass instead of leaking.
 * Returns the number of scratch files reclaimed.
 */
export function sweepOrphanSessionTmpFiles(options = {}) {
    const limit = Number.isFinite(options.limit) && options.limit > 0
        ? options.limit
        : ORPHAN_TMP_SWEEP_LIMIT;
    if (options.drain !== true) return _sweepOrphanChunk(limit).removed;
    const budget = Number.isFinite(options.maxAttempts) && options.maxAttempts > 0
        ? options.maxAttempts
        : ORPHAN_TMP_DRAIN_MAX_ATTEMPTS;
    // One attempt per path per drain: `attempted` is what makes the loop
    // terminate even when every remaining unlink keeps failing.
    const attempted = new Set();
    let removed = 0;
    let spent = 0;
    while (spent < budget) {
        const chunk = _sweepOrphanChunk(Math.min(limit, budget - spent), attempted);
        if (chunk.attempts === 0) break;
        removed += chunk.removed;
        spent += chunk.attempts;
    }
    return removed;
}

function _sweepOrphanChunk(limit, attempted = null) {
    let removed = 0;
    let attempts = 0;
    for (const path of [..._orphanSaveTmp]) {
        if (attempts >= limit) break;
        if (attempted?.has(path)) continue;      // already retried in this drain
        if (_activeSaveTmp.has(path)) continue;  // re-minted since it was registered
        if (!SAVE_TMP_RE.test(basename(path))) { // never an unrelated/external file
            _orphanSaveTmp.delete(path);
            continue;
        }
        attempts++;
        attempted?.add(path);
        try {
            unlinkSync(path);
            _orphanSaveTmp.delete(path);
            removed++;
        } catch (err) {
            if (err?.code === 'ENOENT') _orphanSaveTmp.delete(path);
        }
    }
    return { removed, attempts };
}

// ── Deterministic commit-fault injection (test-gated) ───────────────────────
// STRUCTURAL GATE: the seam is inert unless the process was started in
// explicit fault-injection test mode. Arming it without the gate is refused
// (setSessionSaveFault returns false), and armed state is dropped the moment
// the gate stops being set, so no production process — and no environment
// variable — can make a real save fail.
const SESSION_SAVE_FAULT_ENV = 'MIXDOG_SESSION_SAVE_FAULT_HOOKS';
const _programmaticFault = { ids: null, remaining: 0, code: 'EIO' };
// Config epoch: bumped on every change so a realm that mirrors this state
// (the save worker) can detect a change — including a CLEAR — without diffing
// sets. Consumption of `remaining` never bumps it.
let _faultConfigEpoch = 0;
let _faultChangeListener = null;
// Authoritative state pushed in from the owning realm (parent → save worker).
// Once applied, it REPLACES programmatic resolution in this realm: the worker
// is long-lived and never runs setSessionSaveFault itself.
let _syncedFaultApplied = false;
let _syncedFault = null;

function _faultInjectionEnabled() {
    return process.env[SESSION_SAVE_FAULT_ENV] === '1';
}

/**
 * The store's explicit fault-injection test mode, shared by every structurally
 * gated seam in the store (see save-worker's detach seam). Production never
 * has this set, so those seams cannot be reached there.
 */
export function _sessionStoreTestMode() {
    return _faultInjectionEnabled();
}

function _clearFaultState() {
    _programmaticFault.ids = null;
    _programmaticFault.remaining = 0;
    _programmaticFault.code = 'EIO';
    _syncedFaultApplied = false;
    _syncedFault = null;
}

function _idSet(ids) {
    if (ids === '*' || ids === true) return '*';
    const list = Array.isArray(ids) ? ids : [ids];
    return new Set(list.map((v) => String(v)).filter(Boolean));
}

/**
 * Configure (or clear with a falsy argument) in-process commit faults. Only
 * honoured in explicit fault-injection test mode; returns whether the fault
 * was armed.
 * `{ ids: 'sess_x' | ['a','b'] | '*', count?: number, code?: string }`.
 * `count` is the number of commits to fail (default: unlimited), so a test can
 * fail exactly one save and let the NEXT save land without extra bookkeeping.
 */
export function setSessionSaveFault(spec = null) {
    if (!spec || !_faultInjectionEnabled()) {
        _clearFaultState();
        _faultConfigEpoch++;
        _notifyFaultChange();
        return false;
    }
    _programmaticFault.ids = _idSet(spec.ids ?? spec.id ?? '*');
    const count = Number(spec.count);
    _programmaticFault.remaining = Number.isFinite(count) && count >= 0 ? count : Infinity;
    _programmaticFault.code = typeof spec.code === 'string' && spec.code ? spec.code : 'EIO';
    _faultConfigEpoch++;
    _notifyFaultChange();
    return true;
}

function _notifyFaultChange() {
    if (typeof _faultChangeListener === 'function') {
        try { _faultChangeListener(); } catch { /* best-effort */ }
    }
}

/** Register the realm-sync hook (save-worker.mjs pushes state to the worker). */
export function _onSessionSaveFaultChange(listener) {
    _faultChangeListener = typeof listener === 'function' ? listener : null;
}

/**
 * Cheap change token for the fault config. A mirroring realm re-syncs only
 * when this token moves, so steady-state saves pay one compare and never a
 * postMessage.
 */
export function sessionSaveFaultSyncKey() {
    return String(_faultConfigEpoch);
}

/** Wire form of the currently effective fault state (null when disabled). */
export function serializeSessionSaveFault() {
    const state = _effectiveFaultState();
    if (!state) return null;
    return {
        ids: state.ids === '*' ? '*' : [...state.ids],
        remaining: state.remaining === Infinity ? null : state.remaining,
        code: state.code,
    };
}

/**
 * Adopt fault state pushed from the owning realm. `null` DISABLES injection in
 * this realm outright, which is what makes `setSessionSaveFault(null)` stop
 * worker-thread faults too.
 */
export function applySessionSaveFault(serialized) {
    _syncedFaultApplied = true;
    _syncedFault = (serialized && _faultInjectionEnabled())
        ? {
            ids: serialized.ids === '*' ? '*' : _idSet(serialized.ids),
            remaining: serialized.remaining === null || serialized.remaining === undefined
                ? Infinity
                : Number(serialized.remaining),
            code: serialized.code || 'EIO',
        }
        : null;
}

function _effectiveFaultState() {
    // Gate revoked after arming: stay inert and forget the armed state.
    if (!_faultInjectionEnabled()) {
        if (_programmaticFault.ids || _syncedFault) _clearFaultState();
        return null;
    }
    // A synced realm is fully governed by its owner — never by a programmatic
    // call that never happened there.
    const state = _syncedFaultApplied ? _syncedFault : (_programmaticFault.ids ? _programmaticFault : null);
    return state && state.remaining > 0 ? state : null;
}

function _takeInjectedCommitFault(id) {
    const state = _effectiveFaultState();
    if (!state) return null;
    if (state.ids !== '*' && !state.ids.has(id)) return null;
    if (state.remaining !== Infinity) state.remaining -= 1;
    const err = new Error(`[session-store] injected save commit fault for ${id}`);
    err.code = state.code;
    err.injectedSaveFault = true;
    return err;
}

/**
 * Commit a staged scratch file onto its canonical path. The injected fault is
 * raised before the rename, so a fault leaves BOTH files exactly as they were:
 * the canonical destination stays the last-good session JSON, and the scratch
 * file is the caller's to discard (see _discardSaveTmp).
 */
export function _commitSessionWrite(tmp, target, id) {
    const injected = _takeInjectedCommitFault(id);
    if (injected) throw injected;
    return _renameWithRetrySync(tmp, target);
}
