import { statSync, readFileSync } from 'fs';
import { getPluginData } from '../../config.mjs';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from '../lifecycle-scan.mjs';

// Recent full-session reads are much hotter than writes while a user hops
// between conversations. Verify the file identity on every access, but reuse
// the parsed object while the atomic file has not changed.
const SESSION_LOAD_CACHE_LIMIT = 8;
const _sessionLoadCache = new Map(); // path → { signature, session }
let _sessionLoadCacheDataDir = null;

// A session file is only ever replaced atomically (write tmp → rename over
// the canonical path). A reader that stats one inode and then reads "the
// path" can therefore straddle a replacement: the stat describes the old
// file while the read returns the new bytes, or the old inode is already
// gone (ENOENT) even though a perfectly valid replacement exists — which the
// naive version reported as {exists:true, session:null} / {exists:false},
// i.e. loadSession()/getSession() returning null for a live session. Every
// observation below is therefore a STABLE SNAPSHOT: stat → read → stat, and
// the result is only trusted (and only cached) when the identity signature is
// unchanged around the read. An unstable observation is retried a bounded
// number of times, so the replacement window closes and we still fail closed
// on genuine corruption instead of spinning.
const SESSION_LOAD_STABLE_ATTEMPTS = 5;

// Deterministic fault injection point (tests only): invoked immediately
// before every stat and every read with { phase, path, attempt }. The hook
// may mutate the file system (simulating an atomic rename landing between
// the two syscalls) or return an Error to make that syscall fail.
//
// STRUCTURAL GATE: the seam is inert unless the process was started in
// explicit fault-injection test mode. Installing a hook without the gate is
// a no-op (returns false), and an already-installed hook is dropped the
// moment the gate stops being set, so a production build can never activate
// it accidentally — not via a stray import, not via a leaked reference.
const SESSION_LOAD_FAULT_ENV = 'MIXDOG_SESSION_LOAD_FAULT_HOOKS';
let _sessionLoadFaultHook = null;

function _faultHooksEnabled() {
    return process.env[SESSION_LOAD_FAULT_ENV] === '1';
}

export function _setSessionLoadFaultHook(hook) {
    if (!_faultHooksEnabled()) {
        _sessionLoadFaultHook = null;
        return false;
    }
    _sessionLoadFaultHook = typeof hook === 'function' ? hook : null;
    return _sessionLoadFaultHook !== null;
}

// Test/diagnostic view of the cache: proves a signature is never paired with
// content that came from a different inode.
export function _inspectSessionLoadCache() {
    return [..._sessionLoadCache.entries()].map(([path, entry]) => ({
        path,
        signature: entry.signature,
        session: entry.session,
    }));
}

function _fault(phase, path, attempt) {
    if (!_sessionLoadFaultHook) return;
    if (!_faultHooksEnabled()) {
        _sessionLoadFaultHook = null; // gate revoked after install: stay inert
        return;
    }
    const injected = _sessionLoadFaultHook({ phase, path, attempt });
    if (injected instanceof Error) throw injected;
}

// Only these mean "nothing is at this path right now". Everything else
// (EACCES, EPERM, EIO, EBUSY, EMFILE, ELOOP, unknown) means a file is very
// likely THERE and we simply cannot look at it: that must never be reported
// as absence, because absence lets loadSession() fall back to in-memory
// state and thereby mask an unreadable file that owns the identity.
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

