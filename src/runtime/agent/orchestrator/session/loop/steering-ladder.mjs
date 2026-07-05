// Completion-first steering ladder (worker runaway prevention), extracted from
// loop.mjs. Owns the mutable ladder counters and the post-batch steering-hint
// emitters. State is threaded live via a context object of getters/setters so
// no snapshot goes stale — the loop mutates `messages`/`iterations` in place and
// this module reads them through the accessors on each call. No behavior change:
// the counters, thresholds, and emitted messages are verbatim from agentLoop.
import { appendAgentTrace } from '../../agent-trace.mjs';
import { level2SteerMessage } from './completion-guards.mjs';
import { isEagerDispatchable } from './tool-helpers.mjs';

// --- Steering detector helpers (pure) ---
const _WORD_RE = /[A-Za-z_$][\w$]*/g;
const _IDENT_RE = /^[A-Za-z_$][\w$]{2,}$/;
const _SRC_DIR_RE = /(^|[\\/])(src|lib|app|packages|components|pages)([\\/]|$)/i;
function _grepPatterns(c) {
    const p = c?.arguments?.pattern;
    if (typeof p === 'string') return [p];
    if (Array.isArray(p)) return p.filter((x) => typeof x === 'string');
    return [];
}
function _patternTokens(c) {
    const out = new Set();
    for (const pat of _grepPatterns(c)) {
        for (const t of (String(pat).match(_WORD_RE) || [])) {
            if (t.length >= 3) out.add(t.toLowerCase());
        }
    }
    return out;
}
function _pathsOf(arg) {
    const out = [];
    const push = (v) => {
        if (typeof v === 'string' && v) out.push(v);
        else if (v && typeof v === 'object' && typeof v.path === 'string' && v.path) out.push(v.path);
    };
    if (Array.isArray(arg)) arg.forEach(push); else push(arg);
    return out;
}
// Case-insensitive (win32 paths) forward-slash normalization for all path compares.
function _normPath(p) { return String(p).replace(/\\/g, '/').toLowerCase(); }
function _baseName(p) { const s = _normPath(p); const i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; }
function _dirName(p) { const s = _normPath(p); const i = s.lastIndexOf('/'); return i >= 0 ? s.slice(0, i) : ''; }
// Exact (normalized) same-file test — used where "related" is too loose.
function _samePath(a, b) { return !!a && !!b && _normPath(a) === _normPath(b); }
// Loose sibling/variant relation — cluster detector pairs this WITH token overlap.
function _pathsRelated(a, b) {
    if (!a || !b) return false;
    const na = _normPath(a); const nb = _normPath(b);
    if (na === nb) return true;                                 // identical
    if (na.includes(nb) || nb.includes(na)) return true;        // normalized variant
    if (_dirName(na) && _dirName(na) === _dirName(nb)) return true; // siblings
    const ba = _baseName(na); const bb = _baseName(nb);
    return !!ba && ba === bb;                                    // same file name
}
function _setsOverlap(a, b) { for (const x of a) { if (b.has(x)) return true; } return false; }
// A single chained segment is read-only only if it STARTS with a read-only verb.
function _isReadOnlyShellSegment(seg) {
    const s = seg.trim();
    if (!s) return null;                                        // empty (trailing operator)
    if (/^git\s+(status|log)\b/.test(s)) return true;
    if (/^git\s+diff\b[^\n]*--stat\b/.test(s)) return true;
    if (/^get-childitem\b/.test(s)) return true;
    return /^(cat|ls|dir|type)\b/.test(s);
}
// Read-only only when EVERY chained segment is read-only — a single mutating
// segment (e.g. `git status && npm test`) disqualifies the whole command.
function _isReadOnlyShellCmd(cmd) {
    const s = String(cmd || '').toLowerCase().trim();
    if (!s) return false;
    let sawCmd = false;
    for (const seg of s.split(/&&|\|\||[;&|]/)) {
        const verdict = _isReadOnlyShellSegment(seg);
        if (verdict === null) continue;                         // blank segment
        if (verdict === false) return false;                    // a mutating segment
        sawCmd = true;
    }
    return sawCmd;
}
// Extract (path, offset) windows from a read call: path may be a string, an
// array of strings, or an array of {path,offset,limit} regions; a top-level
// offset applies to string entries.
function _readWindows(c) {
    const a = c?.arguments || {};
    const out = [];
    const push = (p, off) => { if (typeof p === 'string' && p) out.push({ path: p, offset: Number(off) }); };
    const v = a.path;
    if (Array.isArray(v)) {
        for (const e of v) {
            if (typeof e === 'string') push(e, a.offset);
            else if (e && typeof e === 'object') push(e.path, e.offset ?? a.offset);
        }
    } else if (typeof v === 'string') push(v, a.offset);
    return out;
}

