// Session-scoped read result cache with stat-tuple invalidation.
// Scoped per sessionId; write-class tools explicitly invalidate touched paths.
import { _normalizeAbs, _statTuple, _statEqual } from './util.mjs';
import { clearScopedToolsForSession, clearScopedCounters } from './scoped-cache.mjs';
import { clearPostEditMarks } from './post-edit-marks.mjs';

const MAX_PER_SESSION = 100;

// sessionId -> Map<key, { content, stat, ts, firstToolUseId }>
const _bySession = new Map();

// sessionId -> Map<absPath, Set<cacheKey>>  — reverse index for O(1) path-targeted invalidation
const _reverseIdx = new Map();

// Normalize one element of an array-form path to { abs, off, lim, mode, n }.
// When top-level options (off/lim/mode/n) are supplied, they are applied as
// defaults to elements that don't specify their own.
function _normalizeArrayElem(elem, cwd) {
    if (typeof elem === 'string') {
        const abs = _normalizeAbs(elem, cwd);
        return abs ? { abs, off: '', lim: '', mode: '', n: '', line: '', context: '', full: '' } : null;
    }
    if (elem && typeof elem === 'object' && (typeof elem.path === 'string' || typeof elem.file_path === 'string')) {
        const abs = _normalizeAbs(elem.path || elem.file_path, cwd);
        if (!abs) return null;
        return {
            abs,
            off: elem.offset ?? '',
            lim: elem.limit ?? '',
            mode: elem.mode ?? '',
            n: elem.n ?? '',
            line: elem.line ?? '',
            context: elem.context ?? '',
            full: elem.full ?? '',
        };
    }
    return null;
}

function _normalizeArrayElemWithDefaults(elem, cwd, topOff, topLim, topMode, topN, topLine, topContext, topFull) {
    const n = _normalizeArrayElem(elem, cwd);
    if (!n) return null;
    // Apply top-level options as defaults only when element did not specify its own.
    return {
        abs: n.abs,
        off: n.off !== '' ? n.off : topOff,
        lim: n.lim !== '' ? n.lim : topLim,
        mode: n.mode !== '' ? n.mode : topMode,
        n: n.n !== '' ? n.n : topN,
        line: n.line !== '' ? n.line : topLine,
        context: n.context !== '' ? n.context : topContext,
        full: n.full !== '' ? n.full : topFull,
    };
}

// Build cache key and statsByAbs map for array-form path args.
function _arrayKeyAndStats(args, cwd) {
    const elems = args.path;
    const pages = args?.pages ?? '';
    const full = args?.full ?? '';
    // Top-level options applied as per-element defaults (C: array-form parity).
    const topOff = args?.offset ?? '';
    const topLim = args?.limit ?? '';
    const topMode = args?.mode ?? '';
    const topN = args?.n ?? '';
    const topLine = args?.line ?? '';
    const topContext = args?.context ?? '';
    const topFull = args?.full ?? '';
    const parts = [];
    const statsByAbs = {};
    for (const elem of elems) {
        const n = _normalizeArrayElemWithDefaults(elem, cwd, topOff, topLim, topMode, topN, topLine, topContext, topFull);
        if (!n) return null;
        parts.push(`${n.abs}|o=${n.off}|l=${n.lim}|m=${n.mode}|n=${n.n}|line=${n.line}|ctx=${n.context}|f=${n.full}`);
        if (!statsByAbs[n.abs]) statsByAbs[n.abs] = _statTuple(n.abs);
    }
    const key = `[ARR]${parts.join('||')}|p=${pages}|f=${full}|to=${topOff}|tl=${topLim}|tm=${topMode}|tn=${topN}|tline=${topLine}|tctx=${topContext}|tf=${topFull}`;
    return { key, statsByAbs };
}

function _keyFor(args, cwd) {
    const p = args?.path ?? args?.file_path;
    if (Array.isArray(p)) return null;
    if (typeof p !== 'string') return null;
    const abs = _normalizeAbs(p, cwd);
    if (!abs) return null;
    const usedFilePathAlias = typeof args?.file_path === 'string' && !args?.path;
    const rawOff = args?.offset ?? '';
    let off = rawOff;
    if (usedFilePathAlias && rawOff !== '') {
        const n = Number(rawOff);
        off = Number.isFinite(n) ? Math.max(0, Math.trunc(n) - 1) : rawOff;
    }
    const lim = args?.limit ?? '';
    const mode = args?.mode ?? '';
    const n = args?.n ?? '';
    const pages = args?.pages ?? '';
    const full = args?.full ?? '';
    const line = args?.line ?? '';
    const context = args?.context ?? '';
    return `${abs}|o=${off}|l=${lim}|m=${mode}|n=${n}|p=${pages}|f=${full}|line=${line}|ctx=${context}`;
}

