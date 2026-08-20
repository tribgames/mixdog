import {
    existsSync,
    mkdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from 'fs';
import { writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { getPluginData } from '../../config.mjs';
import { renameWithRetrySync } from '../../../../shared/atomic-file.mjs';
import { sanitizeContentForStoredHistory } from '../../providers/media-normalization.mjs';
import { promptContentText } from './prompt-utils.mjs';
import { finalizeTurnInterruptionSnapshot } from './turn-interruption.mjs';

const TURN_CHECKPOINT_VERSION = 1;
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

function checkpointDir() {
    const dir = join(getPluginData(), 'turn-checkpoints');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

function turnCheckpointPath(sessionId) {
    if (!SESSION_ID.test(String(sessionId || ''))) {
        throw new Error(`[turn-checkpoint] invalid session id: ${JSON.stringify(sessionId)}`);
    }
    return join(checkpointDir(), `${sessionId}.json`);
}

function checkpointMessage(message) {
    if (!message || typeof message !== 'object') return message;
    const content = sanitizeContentForStoredHistory(message.content);
    return content === message.content ? message : { ...message, content };
}

function matchingUserMessage(message, currentUserContent) {
    return message?.role === 'user'
        && (message.content === currentUserContent
            || promptContentText(message.content) === promptContentText(currentUserContent));
}

export function turnMessagesForCheckpoint(messages, currentUserContent) {
    const source = Array.isArray(messages) ? messages : [];
    let start = -1;
    for (let index = source.length - 1; index >= 0; index -= 1) {
        if (matchingUserMessage(source[index], currentUserContent)) {
            start = index;
            break;
        }
    }
    const turn = start >= 0 ? source.slice(start) : [];
    return turn.map(checkpointMessage);
}

/** Read-only projection for a turn still owned by another process. Unlike
 * recoverTurnCheckpoint this never mutates the session, clears the checkpoint,
 * or marks a live turn as interrupted. */
export function projectTurnCheckpointMessages(session, checkpoint) {
    const source = Array.isArray(session?.messages) ? session.messages : [];
    if (!session?.id || checkpoint?.sessionId !== session.id
        || !Array.isArray(checkpoint?.turnMessages)) return source;
    const sessionGeneration = Number(session.generation) || 0;
    const checkpointGeneration = Number(checkpoint.generation) || 0;
    const markerToken = typeof session.activeTurnCheckpoint?.turnToken === 'string'
        ? session.activeTurnCheckpoint.turnToken
        : null;
    const markerMatches = markerToken === checkpoint.turnToken;
    const checkpointIsNewer = Number(checkpoint.updatedAt) > Number(session.updatedAt || 0);
    if (checkpointGeneration !== sessionGeneration
        || (markerToken && !markerMatches)
        || (!markerToken && !checkpointIsNewer)) return source;
    let start = -1;
    for (let index = source.length - 1; index >= 0; index -= 1) {
        if (matchingUserMessage(source[index], checkpoint.currentUserContent)) {
            start = index;
            break;
        }
    }
    return [
        ...(start >= 0 ? source.slice(0, start) : source),
        ...checkpoint.turnMessages,
    ];
}

// ── Async checkpoint writes ──────────────────────────────────────────────────
// The throttled streaming-delta flushes used to serialize+write synchronously
// on the engine thread (up to ~6 stalls/second during a tool-heavy turn). The
// async lane keeps per-session latest-wins coalescing (one in-flight write,
// one queued payload) with an epoch so clear/stop can retire stale writes —
// no locks, sessions stay fully parallel. The FIRST write of a turn stays
// sync (opts.sync) because it is the crash-durability anchor for the prompt.
const _pendingCheckpointWrites = new Map(); // sessionId → { queued, writing, epoch }
const _asyncWriteWarned = new Set(); // sessionId — warn once per session

function _warnAsyncWriteOnce(sessionId, error) {
    if (_asyncWriteWarned.has(sessionId)) return;
    _asyncWriteWarned.add(sessionId);
    try {
        process.stderr.write(`[turn-checkpoint] async write failed session=${sessionId}: ${error?.message || error}\n`);
    } catch { /* stderr best-effort */ }
}

/** Retire queued + in-flight async writes for a session (epoch bump). */
export function cancelPendingTurnCheckpoint(sessionId) {
    const entry = _pendingCheckpointWrites.get(sessionId);
    if (!entry) return;
    entry.queued = null;
    entry.epoch += 1;
    if (!entry.writing) _pendingCheckpointWrites.delete(sessionId);
}

function _pumpCheckpointWrites(sessionId) {
    const entry = _pendingCheckpointWrites.get(sessionId);
    if (!entry || entry.writing) return;
    if (!entry.queued) {
        _pendingCheckpointWrites.delete(sessionId);
        return;
    }
    const { target, json } = entry.queued;
    entry.queued = null;
    entry.writing = true;
    const epoch = entry.epoch;
    const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    writeFile(temp, json, 'utf8')
        .then(() => {
            // A clear/stop after this write was dequeued must win: renaming a
            // retired payload would resurrect a checkpoint the turn already
            // finalized. The epoch check and rename run in one synchronous
            // block, so cancel (also synchronous) can never interleave.
            if (entry.epoch !== epoch) {
                try { unlinkSync(temp); } catch { /* best-effort */ }
                return;
            }
            renameWithRetrySync(temp, target);
        })
        .catch((error) => {
            try { unlinkSync(temp); } catch { /* best-effort */ }
            _warnAsyncWriteOnce(sessionId, error);
        })
        .finally(() => {
            entry.writing = false;
            _pumpCheckpointWrites(sessionId);
        });
}

// Hard-exit parity with the old sync behavior: a queued-but-unwritten payload
// is flushed synchronously so a clean process exit never loses the newest
// checkpoint state (crash loss remains bounded by the caller's throttle).
process.on('exit', () => {
    for (const [sessionId, entry] of _pendingCheckpointWrites) {
        if (!entry.queued) continue;
        const { target, json } = entry.queued;
        entry.queued = null;
        const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
        try {
            writeFileSync(temp, json, 'utf8');
            renameWithRetrySync(temp, target);
        } catch (error) {
            try { unlinkSync(temp); } catch { /* best-effort */ }
            _warnAsyncWriteOnce(sessionId, error);
        }
    }
});

export function writeTurnCheckpoint(checkpoint, { sync = true } = {}) {
    if (!checkpoint?.sessionId || !checkpoint?.turnToken) return false;
    const target = turnCheckpointPath(checkpoint.sessionId);
    const payload = {
        ...checkpoint,
        version: TURN_CHECKPOINT_VERSION,
        currentUserContent: sanitizeContentForStoredHistory(checkpoint.currentUserContent),
        turnMessages: (Array.isArray(checkpoint.turnMessages) ? checkpoint.turnMessages : [])
            .map(checkpointMessage),
        updatedAt: Date.now(),
    };
    if (!sync) {
        const json = JSON.stringify(payload);
        const entry = _pendingCheckpointWrites.get(checkpoint.sessionId)
            ?? { queued: null, writing: false, epoch: 0 };
        _pendingCheckpointWrites.set(checkpoint.sessionId, entry);
        entry.queued = { target, json };
        _pumpCheckpointWrites(checkpoint.sessionId);
        return true;
    }
    const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        writeFileSync(temp, JSON.stringify(payload), 'utf8');
        renameWithRetrySync(temp, target);
        return true;
    } catch (error) {
        try { unlinkSync(temp); } catch {}
        throw error;
    }
}

export function readTurnCheckpoint(sessionId) {
    const target = turnCheckpointPath(sessionId);
    try {
        const value = JSON.parse(readFileSync(target, 'utf8'));
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

export function clearTurnCheckpoint(sessionId, turnToken = null) {
    const target = turnCheckpointPath(sessionId);
    // Queued async writes are stale the moment the caller decides to clear
    // this turn's checkpoint; retire them BEFORE the token guard reads disk
    // so a lagging write can never resurrect the file after the unlink.
    if (!turnToken) cancelPendingTurnCheckpoint(sessionId);
    if (!existsSync(target)) return true;
    if (turnToken) {
        const current = readTurnCheckpoint(sessionId);
        // A token guard prevents an older turn's late terminal save from
        // deleting the checkpoint already created by its queued follow-up.
        if (current?.turnToken && current.turnToken !== turnToken) return false;
        cancelPendingTurnCheckpoint(sessionId);
    }
    try {
        unlinkSync(target);
        return true;
    } catch {
        return false;
    }
}

function findPersistedTurnStart(messages, currentUserContent) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (matchingUserMessage(messages[index], currentUserContent)) return index;
    }
    return -1;
}

/**
 * Merge a force-killed turn checkpoint into a loaded session. The caller must
 * durably save the mutated session before clearing the returned token.
 */
export function recoverTurnCheckpoint(session) {
    if (!session?.id || session.closed === true) {
        return { changed: false, recovered: false, turnToken: null };
    }
    const checkpoint = readTurnCheckpoint(session.id);
    const marker = session.activeTurnCheckpoint;
    if (!checkpoint) {
        if (!marker) return { changed: false, recovered: false, turnToken: null };
        delete session.activeTurnCheckpoint;
        return { changed: true, recovered: false, turnToken: null };
    }

    const sessionGeneration = Number(session.generation) || 0;
    const checkpointGeneration = Number(checkpoint.generation) || 0;
    const markerToken = typeof marker?.turnToken === 'string' ? marker.turnToken : null;
    const markerMatches = markerToken === checkpoint.turnToken;
    const checkpointIsNewer = Number(checkpoint.updatedAt) > Number(session.updatedAt || 0);
    if (checkpointGeneration !== sessionGeneration
        || (markerToken && !markerMatches)
        || (!markerToken && !checkpointIsNewer)) {
        clearTurnCheckpoint(session.id, checkpoint.turnToken);
        if (markerToken === checkpoint.turnToken) delete session.activeTurnCheckpoint;
        return { changed: false, recovered: false, turnToken: null };
    }

    const finalized = finalizeTurnInterruptionSnapshot({
        turnOutgoing: checkpoint.turnMessages,
        currentUserContent: checkpoint.currentUserContent,
        snapshot: checkpoint.interruption,
        abortReason: 'process-crash',
    });
    const current = Array.isArray(session.messages) ? session.messages : [];
    const start = findPersistedTurnStart(current, checkpoint.currentUserContent);
    session.messages = [
        ...(start >= 0 ? current.slice(0, start) : current),
        ...finalized.messages,
    ];
    delete session.activeTurnCheckpoint;
    delete session.providerState;
    session.updatedAt = Date.now();
    session.lastUsedAt = Date.now();
    return {
        changed: true,
        recovered: true,
        turnToken: checkpoint.turnToken,
        responsePreserved: finalized.responsePreserved,
    };
}
