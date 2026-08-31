// manager/turn-checkpoint-journal.mjs
// Bounded-cost, crash-safe turn checkpointing.
//
// PROBLEM. The turn checkpoint used to be a single full-snapshot file that was
// rewritten on every flush (up to ~6/s per live session): the WHOLE growing
// turn — every committed message, every buffered partial character, every
// observed tool call — was re-sanitized and re-serialized on the engine thread.
// Cost per flush grew with the turn (O(turn^2) over a long tool-heavy turn) and
// at maximum agent fan-out every live session paid it on the SAME event loop.
//
// DESIGN. Split the checkpoint into a write-once header plus an append-only
// delta journal:
//   <session>.json    header — written ONCE per turn, synchronously, atomically.
//                     It carries the prompt, so prompt durability is anchored
//                     before the provider ever runs, and store-summary-reader
//                     keeps probing this exact path to detect a live turn.
//   <session>.jsonl   append-only JSONL deltas — NEW/CHANGED turn messages (by
//                     turn-relative index), a one-time full replacement when
//                     compaction removes the opening prompt, APPENDED partial
//                     text/reasoning and small interruption-state transitions.
//                     A normal flush costs O(new bytes), never O(turn).
// Appends ride a bounded coalescing lane (one in-flight write, one pending
// buffer, synchronous drain above the byte ceiling) so the engine thread never
// blocks on disk and the queue can never grow without limit.
//
// Change detection is reference identity on message objects — the same contract
// the session store's delta saves already rely on ("Replace, never mutate":
// manager/prompt-utils.mjs, manager/session-lifecycle.mjs). A wholesale
// transcript rewrite (image-strip splice, pre-send compaction) replaces the
// refs, so it journals as changed indices plus a truncation record.
//
// Reads replay header+journal into the EXACT object shape the full-snapshot
// writer produced, so recovery/projection semantics are unchanged. A crash-torn
// trailing line is discarded: replay stops at the first unparsable record and
// keeps the durable prefix.
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from 'fs';
import { appendFile, unlink, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { getPluginData } from '../../config.mjs';
import { renameWithRetrySync } from '../../../../shared/atomic-file.mjs';
import { sanitizeContentForStoredHistory } from '../../providers/media-normalization.mjs';
import { promptContentText } from './prompt-utils.mjs';

export const TURN_CHECKPOINT_VERSION = 1;
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
// Ceiling for records queued but not yet handed to the OS. Reaching it means
// the append lane cannot keep up; the writer then drains synchronously rather
// than dropping records — recovery correctness outranks a rare, bounded stall.
const MAX_PENDING_JOURNAL_BYTES = 4 * 1024 * 1024;

export function checkpointDir() {
    const dir = join(getPluginData(), 'turn-checkpoints');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

function assertSessionId(sessionId) {
    if (!SESSION_ID.test(String(sessionId || ''))) {
        throw new Error(`[turn-checkpoint] invalid session id: ${JSON.stringify(sessionId)}`);
    }
    return sessionId;
}

export function turnCheckpointPath(sessionId) {
    assertSessionId(sessionId);
    return join(checkpointDir(), `${sessionId}.json`);
}

export function turnJournalPath(sessionId) {
    assertSessionId(sessionId);
    return join(checkpointDir(), `${sessionId}.jsonl`);
}

export function checkpointMessage(message) {
    if (!message || typeof message !== 'object') return message;
    const content = sanitizeContentForStoredHistory(message.content);
    return content === message.content ? message : { ...message, content };
}

export function matchingUserMessage(message, currentUserContent) {
    return message?.role === 'user'
        && (message.content === currentUserContent
            || promptContentText(message.content) === promptContentText(currentUserContent));
}

/** Index of the user message that opened this turn, or -1. */
export function findTurnStart(messages, currentUserContent) {
    const source = Array.isArray(messages) ? messages : [];
    for (let index = source.length - 1; index >= 0; index -= 1) {
        if (matchingUserMessage(source[index], currentUserContent)) return index;
    }
    return -1;
}

export function turnMessagesForCheckpoint(messages, currentUserContent) {
    const source = Array.isArray(messages) ? messages : [];
    const start = findTurnStart(source, currentUserContent);
    const turn = start >= 0 ? source.slice(start) : [];
    return turn.map(checkpointMessage);
}

export function emptyInterruptionSnapshot() {
    return {
        responseStarted: false,
        partialAssistantContent: '',
        partialReasoningContent: '',
        phase: 'streaming',
        observedToolCalls: [],
        observedToolResults: [],
    };
}

// ── Header (write-once, atomic) ─────────────────────────────────────────────

export function writeCheckpointHeader(checkpoint) {
    const target = turnCheckpointPath(checkpoint.sessionId);
    const payload = {
        ...checkpoint,
        version: TURN_CHECKPOINT_VERSION,
        currentUserContent: sanitizeContentForStoredHistory(checkpoint.currentUserContent),
        turnMessages: (Array.isArray(checkpoint.turnMessages) ? checkpoint.turnMessages : [])
            .map(checkpointMessage),
        interruption: checkpoint.interruption ?? emptyInterruptionSnapshot(),
        contextState: checkpoint.contextState ?? null,
        updatedAt: Date.now(),
    };
    const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        writeFileSync(temp, JSON.stringify(payload), 'utf8');
        renameWithRetrySync(temp, target);
        return true;
    } catch (error) {
        try { unlinkSync(temp); } catch { /* best-effort */ }
        throw error;
    }
}

export function readTurnCheckpointHeader(sessionId) {
    try {
        const value = JSON.parse(readFileSync(turnCheckpointPath(sessionId), 'utf8'));
        if (value?.version !== TURN_CHECKPOINT_VERSION
            || value?.sessionId !== sessionId
            || !value?.turnToken
            || !Array.isArray(value?.turnMessages)) {
            return null;
        }
        return value;
    } catch {
        return null;
    }
}

// ── Write lane: ONE total per-session order ─────────────────────────────────
// Every journal mutation — delta append, turn open (truncate+head), and
// removal — goes through a single ordered per-session queue with at most one
// operation in flight. Nothing may ever jump ahead of an accepted older write:
//   * consecutive appends coalesce into one chunk (the bounded-cost lane),
//   * a new turn's open FENCES older in-flight appends by queueing behind them,
//     so an old turn's records can never land beneath a new turn token,
//   * the overflow drain runs synchronously ONLY when nothing is in flight,
//   * process exit re-writes the in-flight operation and then the queue, in
//     order — record sequence numbers make that re-write idempotent.
// sessionId → { path, ops: [], bytes, writing, inFlight }
const _journalWrites = new Map();
const _journalWarned = new Set();

// Test seam: awaited before every async operation so a test can hold a write
// genuinely in flight and drive the reset/clear/stop/exit races deterministically.
let _journalOpGate = null;
export function _setJournalOpGateForTest(gate) {
    _journalOpGate = typeof gate === 'function' ? gate : null;
}

function _warnJournalOnce(sessionId, error) {
    if (_journalWarned.has(sessionId)) return;
    _journalWarned.add(sessionId);
    try {
        process.stderr.write(`[turn-checkpoint] journal write failed session=${sessionId}: ${error?.message || error}\n`);
    } catch { /* stderr best-effort */ }
}

function _runJournalOpSync(op) {
    if (op.kind === 'append') {
        appendFileSync(op.path, op.data, 'utf8');
        return;
    }
    if (op.kind === 'reset') {
        writeFileSync(op.path, op.data, 'utf8');
        return;
    }
    try {
        unlinkSync(op.path);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

async function _runJournalOpAsync(op) {
    if (_journalOpGate) await _journalOpGate(op);
    if (op.kind === 'append') return appendFile(op.path, op.data, 'utf8');
    if (op.kind === 'reset') return writeFile(op.path, op.data, 'utf8');
    try {
        await unlink(op.path);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    return undefined;
}

function _releaseIdleEntry(sessionId, entry) {
    if (!entry.writing && entry.ops.length === 0) _journalWrites.delete(sessionId);
}

/** Drain the queue in order on the calling thread. Only ever called when no
 * operation is in flight, so a synchronous write cannot overtake an older one. */
function _drainJournalOpsSync(sessionId, entry) {
    const ops = entry.ops;
    entry.ops = [];
    entry.bytes = 0;
    for (const op of ops) {
        try {
            _runJournalOpSync(op);
        } catch (error) {
            _warnJournalOnce(sessionId, error);
            break;
        }
    }
    _releaseIdleEntry(sessionId, entry);
}

function _pumpJournal(sessionId) {
    const entry = _journalWrites.get(sessionId);
    if (!entry || entry.writing) return;
    if (entry.ops.length === 0) {
        _journalWrites.delete(sessionId);
        return;
    }
    if (entry.bytes >= MAX_PENDING_JOURNAL_BYTES) {
        // Back-pressure: the producer outran the lane. Draining synchronously is
        // safe here and ONLY here — the queue is the oldest accepted work, so
        // nothing older can land after it.
        _drainJournalOpsSync(sessionId, entry);
        return;
    }
    const op = entry.ops.shift();
    if (op.kind === 'append') entry.bytes = Math.max(0, entry.bytes - op.data.length);
    entry.writing = true;
    entry.inFlight = op;
    _runJournalOpAsync(op)
        .catch((error) => { _warnJournalOnce(sessionId, error); })
        .finally(() => {
            entry.writing = false;
            entry.inFlight = null;
            _pumpJournal(sessionId);
        });
}

function _enqueueJournalOp(sessionId, op) {
    const entry = _journalWrites.get(sessionId)
        ?? { path: op.path, ops: [], bytes: 0, writing: false, inFlight: null };
    _journalWrites.set(sessionId, entry);
    const last = entry.ops[entry.ops.length - 1];
    if (op.kind === 'append' && last?.kind === 'append' && last.path === op.path) {
        last.data += op.data;
    } else {
        entry.ops.push(op);
    }
    if (op.kind === 'append') entry.bytes += op.data.length;
    _pumpJournal(sessionId);
    return entry;
}

/**
 * Retire queued (not yet written) delta appends. The durable prefix on disk
 * stays: between turn commit and clearTurnCheckpoint a crash must still recover
 * the turn's work, not just its opening header. Structural operations already
 * queued (open/remove) keep their slot in the total order.
 */
export function cancelJournalWrites(sessionId) {
    const entry = _journalWrites.get(sessionId);
    if (!entry) return;
    entry.ops = entry.ops.filter((op) => op.kind !== 'append');
    entry.bytes = 0;
    _releaseIdleEntry(sessionId, entry);
}

export function appendJournalLines(sessionId, lines) {
    if (!Array.isArray(lines) || lines.length === 0) return false;
    _enqueueJournalOp(sessionId, {
        kind: 'append',
        path: turnJournalPath(sessionId),
        data: lines.join(''),
    });
    return true;
}

/**
 * Truncate + head-write the journal for a NEW turn. Returns true when it landed
 * synchronously (the common case: the previous turn's lane is idle). When an
 * older write is still in flight the open is QUEUED behind it instead: the
 * durability anchor is the atomically written `.json` header, and until the
 * queued open runs the on-disk journal still carries the OLD head token, which
 * replay rejects. Truncating under an in-flight append would instead let that
 * append land beneath the new turn's head and resurrect an old turn.
 */
export function openJournalForTurn(sessionId, openLines) {
    const path = turnJournalPath(sessionId);
    const data = (Array.isArray(openLines) ? openLines : []).join('');
    cancelJournalWrites(sessionId);
    if (!_journalWrites.has(sessionId)) {
        writeFileSync(path, data, 'utf8');
        return true;
    }
    _enqueueJournalOp(sessionId, { kind: 'reset', path, data });
    return false;
}

/** Opening lines for a journal with no encoder behind it (full-snapshot
 * writes): just the sequence-0 head record that binds the file to its turn. */
export function journalHeadLines(turnToken) {
    return [`${JSON.stringify({ t: 'h', turnToken, at: Date.now(), s: 0 })}\n`];
}

export function removeTurnJournal(sessionId) {
    const path = turnJournalPath(sessionId);
    cancelJournalWrites(sessionId);
    if (!_journalWrites.has(sessionId)) {
        try { unlinkSync(path); } catch { /* best-effort */ }
        return true;
    }
    // An older write is in flight; unlinking now would let it recreate the file
    // behind us. Queue the removal so it runs after that write.
    _enqueueJournalOp(sessionId, { kind: 'remove', path });
    return false;
}

/** Test/shutdown helper: resolve once the write lane for a session is idle. */
export async function settleTurnJournalWrites(sessionId, { timeoutMs = 5_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const entry = _journalWrites.get(sessionId);
        if (!entry || (!entry.writing && entry.ops.length === 0)) return true;
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => { setTimeout(resolve, 1); });
    }
}

// Explicit process exit: after this handler returns the process dies, so an
// operation already handed to the threadpool may have landed fully, partially,
// or not at all, and the queued operations behind it would be lost outright.
// Re-write the in-flight operation FIRST and then the queue, in order. Record
// sequence numbers make a duplicated re-write a no-op at replay and a torn
// fragment is skipped, so this can only ever add durability.
process.on('exit', () => {
    for (const [sessionId, entry] of _journalWrites) {
        const ops = entry.inFlight ? [entry.inFlight, ...entry.ops] : entry.ops.slice();
        if (ops.length === 0) continue;
        entry.ops = [];
        entry.bytes = 0;
        entry.inFlight = null;
        for (const op of ops) {
            try {
                _runJournalOpSync(op);
            } catch (error) {
                _warnJournalOnce(sessionId, error);
                break;
            }
        }
    }
});

// ── Delta encoding / replay ─────────────────────────────────────────────────

function interruptionStateFromSnapshot(snapshot) {
    const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
    return {
        responseStarted: source.responseStarted === true,
        text: String(source.partialAssistantContent || ''),
        tomb: '',
        reasoning: String(source.partialReasoningContent || ''),
        phase: source.phase === 'tools' ? 'tools' : 'streaming',
        calls: new Map(Array.isArray(source.observedToolCalls) ? source.observedToolCalls : []),
        results: new Map(Array.isArray(source.observedToolResults) ? source.observedToolResults : []),
    };
}

function interruptionSnapshotFromState(state) {
    return {
        responseStarted: state.responseStarted,
        // Same combination rule the live tracker's snapshot() uses: text the UI
        // was told to retract still counts as bytes a crash cannot replace.
        partialAssistantContent: state.text + state.tomb,
        partialReasoningContent: state.reasoning,
        phase: state.phase,
        observedToolCalls: [...state.calls.entries()],
        observedToolResults: [...state.results.entries()],
    };
}

export function applyInterruptionDelta(state, delta) {
    if (!delta || typeof delta !== 'object') return state;
    if (typeof delta.rs === 'boolean') state.responseStarted = delta.rs;
    if (delta.ph === 'tools' || delta.ph === 'streaming') state.phase = delta.ph;
    if (typeof delta.ts === 'string') state.text = delta.ts;
    if (typeof delta.ta === 'string') state.text += delta.ta;
    if (typeof delta.qs === 'string') state.reasoning = delta.qs;
    if (typeof delta.qa === 'string') state.reasoning += delta.qa;
    if (typeof delta.tb === 'string') state.tomb = delta.tb;
    if (delta.cc === true) state.calls.clear();
    for (const pair of Array.isArray(delta.cs) ? delta.cs : []) {
        if (Array.isArray(pair) && pair.length === 2) state.calls.set(pair[0], pair[1]);
    }
    for (const pair of Array.isArray(delta.os) ? delta.os : []) {
        if (Array.isArray(pair) && pair.length === 2) state.results.set(pair[0], pair[1]);
    }
    for (const id of Array.isArray(delta.od) ? delta.od : []) state.results.delete(id);
    return state;
}

/** Merge the append-only journal onto its header. Returns the header unchanged
 * when no journal exists, when the journal belongs to another turn, or when it
 * has no usable head record. */
export function replayTurnJournal(header) {
    if (!header) return null;
    let raw;
    try {
        raw = readFileSync(turnJournalPath(header.sessionId), 'utf8');
    } catch {
        return header;
    }
    let messages = header.turnMessages.slice();
    let fullTranscript = header.fullTranscript === true;
    let contextState = header.contextState ?? null;
    const state = interruptionStateFromSnapshot(header.interruption);
    let updatedAt = Number(header.updatedAt) || 0;
    let head = false;
    // Records are sequence-numbered per turn, so replay is exact under the two
    // things a crash-safe append lane can produce: a DUPLICATE (the exit
    // handler re-writes an operation that may already have landed) and a TORN
    // fragment. Duplicates are skipped, unparsable lines are skipped, and a
    // real gap ends the durable prefix — a missing delta must never let later
    // (relative) deltas apply out of order.
    let expected = 0;
    for (const line of raw.split('\n')) {
        if (!line) continue;
        let record;
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }
        if (!record || typeof record !== 'object') continue;
        const seq = Number(record.s);
        if (!Number.isInteger(seq) || seq < 0) continue;
        if (seq < expected) continue;
        if (seq > expected) break;
        expected = seq + 1;
        if (!head) {
            if (record.t !== 'h' || record.turnToken !== header.turnToken) return header;
            head = true;
            continue;
        }
        if (record.t === 'm') {
            const index = Number(record.i);
            if (Number.isInteger(index) && index >= 0 && index <= messages.length) {
                messages[index] = record.m;
            }
        } else if (record.t === 'full' && Array.isArray(record.ms)) {
            messages = record.ms.slice();
            fullTranscript = true;
        } else if (record.t === 'len') {
            const next = Number(record.n);
            if (Number.isInteger(next) && next >= 0 && next <= messages.length) {
                messages.length = next;
            }
        } else if (record.t === 'x') {
            applyInterruptionDelta(state, record.d);
        } else if (record.t === 'c') {
            contextState = record.c ?? null;
        }
        const at = Number(record.at);
        if (Number.isFinite(at) && at > updatedAt) updatedAt = at;
    }
    if (!head) return header;
    return {
        ...header,
        turnMessages: messages,
        ...(fullTranscript ? { fullTranscript: true } : {}),
        interruption: interruptionSnapshotFromState(state),
        contextState,
        updatedAt,
    };
}

/**
 * Per-turn delta encoder. Holds the message refs already journaled (by
 * turn-relative index) plus an opaque interruption cursor, so each encode()
 * touches only what changed since the previous flush.
 */
export function createTurnJournalEncoder({ turnToken } = {}) {
    let journaled = [];
    let fullTranscript = false;
    let cursor = null;
    let contextStateKey = null;
    // Per-turn record sequence. It is assigned where records are produced, so
    // the number line is exactly the enqueue order the write lane preserves.
    let seq = 0;
    const line = (record) => {
        const stamped = { ...record, s: seq };
        seq += 1;
        return `${JSON.stringify(stamped)}\n`;
    };
    return {
        /** Seed from the turn's opening state; returns the header's messages
         * and the journal's opening lines (head record, plus — defensively —
         * the delta that makes the journal authoritative if the tracker already
         * carried state at open time). */
        seed(turnOutgoing, currentUserContent, interruption, contextState = null) {
            const source = Array.isArray(turnOutgoing) ? turnOutgoing : [];
            const start = findTurnStart(source, currentUserContent);
            fullTranscript = start < 0;
            journaled = fullTranscript ? source.slice() : source.slice(start);
            const seeded = typeof interruption?.journalDelta === 'function'
                ? interruption.journalDelta(null)
                : null;
            cursor = seeded ? seeded.cursor : null;
            contextStateKey = contextState == null ? null : JSON.stringify(contextState);
            seq = 0;
            const openLines = [line({ t: 'h', turnToken, at: Date.now() })];
            if (seeded?.changed) openLines.push(line({ t: 'x', d: seeded.delta, at: Date.now() }));
            return {
                turnMessages: journaled.map(checkpointMessage),
                fullTranscript,
                contextState,
                openLines,
            };
        },
        encode({ turnOutgoing, currentUserContent, interruption, contextState = null }) {
            const source = Array.isArray(turnOutgoing) ? turnOutgoing : [];
            const start = findTurnStart(source, currentUserContent);
            const records = [];
            if (!fullTranscript && start < 0) {
                // Pre-send compaction may replace the whole history, including
                // the user message that defined our turn-relative origin. The
                // replacement is normally small; persist it once so reconnect
                // and crash recovery never splice an empty turn onto the stale
                // pre-compaction prefix.
                fullTranscript = true;
                journaled = source.slice();
                records.push({
                    t: 'full',
                    ms: journaled.map(checkpointMessage),
                });
            } else {
                const offset = fullTranscript ? 0 : start;
                const length = offset >= 0 ? source.length - offset : 0;
                for (let index = 0; index < length; index += 1) {
                    const raw = source[offset + index];
                    if (journaled[index] === raw) continue;
                    journaled[index] = raw;
                    records.push({ t: 'm', i: index, m: checkpointMessage(raw) });
                }
                if (journaled.length > length) {
                    journaled.length = length;
                    records.push({ t: 'len', n: length });
                }
            }
            if (typeof interruption?.journalDelta === 'function') {
                const next = interruption.journalDelta(cursor);
                cursor = next.cursor;
                if (next.changed) records.push({ t: 'x', d: next.delta });
            }
            const nextContextStateKey = contextState == null ? null : JSON.stringify(contextState);
            if (nextContextStateKey !== contextStateKey) {
                contextStateKey = nextContextStateKey;
                records.push({ t: 'c', c: contextState });
            }
            if (records.length === 0) return [];
            // One timestamp per batch keeps `updatedAt` fresh for the
            // newer-than-session recovery guard without a per-record cost.
            records[records.length - 1].at = Date.now();
            return records.map(line);
        },
    };
}