// Re-stat every path in statsByAbs; return true only if ALL match stored tuples.
function _arrayStatsValid(statsByAbs) {
    for (const [absPath, stored] of Object.entries(statsByAbs)) {
        if (!_statEqual(stored, _statTuple(absPath))) return false;
    }
    return true;
}

function _getOrCreate(sessionId) {
    let m = _bySession.get(sessionId);
    if (!m) { m = new Map(); _bySession.set(sessionId, m); }
    return m;
}

function _ridxRegister(sessionId, absPath, key) {
    let ridx = _reverseIdx.get(sessionId);
    if (!ridx) { ridx = new Map(); _reverseIdx.set(sessionId, ridx); }
    let s = ridx.get(absPath);
    if (!s) { s = new Set(); ridx.set(absPath, s); }
    s.add(key);
}

function _ridxPruneKey(sessionId, key) {
    const ridx = _reverseIdx.get(sessionId);
    if (!ridx) return;
    for (const [absKey, keySet] of ridx) {
        keySet.delete(key);
        if (keySet.size === 0) ridx.delete(absKey);
    }
}

function _absFromKey(key) {
    const idx = key.indexOf('|');
    return idx === -1 ? key : key.slice(0, idx);
}

/**
 * Look up a cached read result for this session+args. Stats the file at
 * lookup time and only returns when the stat tuple still matches. Returns
 * null on miss, on path-form mismatch, or on stat failure. On hit returns
 * the full entry { content, firstToolUseId, ts }.
 */
export function tryReadCached({ sessionId, args, cwd }) {
    if (!sessionId) return null;
    const key = _keyFor(args, cwd);
    if (key === null && Array.isArray(args?.path)) {
        const parsed = _arrayKeyAndStats(args, cwd);
        if (!parsed) return null;
        const map = _bySession.get(sessionId);
        if (!map) return null;
        const entry = map.get(parsed.key);
        if (!entry || entry.kind !== 'array') return null;
        if (!_arrayStatsValid(entry.statsByAbs)) {
            map.delete(parsed.key);
            return null;
        }
        map.delete(parsed.key);
        map.set(parsed.key, entry);
        return { content: entry.content, firstToolUseId: entry.firstToolUseId || null, ts: entry.ts };
    }
    if (!key) return null;
    const map = _bySession.get(sessionId);
    if (!map) return null;
    const entry = map.get(key);
    if (!entry) return null;
    const fresh = _statTuple(_absFromKey(key));
    if (!_statEqual(entry.stat, fresh)) {
        map.delete(key);
        return null;
    }
    map.delete(key);
    map.set(key, entry);
    return { content: entry.content, firstToolUseId: entry.firstToolUseId || null, ts: entry.ts };
}

/**
 * Cache a successful read result. Skip caching if the file no longer exists.
 * `toolUseId` is the tool_use id of the FIRST call that populated the entry.
 */
export function setReadCached({ sessionId, args, cwd, content, toolUseId }) {
    if (!sessionId) return;
    if (typeof content !== 'string' || content.length === 0) return;
    const key = _keyFor(args, cwd);
    if (key === null && Array.isArray(args?.path)) {
        const parsed = _arrayKeyAndStats(args, cwd);
        if (!parsed) return;
        for (const st of Object.values(parsed.statsByAbs)) {
            if (!st) return;
        }
        const map = _getOrCreate(sessionId);
        if (map.size >= MAX_PER_SESSION) {
            const firstKey = map.keys().next().value;
            if (firstKey) { map.delete(firstKey); _ridxPruneKey(sessionId, firstKey); }
        }
        map.set(parsed.key, {
            kind: 'array',
            content,
            statsByAbs: parsed.statsByAbs,
            ts: Date.now(),
            firstToolUseId: toolUseId || null,
        });
        // Register every constituent abs path in the reverse index.
        for (const absPath of Object.keys(parsed.statsByAbs)) {
            _ridxRegister(sessionId, absPath, parsed.key);
        }
        return;
    }
    if (!key) return;
    const fresh = _statTuple(_absFromKey(key));
    if (!fresh) return;
    const map = _getOrCreate(sessionId);
    if (map.size >= MAX_PER_SESSION) {
        const firstKey = map.keys().next().value;
        if (firstKey) { map.delete(firstKey); _ridxPruneKey(sessionId, firstKey); }
    }
    map.set(key, { content, stat: fresh, ts: Date.now(), firstToolUseId: toolUseId || null });
    _ridxRegister(sessionId, _absFromKey(key), key);
}

