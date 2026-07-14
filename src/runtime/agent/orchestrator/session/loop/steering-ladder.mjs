// Completion-first steering ladder (worker runaway prevention), extracted from
// loop.mjs. Owns the mutable ladder counters and the post-batch steering-hint
// emitters. State is threaded live via a context object of getters/setters so
// no snapshot goes stale — the loop mutates `messages`/`iterations` in place and
// this module reads them through the accessors on each call. No behavior change:
// the counters, thresholds, and emitted messages are verbatim from agentLoop.
import { appendAgentTrace } from '../../agent-trace.mjs';
import { level2SteerMessage } from './completion-guards.mjs';
import { isEagerDispatchable } from './tool-helpers.mjs';

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
    // Edit-push steering is EXPLORER-ONLY: leads legitimately read broadly
    // before delegating, and reviewer/debugger-style roles read continuously
    // by design. Pushing "start editing / apply the edit" at those roles
    // suppresses delegation (observed on TB2.1: forced-delegation workflow
    // leads went solo right after these nudges). Non-explorer roles keep the
    // batching guidance but never receive an edit directive, and level-2
    // edit-push is skipped for them entirely.
    const editPushEligible = sessionAgent === 'explorer';

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
    let _level2FireCount = 0;

    // Level-2 steering emitter shared by both ladder paths (single-call
    // level-1 streak and the independent all-read-only streak). Sets the latch
    // so it fires at most once per 5 turns regardless of which path triggered.
    const _emitLevel2Steer = () => {
        if (!editPushEligible && !readOnlyRole) return;
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
            // Steering hint gate: at most ONE hint per turn.
            let _hintFiredThisTurn = hintAlreadyFired;
            // Missed-parallelism steering: 2+ consecutive turns of a single
            // read-only tool call suggest the model isn't batching independent
            // lookups. Nudge once, then reset (fires again after 2 more).
            if (calls.length === 1 && isEagerDispatchable(calls[0].name, tools)) {
                _serialReadOnlyStreak += 1;
                // Escalation ladder (Step 1). Cumulative level-1 fires are tracked
                // and NEVER reset. Once level-1 has fired >=3 times with ZERO edits,
                // escalate to level-2 steering (latched once per 5 turns). The
                // level-2 escalation always wins.
                const _canEscalate = (_level1FireCount + 1) >= 3 && editCount === 0 && (iterations - _level2LatchAtIteration) >= 5;
                if (_serialReadOnlyStreak >= 2 && !_hintFiredThisTurn) {
                    _serialReadOnlyStreak = 0;
                    _level1FireCount += 1;
                    if (_canEscalate) {
                        _emitLevel2Steer();
                    } else {
                        pushSystemReminder(editPushEligible
                            ? 'Last 2 turns each ran a single read-only tool. Batch independent lookups (read/grep/glob/code_graph) into ONE turn, or start editing if you have enough context.'
                            : 'Last 2 turns each ran a single read-only tool. Batch independent lookups (read/grep/glob/code_graph) into ONE turn.');
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
        // A zero-tool turn must not bridge any cross-turn ladder streak.
        resetAllReadOnlyStreak() {
            _allReadOnlyStreak = 0;
            _serialReadOnlyStreak = 0;
        },
    };
}
