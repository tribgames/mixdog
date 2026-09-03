import { stat } from 'fs/promises';
import {
    isCompletionNotificationEntry,
    isStaleUserInjection,
    lateDeliveryText,
    normalizePendingMessageEntry,
    pendingMessageId,
    pendingMessageText,
} from './pending-message-entry.mjs';
import { isInternalRuntimeNotificationText } from './prompt-utils.mjs';

const HANDOFF_RETRY_MS = 1000;
const HANDOFF_RELEASE_SLACK_MS = 50;

function handoffOwnerIsLive(pid) {
    const value = Number(pid) || 0;
    if (value <= 0) return false;
    if (value === process.pid) return true;
    try {
        process.kill(value, 0);
        return true;
    } catch (err) {
        return err?.code !== 'ESRCH';
    }
}

/**
 * Owns cross-process pending-message polling and the durable two-phase handoff.
 * Queue storage and lifecycle authority stay in the parent pending-message
 * service and are supplied as narrow callbacks.
 */
export class ForeignPendingMessageController {
    constructor(dependencies) {
        this._dependencies = dependencies;
        this._scanLimit = Math.max(
            128,
            Number(process.env.MIXDOG_FOREIGN_SPOOL_SCAN_LIMIT) || 512,
        );
        this._handoffReleaseMs = Math.max(
            1000,
            Number(process.env.MIXDOG_FOREIGN_HANDOFF_RELEASE_MS) || 10000,
        );
        this._releaseTimers = new Map();
        this._drainRequests = new Map();
        this._scanMemo = new Map();
        this._drainScheduled = false;
        this._drainRunning = false;
    }

    cancelHandoffRelease(sessionId) {
        const existing = this._releaseTimers.get(sessionId);
        if (existing) {
            try { clearTimeout(existing.timer); } catch { /* best-effort */ }
        }
        this._releaseTimers.delete(sessionId);
    }

    async drainUserInjections(sessionId) {
        const {
            currentLifecycleToken,
            isValidSessionId,
            lifecycleInvalidated,
        } = this._dependencies;
        if (!isValidSessionId(sessionId)) return [];
        const epochToken = currentLifecycleToken(sessionId);
        if (lifecycleInvalidated(sessionId)) return [];
        return new Promise((resolve) => {
            const existing = this._drainRequests.get(sessionId);
            if (existing && existing.epochToken === epochToken) {
                existing.waiters.push(resolve);
            } else {
                if (existing) this._settleDrain(existing, []);
                this._drainRequests.set(sessionId, {
                    sessionId,
                    epochToken,
                    waiters: [resolve],
                    localIds: null,
                    taken: [],
                    released: [],
                    rescanDueAt: 0,
                    lifecycleDecided: false,
                });
            }
            this._scheduleDrainBatch();
        });
    }

    _scheduleHandoffRelease(sessionId, delayMs = this._handoffReleaseMs) {
        const { isValidSessionId } = this._dependencies;
        if (!isValidSessionId(sessionId)) return;
        const delay = Math.max(1, Number(delayMs) || 0);
        const dueAt = Date.now() + delay;
        const existing = this._releaseTimers.get(sessionId);
        if (existing) {
            if (existing.dueAt <= dueAt) return;
            try { clearTimeout(existing.timer); } catch { /* best-effort */ }
        }
        const timer = setTimeout(() => {
            this._releaseTimers.delete(sessionId);
            void this._releaseExpiredHandoffs(sessionId);
        }, delay);
        // The row is durable; cleanup must not keep a shutting-down process open.
        try { timer.unref?.(); } catch { /* ignore */ }
        this._releaseTimers.set(sessionId, { timer, dueAt });
    }