/**
 * Invalidate all cache entries for `path` in the given session. Called when
 * a mutation tool (apply_patch) touches the path.
 */
export function invalidatePathForSession(sessionId, path, cwd) {
    if (!sessionId) return;
    const abs = _normalizeAbs(path, cwd);
    if (!abs) return;
    const map = _bySession.get(sessionId);
    if (!map) return;
    const ridx = _reverseIdx.get(sessionId);
    const keys = ridx ? ridx.get(abs) : null;
    if (keys && keys.size > 0) {
        // O(1) lookup via reverse index.
        const evicted = new Set(keys);
        for (const k of evicted) map.delete(k);
        keys.clear();
        ridx.delete(abs);
        // Clean evicted keys from other reverse-index sets; prune empty Sets.
        for (const [absKey, keySet] of ridx) {
            for (const k of evicted) keySet.delete(k);
            if (keySet.size === 0) ridx.delete(absKey);
        }
    }
    // Index miss = entry has no path identity; no-op is correct.
}

/**
 * Drop everything for a session. Called when the session closes.
 * Also clears scoped cache, counters, and post-edit marks for the session.
 */
export function clearReadDedupSession(sessionId) {
    if (!sessionId) return;
    _bySession.delete(sessionId);
    _reverseIdx.delete(sessionId);
    clearPostEditMarks(sessionId);
    clearScopedToolsForSession(sessionId);
    clearScopedCounters(sessionId);
}

/**
 * Extract the set of touched filesystem paths from a unified-diff patch text.
 * Handles git-style `--- a/<path>` / `+++ b/<path>` headers and `/dev/null` markers.
 * Returns relative paths as written in the diff.
 */
export function extractTouchedPathsFromPatch(patchText) {
    if (typeof patchText !== 'string' || patchText.length === 0) return [];
    const lines = patchText.split('\n');
    const out = [];
    const seen = new Set();
    const stripPathMetadata = (rawPath) => {
        let text = String(rawPath || '').trim();
        if (!text) return '';
        const tabIdx = text.indexOf('\t');
        if (tabIdx !== -1) text = text.slice(0, tabIdx).trimEnd();
        const quote = text[0];
        if ((quote === '"' || quote === "'") && text.length > 1) {
            const end = text.indexOf(quote, 1);
            if (end > 0) text = text.slice(1, end);
        }
        return text;
    };
    const push = (rawPath) => {
        let touched = stripPathMetadata(rawPath);
        if (!touched || touched === '/dev/null') return;
        touched = touched.replace(/^["']|["']$/g, '').replace(/\\/g, '/');
        if (touched.startsWith('a/') || touched.startsWith('b/')) touched = touched.slice(2);
        if (!touched || touched === '/dev/null' || seen.has(touched)) return;
        seen.add(touched);
        out.push(touched);
    };
    for (const line of lines) {
        if (line.startsWith('*** Update File:')) push(line.slice('*** Update File:'.length));
        else if (line.startsWith('*** Add File:')) push(line.slice('*** Add File:'.length));
        else if (line.startsWith('*** Delete File:')) push(line.slice('*** Delete File:'.length));
    }
    for (let i = 0; i < lines.length - 1; i += 1) {
        const minus = lines[i];
        const plus = lines[i + 1];
        if (!minus.startsWith('--- ')) continue;
        if (!plus.startsWith('+++ ')) continue;
        const fromRaw = minus.slice(4).trim();
        const toRaw = plus.slice(4).trim();
        const fromStripped = fromRaw.startsWith('a/') ? fromRaw.slice(2) : fromRaw;
        const toStripped = toRaw.startsWith('b/') ? toRaw.slice(2) : toRaw;
        let touched;
        if (toStripped === '/dev/null') {
            touched = fromStripped === '/dev/null' ? null : fromStripped;
        } else {
            touched = toStripped;
        }
        push(touched);
        i += 1;
    }
    return out;
}