// Observation states: 'present' (signature valid), 'absent' (ENOENT-class),
// 'unreadable' (persistent/transient failure — fail closed).
function _observe(path, attempt) {
    try {
        _fault('stat', path, attempt);
        const info = statSync(path, { bigint: true });
        return { state: 'present', signature: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`, code: null };
    } catch (err) {
        const code = err?.code || 'EUNKNOWN';
        if (ABSENT_CODES.has(code)) return { state: 'absent', signature: null, code };
        return { state: 'unreadable', signature: null, code };
    }
}

// A decision is always derived from ONE observation that was actually made —
// never from a second, independent existence probe (the old
// `stat → null → existsSync(path)` pair was a TOCTOU window that could turn a
// live file into {exists:false}).
function _decide(observation) {
    if (observation.state === 'absent') return { exists: false, session: null };
    return { exists: true, session: null };
}

// Content is only this session's when it parses UNAMBIGUOUSLY and claims this
// id. readTopLevelLifecycleRecord is the strict parse (no separate JSON.parse
// authority to diverge from): a duplicate top-level `id` is last-wins under
// JSON.parse, which would hand the runtime a foreign/ambiguous transcript to
// serve, re-save and tombstone from. Ambiguity reads as corruption here —
// `null` keeps the file owning the identity and fails closed.
function _ownedSession(id, text) {
    const record = readTopLevelLifecycleRecord(text);
    if (isLifecycleUnreadable(record)) return null;
    return record.id === id ? record.doc : null;
}

function _cacheStable(path, signature, session) {
    _sessionLoadCache.delete(path);
    _sessionLoadCache.set(path, { signature, session });
    while (_sessionLoadCache.size > SESSION_LOAD_CACHE_LIMIT) {
        const oldest = _sessionLoadCache.keys().next().value;
        if (oldest === undefined) break;
        _sessionLoadCache.delete(oldest);
    }
}

// The inode we stat'ed vanished under the read on the LAST attempt: no retry
// is left, but a replacement may already own the path. Take ONE decisive
// snapshot (observe, then read what is actually there) instead of classifying
// from the observation alone — reporting {exists:true, session:null} for a
// perfectly readable replacement is the same false corruption the retry loop
// exists to avoid. Uncached: no identity was verified around this read.
function _decisiveReplacementSnapshot(id, path, attempt) {
    const observed = _observe(path, attempt);
    if (observed.state === 'absent') return { exists: false, session: null };
    if (observed.state !== 'present') return { exists: true, session: null };
    let text = null;
    try {
        _fault('read', path, attempt);
        text = readFileSync(path, 'utf-8');
    } catch (err) {
        const code = err?.code || 'EUNKNOWN';
        return ABSENT_CODES.has(code) ? { exists: false, session: null } : { exists: true, session: null };
    }
    return { exists: true, session: _ownedSession(id, text) };
}

export function _readStoredSessionCached(id, path) {
    const dataDir = getPluginData();
    if (_sessionLoadCacheDataDir !== dataDir) {
        _sessionLoadCacheDataDir = dataDir;
        _sessionLoadCache.clear();
    }
    let last = { state: 'absent', signature: null, code: 'ENOENT' };
    for (let attempt = 0; attempt < SESSION_LOAD_STABLE_ATTEMPTS; attempt++) {
        // The final attempt must DECIDE — it may not defer to yet another
        // observation, so a replacement landing on that last boundary is
        // parsed (if its bytes are readable and ours) or reported as
        // present-but-invalid, never as absence.
        const isFinal = attempt === SESSION_LOAD_STABLE_ATTEMPTS - 1;
        const before = _observe(path, attempt);
        last = before;
        if (before.state !== 'present') {
            // Absent: possibly the unlink → rename hole, retry.
            // Unreadable: EACCES/EIO/EBUSY — retry in case it is transient,
            // but this observation already means "present, fail closed".
            _sessionLoadCache.delete(path);
            continue;
        }
        const cached = _sessionLoadCache.get(path);
        if (cached?.signature === before.signature) {
            // The cached object was stored under a verified-stable signature,
            // and dev/ino/size/mtimeNs still describe that same file.
            _sessionLoadCache.delete(path);
            _sessionLoadCache.set(path, cached);
            return { exists: true, session: cached.session };
        }
        let text = null;
        let readCode = null;
        try {
            _fault('read', path, attempt);
            text = readFileSync(path, 'utf-8');
        } catch (err) {
            readCode = err?.code || 'EUNKNOWN';
        }
        if (readCode !== null) {
            _sessionLoadCache.delete(path);
            if (!ABSENT_CODES.has(readCode)) {
                // EACCES/EIO/EBUSY on the read: the file is there and we
                // cannot have it. Fail closed, now or after the retries.
                last = { state: 'unreadable', signature: null, code: readCode };
                if (isFinal) return { exists: true, session: null };
                continue;
            }
            // The inode we stat'ed vanished under us: replacement window, not
            // corruption. Retry and let the new file answer.
            last = { state: 'absent', signature: null, code: readCode };
            // On the last boundary there is no retry left: read the
            // replacement rather than classify it from a bare stat.
            if (isFinal) return _decisiveReplacementSnapshot(id, path, attempt);
            continue;
        }
        const after = _observe(path, attempt);
        if (after.state !== 'present' || after.signature !== before.signature) {
            // A rename landed around the read — these bytes may belong to a
            // different inode than `before`, so they must never be cached
            // under it.
            _sessionLoadCache.delete(path);
            last = after;
            if (!isFinal) continue;
            // Last boundary: the bytes still came from a real file at this
            // path. If they are a valid session for this id, answer with them
            // (uncached, since no identity was verified) rather than invent an
            // absence/null for a perfectly readable replacement; otherwise
            // stay conservatively present-but-invalid.
            return { exists: true, session: _ownedSession(id, text) };
        }
        // Stable snapshot: `text` provably belongs to the file identified by
        // `before`. Whatever it says is now authoritative, including "this is
        // not valid session JSON" / "this is a foreign id" — fail closed.
        const stored = _ownedSession(id, text);
        if (stored === null) {
            _sessionLoadCache.delete(path);
            return { exists: true, session: null };
        }
        _cacheStable(path, before.signature, stored);
        return { exists: true, session: stored };
    }
    // Bounded retries exhausted. `last` is the most recent observation we
    // actually made, so the answer needs no further syscall: ENOENT-class ⇒
    // genuinely absent, anything else ⇒ present-but-unreadable, which keeps
    // owning the identity and fails closed like real external corruption.
    _sessionLoadCache.delete(path);
    return _decide(last);
}