    _releaseExpiredHandoffs(sessionId) {
        const {
            chainSpoolTail,
            currentLifecycleToken,
            getSpoolTail,
            isValidSessionId,
            lifecycleEpochMoved,
            normalizeStore,
            removeInDeliveryIds,
            setSpoolQueue,
            updateSpool,
            warn,
        } = this._dependencies;
        if (!isValidSessionId(sessionId)) return Promise.resolve(0);
        const epochToken = currentLifecycleToken(sessionId);
        const released = [];
        let nextDueIn = 0;
        const preceding = getSpoolTail(sessionId) || Promise.resolve();
        const operation = preceding.catch(() => {}).then(() => updateSpool((raw) => {
            released.length = 0;
            nextDueIn = 0;
            // A generation move transfers ownership; never clean the new queue.
            if (lifecycleEpochMoved(sessionId, epochToken)) return undefined;
            const next = normalizeStore(raw);
            const queue = Array.isArray(next.sessions[sessionId]) ? next.sessions[sessionId] : [];
            if (queue.length === 0) return undefined;
            const now = Date.now();
            const kept = [];
            for (const entry of queue) {
                const handoffAt = Number(entry?.handoffAt) || 0;
                const handoffPid = Number(entry?.handoffPid) || 0;
                if (handoffAt > 0 && handoffPid === process.pid) {
                    const remaining = this._handoffReleaseMs - (now - handoffAt);
                    if (remaining <= 0) {
                        const id = pendingMessageId(entry);
                        if (id) released.push(id);
                        continue;
                    }
                    nextDueIn = nextDueIn === 0 ? remaining : Math.min(nextDueIn, remaining);
                }
                kept.push(entry);
            }
            if (released.length === 0) return undefined;
            setSpoolQueue(next, sessionId, kept);
            next.updatedAt = now;
            return next;
        }))
            .then(() => {
                if (released.length > 0) removeInDeliveryIds(sessionId, released);
                if (nextDueIn > 0) {
                    this._scheduleHandoffRelease(sessionId, nextDueIn + HANDOFF_RELEASE_SLACK_MS);
                }
                return released.length;
            })
            .catch((err) => {
                warn(`[session] foreign-injection handoff release failed sessionId=${sessionId}: ${err?.message || err}\n`);
                // The rows remain durable, so contention and I/O failures retry.
                this._scheduleHandoffRelease(sessionId, HANDOFF_RETRY_MS);
                return 0;
            });
        return chainSpoolTail(sessionId, operation);
    }

    _rememberScan(sessionId, mtime, rescanDueAt) {
        this._scanMemo.delete(sessionId);
        this._scanMemo.set(sessionId, { mtime, rescanDueAt: Number(rescanDueAt) || 0 });
        while (this._scanMemo.size > this._scanLimit) {
            const oldest = this._scanMemo.keys().next().value;
            if (oldest === undefined) break;
            this._scanMemo.delete(oldest);
        }
    }

    _scanNeeded(sessionId, mtime, now) {
        const memo = this._scanMemo.get(sessionId);
        if (!memo || memo.mtime !== mtime) return true;
        return memo.rescanDueAt > 0 && now >= memo.rescanDueAt;
    }

    _settleDrain(request, value) {
        for (const resolve of request.waiters) {
            try { resolve(value); } catch { /* a consumer cannot break the batch */ }
        }
    }

    _scheduleDrainBatch() {
        if (this._drainScheduled || this._drainRunning || this._drainRequests.size === 0) return;
        this._drainScheduled = true;
        setImmediate(() => {
            this._drainScheduled = false;
            void this._flushDrainBatch();
        });
    }