// Build the completion-first steering-ladder controller. `ctx` supplies live
// accessors so every read reflects the loop's current mutable state:
//   - messages, sessionId, sessionAgent, tools           (stable refs/values)
//   - getIterations()                                    (current iteration)
//   - getEditCount()                                     (mutated by the loop)
//   - pushSystemReminder(text)  → push a meta:'hook' user message
//   - pushUserMessage(msg)      → push a raw user message (level-2 latch text)
export function createSteeringLadder(ctx) {
    const {
        sessionId,
        sessionAgent,
        tools,
        getIterations,
        getEditCount,
    } = ctx;
    const pushSystemReminder = ctx.pushSystemReminder;
    const pushUserMessage = ctx.pushUserMessage;
    // Permission-based role detection (agent names are user-definable):
    // read-permission sessions legitimately never edit, so they get the
    // report-oriented level-2 text.
    const readOnlyRole = ctx.readOnlyRole === true;

    // Step 1: escalation ladder. _level1FireCount is CUMULATIVE (never reset)
    // so repeated batching reminders accumulate across the whole session.
    // _level2LatchAtIteration latches level-2 steering to at most once / 5 turns.
    let _level1FireCount = 0;
    let _level2LatchAtIteration = -Infinity;
    // Independent ladder counter: consecutive turns where EVERY call is
    // read-only (any count) with zero edits. Catches multi-call read-only
    // turns that the single-call level-1 streak misses. Reset on any edit.
    let _allReadOnlyStreak = 0;
    // Tracks consecutive assistant turns that ran exactly one read-only tool
    // call (missed parallelism). Not reset per-iteration — only by the
    // steering-hint fire below or by a turn that batches/edits.
    let _serialReadOnlyStreak = 0;
    // Same-concept grep cluster (broadened serial-rewording spiral): counts
    // consecutive grep-only turns that stay on ONE concept — related by
    // identical/normalized/sibling paths OR pattern-token overlap, not just an
    // identical path. `_sameGrepPrev` holds the prior turn's {paths,tokens}.
    let _sameGrepStreak = 0;
    let _sameGrepPrev = null;
    // Prior turn's uncapped content/context grep paths — seeds the
    // grep-context-then-read detector (a read of the same file next turn).
    let _lastGrepContentPaths = null;
    // Consecutive turns grepping the SAME identifier-like token in source dirs
    // (symbol lookups that belong in code_graph).
    let _identGrepStreak = 0;
    let _identGrepToken = null;
    let _level2FireCount = 0;
    // Read-fragmentation detector state: normalized path -> cumulative
    // single-window offset reads. Mirrors session-bench read_fragmentation
    // (3+ windowed reads of one file within an 800-line span). Multi-window
    // same-path regions in ONE call are the recommended batched form and are
    // never counted. Fires once per path per session.
    const _readWindowsByPath = new Map();

    // Level-2 steering emitter shared by both ladder paths (single-call
    // level-1 streak and the independent all-read-only streak). Sets the latch
    // so it fires at most once per 5 turns regardless of which path triggered.
    const _emitLevel2Steer = () => {
        const iterations = getIterations();
        _level2LatchAtIteration = iterations;
        _level2FireCount += 1;
        pushUserMessage({ role: 'user', content: level2SteerMessage(_level1FireCount, readOnlyRole, _level2FireCount), meta: 'hook' });
        try {
            appendAgentTrace({
                sessionId,
                iteration: iterations,
                kind: 'steer',
                payload: { tag: 'level2_steer', level1_fires: _level1FireCount, level2_fires: _level2FireCount, edit_count: getEditCount(), all_read_only_streak: _allReadOnlyStreak },
                agent: sessionAgent || null,
            });
        } catch { /* best-effort */ }
    };

    return {
        // Post-batch steering hint gate. `hintAlreadyFired` seeds the once-per-turn
        // latch. Returns nothing;
        // pushes at most one steering message via the ctx push callbacks.
        emitPostBatchSteering(calls, hintAlreadyFired) {
            const iterations = getIterations();
            const editCount = getEditCount();
            // Steering hint gate: at most ONE hint per turn (priority:
            // level-2 > grep/shell detectors > level-1).
            let _hintFiredThisTurn = hintAlreadyFired;
            // Missed-parallelism steering: 2+ consecutive turns of a single
            // read-only tool call suggest the model isn't batching independent
            // lookups. Nudge once, then reset (fires again after 2 more).
            if (calls.length === 1 && isEagerDispatchable(calls[0].name, tools)) {
                _serialReadOnlyStreak += 1;
                if (_serialReadOnlyStreak >= 2 && !_hintFiredThisTurn) {
                    _serialReadOnlyStreak = 0;
                    // Escalation ladder (Step 1). Cumulative level-1 fires are
                    // tracked and NEVER reset. Once level-1 has fired >=3 times with
                    // ZERO edits, escalate to level-2 steering (blocked-report is a
                    // valid completion) instead of the batching nudge — latched to at
                    // most once per 5 turns.
                    _level1FireCount += 1;
                    if (_level1FireCount >= 3 && editCount === 0 && (iterations - _level2LatchAtIteration) >= 5) {
                        _emitLevel2Steer();
                    } else {
                        pushSystemReminder('Last 2 turns each ran a single read-only tool. Batch independent lookups (read/grep/glob/code_graph) into ONE turn, or start editing if you have enough context.');
                    }
                    _hintFiredThisTurn = true;
                }
            } else {
                _serialReadOnlyStreak = 0;
            }
            // Independent all-read-only escalation (audit finding): the level-1
            // streak above only counts single-call turns, so a worker that runs
            // 2+ read-only calls per turn escapes the ladder entirely. Track a
            // cumulative count of consecutive turns where EVERY call is read-only
            // (any count) and no edit has been made; at 12 such turns fire level-2
            // directly (same once-per-5-turn latch), reset on any edit.
            {
                const _allReadOnly = calls.length > 0 && calls.every((c) => isEagerDispatchable(c.name, tools));
                if (_allReadOnly && editCount === 0) {
                    _allReadOnlyStreak += 1;
                    if (_allReadOnlyStreak >= 12 && (iterations - _level2LatchAtIteration) >= 5 && !_hintFiredThisTurn) {
                        _emitLevel2Steer();
                        _hintFiredThisTurn = true;
                    }
                } else {
                    _allReadOnlyStreak = 0;
                }
            }
            const _grepCalls = calls.filter((c) => c?.name === 'grep');
            const _allGrep = calls.length > 0 && _grepCalls.length === calls.length;
            // Detector: repeated identifier-like grep in source dirs → code_graph.
            // Symbol lookups (a bare \w+ token scoped to src/) belong in
            // code_graph (find_symbol/references/callers), not text grep. Fires
            // when the same token is grepped on 2+ consecutive qualifying turns.
            {
                let _identTok = null;
                for (const c of _grepCalls) {
                    const _srcScoped = _pathsOf(c?.arguments?.path).some((p) => _SRC_DIR_RE.test(p));
                    if (!_srcScoped) continue;
                    const _hit = _grepPatterns(c).map((p) => p.trim()).find((p) => _IDENT_RE.test(p));
                    if (_hit) { _identTok = _hit.toLowerCase(); break; }
                }
                if (_identTok) {
                    if (_identTok === _identGrepToken) _identGrepStreak += 1;
                    else { _identGrepToken = _identTok; _identGrepStreak = 1; }
                    if (_identGrepStreak >= 2 && !_hintFiredThisTurn) {
                        pushSystemReminder(`Grepping the symbol "${_identGrepToken}" across source dirs again — use code_graph (find_symbol/references/callers) for symbol lookups instead of text grep.`);
                        _identGrepStreak = 0;
                        _identGrepToken = null;
                        _hintFiredThisTurn = true;
                    }
                } else {
                    _identGrepStreak = 0;
                    _identGrepToken = null;
                }
            }
            // Same-concept grep cluster (broadened serial-rewording): 3+
            // consecutive grep-only turns on one concept — related by
            // an exact-same path, OR a sibling/variant path that ALSO shares a
            // pattern token (sibling alone is too loose to count).
            // Fires once per spiral, then resets; read-the-span is the answer.
            {
                if (_allGrep) {
                    const _paths = [];
                    const _tokens = new Set();
                    for (const c of _grepCalls) {
                        for (const p of _pathsOf(c?.arguments?.path)) _paths.push(p);
                        for (const t of _patternTokens(c)) _tokens.add(t);
                    }
                    let _related = false;
                    if (_sameGrepPrev) {
                        // Exact same-path spiral fires alone; a merely sibling/
                        // variant path must ALSO share a pattern token to count.
                        const _pathExact = _paths.some((a) => _sameGrepPrev.paths.some((b) => _samePath(a, b)));
                        const _pathRel = _paths.some((a) => _sameGrepPrev.paths.some((b) => _pathsRelated(a, b)));
                        const _tokRel = _setsOverlap(_tokens, _sameGrepPrev.tokens);
                        _related = _pathExact || (_pathRel && _tokRel);
                    }
                    _sameGrepStreak = _related ? _sameGrepStreak + 1 : 1;
                    const _label = _paths[0] || [..._tokens][0] || 'same concept';
                    _sameGrepPrev = { paths: _paths, tokens: _tokens };
                    if (_sameGrepStreak >= 3 && !_hintFiredThisTurn) {
                        pushSystemReminder(`3+ consecutive grep turns on the same concept (${_label}) — reworded patterns / sibling paths are not converging. Read the relevant span (read with offset/limit) or act on what you have.`);
                        _sameGrepStreak = 0;
                        _sameGrepPrev = null;
                        _hintFiredThisTurn = true;
                    }
                } else {
                    _sameGrepStreak = 0;
                    _sameGrepPrev = null;
                }
            }
            // Detector: content/context grep on X then read of X next turn — the
            // grep context should have sufficed. Fire off the PRIOR turn's
            // uncapped content grep, then recompute for the next turn (skip when
            // the grep was capped via head_limit or paths-only mode).
            {
                if (_lastGrepContentPaths && !_hintFiredThisTurn) {
                    const _readCall = calls.find((c) => c?.name === 'read');
                    if (_readCall) {
                        const _rp = _pathsOf(_readCall?.arguments?.path);
                        // Same-file only — a sibling read is a new lookup, not a re-read.
                        const _hit = _rp.find((p) => [..._lastGrepContentPaths].some((g) => _samePath(p, g)));
                        if (_hit) {
                            pushSystemReminder(`Reading ${_baseName(_hit)} right after a content grep on it — the grep context should have sufficed; answer from grep output or widen -C instead of re-reading.`);
                            _hintFiredThisTurn = true;
                        }
                    }
                }
                const _next = new Set();
                for (const c of _grepCalls) {
                    const a = c?.arguments || {};
                    const _hasCtx = a['-A'] != null || a['-B'] != null || a['-C'] != null;
                    const _isContent = a.output_mode === 'content' || a.output_mode === 'content_with_context' || _hasCtx;
                    const _pathsOnly = a.output_mode === 'files_with_matches' || a.output_mode === 'count';
                    const _capped = a.head_limit != null;
                    if (_isContent && !_pathsOnly && !_capped) {
                        for (const p of _pathsOf(a.path)) _next.add(p);
                    }
                }
                _lastGrepContentPaths = _next.size ? _next : null;
            }
            // Detector: read fragmentation — 2nd+ single-window read into the
            // SAME file with offsets inside an 800-line span means the model is
            // paging small windows across turns instead of reading one wider
            // span (or batching {path,offset,limit}[] regions in one call).
            {
                for (const c of calls.filter((x) => x?.name === 'read')) {
                    const _byPath = new Map();
                    for (const w of _readWindows(c)) {
                        const k = _normPath(w.path);
                        if (!_byPath.has(k)) _byPath.set(k, []);
                        _byPath.get(k).push(w);
                    }
                    for (const [k, ws] of _byPath) {
                        if (ws.length !== 1) continue; // batched regions on one path — the good form
                        const off = ws[0].offset;
                        if (!Number.isFinite(off) || off <= 0) continue;
                        let rec = _readWindowsByPath.get(k);
                        if (!rec) {
                            rec = { offsets: [], fired: false };
                            _readWindowsByPath.set(k, rec);
                            if (_readWindowsByPath.size > 32) _readWindowsByPath.delete(_readWindowsByPath.keys().next().value);
                        }
                        rec.offsets.push(off);
                        if (!rec.fired && !_hintFiredThisTurn && rec.offsets.length >= 2
                            && (Math.max(...rec.offsets) - Math.min(...rec.offsets)) <= 800) {
                            pushSystemReminder(`Windowed reads are fragmenting ${_baseName(k)} — stop paging small windows; read ONE wider span, or batch all needed spans as {path,offset,limit}[] regions in a single call.`);
                            rec.fired = true;
                            _hintFiredThisTurn = true;
                        }
                    }
                }
            }
            // Detector: read-only shell (git status/log/diff --stat, ls/dir/cat/
            // type/Get-ChildItem) inspects state the dedicated tools cover.
            // Nudge toward them; never blocks execution.
            {
                if (!_hintFiredThisTurn && calls.some((c) => c?.name === 'shell' && _isReadOnlyShellCmd(c?.arguments?.command))) {
                    pushSystemReminder('Read-only shell (git status/log/diff --stat, ls/dir/cat/type/Get-ChildItem) inspects state the dedicated tools cover — use grep/read/list/find/code_graph; shell is for changing state or running programs.');
                    _hintFiredThisTurn = true;
                }
            }
        },
        // Reviewer fix: a zero-tool turn must not bridge ANY cross-turn streak
        // across non-tool turns — that would fire level-2 (or the grep/read
        // detectors) early on a worker that paused to synthesize text mid-run.
        resetAllReadOnlyStreak() {
            _allReadOnlyStreak = 0;
            _serialReadOnlyStreak = 0;
            _sameGrepStreak = 0;
            _sameGrepPrev = null;
            _lastGrepContentPaths = null;
            _identGrepStreak = 0;
            _identGrepToken = null;
        },
    };
}