    async _flushDrainBatch() {
        if (this._drainRunning) return;
        this._drainRunning = true;
        const batch = [...this._drainRequests.values()];
        this._drainRequests.clear();
        const {
            addInDeliveryIds,
            lifecycleInvalidated,
            localIds,
            normalizeStore,
            removeInDeliveryIds,
            setSpoolQueue,
            spoolPath,
            updateSpool,
            warn,
        } = this._dependencies;
        try {
            let mtime = 0;
            try { mtime = (await stat(spoolPath())).mtimeMs || 0; }
            catch {
                for (const request of batch) this._settleDrain(request, []);
                return;
            }
            const scanAt = Date.now();
            const candidates = batch.filter((request) =>
                this._scanNeeded(request.sessionId, mtime, scanAt)
                && !lifecycleInvalidated(request.sessionId, request.epochToken));
            const candidateSet = new Set(candidates);
            for (const request of batch) {
                if (!candidateSet.has(request)) this._settleDrain(request, []);
            }
            if (candidates.length === 0) return;
            for (const request of candidates) {
                request.localIds = localIds(request.sessionId);
                request.taken = [];
                request.released = [];
                request.rescanDueAt = 0;
                request.lifecycleDecided = false;
            }
            await updateSpool((raw) => {
                const next = normalizeStore(raw);
                let changed = false;
                for (const request of candidates) {
                    const { sessionId, epochToken } = request;
                    if (lifecycleInvalidated(sessionId, epochToken)) continue;
                    request.lifecycleDecided = true;
                    const queue = Array.isArray(next.sessions[sessionId])
                        ? next.sessions[sessionId]
                        : [];
                    if (queue.length === 0) continue;
                    const now = Date.now();
                    const kept = [];
                    for (const entry of queue) {
                        const id = pendingMessageId(entry);
                        const handoffAt = Number(entry?.handoffAt) || 0;
                        const handoffPid = Number(entry?.handoffPid) || 0;
                        if (handoffAt > 0) {
                            const dueAt = handoffAt + this._handoffReleaseMs;
                            const expired = now >= dueAt;
                            if (!expired) {
                                request.rescanDueAt = request.rescanDueAt === 0
                                    ? dueAt
                                    : Math.min(request.rescanDueAt, dueAt);
                            }
                            if (handoffPid === process.pid) {
                                if (expired) {
                                    if (id) request.released.push(id);
                                    continue;
                                }
                                kept.push(entry);
                                continue;
                            }
                            if (!expired || handoffOwnerIsLive(handoffPid)) {
                                kept.push(entry);
                                continue;
                            }
                        }
                        const text = pendingMessageText(entry);
                        const foreignUser = id && !request.localIds.has(id)
                            && !isCompletionNotificationEntry(entry)
                            && text && !isInternalRuntimeNotificationText(text);
                        const normalized = normalizePendingMessageEntry(entry);
                        const structured = Array.isArray(normalized?.content)
                            || Boolean(normalized?.options);
                        if (foreignUser && isStaleUserInjection(entry)) {
                            const lateText = lateDeliveryText(text, entry);
                            const content = Array.isArray(normalized?.content)
                                ? [
                                    {
                                        type: 'text',
                                        text: lateText.slice(0, lateText.length - text.length),
                                    },
                                    ...normalized.content,
                                ]
                                : lateText;
                            request.taken.push({
                                ...(structured ? { content } : {}),
                                text: lateText,
                                id,
                                ...(normalized?.options ? { options: normalized.options } : {}),
                            });
                        } else if (foreignUser) {
                            request.taken.push({
                                ...(structured ? { content: normalized?.content ?? text } : {}),
                                text,
                                id,
                                ...(normalized?.options ? { options: normalized.options } : {}),
                            });
                        } else {
                            kept.push(entry);
                            continue;
                        }
                        // Park rather than delete until the consumer owns a copy.
                        kept.push({ ...entry, handoffAt: now, handoffPid: process.pid });
                    }
                    if (request.taken.length === 0 && request.released.length === 0) continue;
                    changed = true;
                    setSpoolQueue(next, sessionId, kept);
                }
                if (!changed) return undefined;
                next.updatedAt = Date.now();
                return next;
            }, { timeoutMs: 0 });
            for (const request of candidates) {
                if (request.lifecycleDecided) {
                    this._rememberScan(request.sessionId, mtime, request.rescanDueAt);
                }
                if (request.taken.length > 0) {
                    addInDeliveryIds(
                        request.sessionId,
                        request.taken.map((item) => item?.id).filter(Boolean),
                    );
                    this._scheduleHandoffRelease(
                        request.sessionId,
                        this._handoffReleaseMs + HANDOFF_RELEASE_SLACK_MS,
                    );
                }
                if (request.released.length > 0) {
                    removeInDeliveryIds(request.sessionId, request.released);
                }
                this._settleDrain(request, request.taken);
            }
        } catch (err) {
            if (err?.code !== 'ELOCKCONTENDED') {
                warn(`[session] foreign-injection drain failed: ${err?.message || err}\n`);
            }
            for (const request of batch) {
                if (request.waiters.length > 0) this._settleDrain(request, []);
            }
        } finally {
            this._drainRunning = false;
            this._scheduleDrainBatch();
        }
    }
}
