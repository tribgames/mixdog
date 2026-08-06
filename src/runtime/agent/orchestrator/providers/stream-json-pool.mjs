import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { currentProviderAdmissionOwner } from './admission-scheduler.mjs';

const DEFAULT_MIN_BATCH_BYTES = 32 * 1024;

function positiveInt(value, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function configuredWorkerCount(env = process.env) {
    const configured = Number(env.MIXDOG_PROVIDER_STREAM_WORKERS);
    if (configured === 0) return 0;
    if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
    return Math.max(1, Math.min(4, availableParallelism() - 1));
}

function abortError(signal) {
    return signal?.reason instanceof Error
        ? signal.reason
        : new Error(String(signal?.reason || 'provider stream parse canceled'));
}

function syntaxError(details) {
    const error = new SyntaxError(String(details?.message || 'invalid JSON'));
    error.name = String(details?.name || 'SyntaxError');
    return error;
}

/**
 * Reusable worker pool for the CPU part of provider SSE handling.
 *
 * Small deltas stay inline because a Worker round-trip costs more than parsing
 * them. Large events and multi-event network chunks are parsed off the daemon
 * event loop. Calls are never admission-capped: every request is posted
 * immediately and workers consume their independent message queues.
 */
export function createStreamJsonPool({
    maxWorkers = configuredWorkerCount(),
    minBatchBytes = Number(process.env.MIXDOG_PROVIDER_STREAM_WORKER_MIN_BYTES)
        || DEFAULT_MIN_BATCH_BYTES,
    maxPendingBytes = (Number(process.env.MIXDOG_PROVIDER_STREAM_PENDING_MB) || 32)
        * 1024 * 1024,
    WorkerImpl = Worker,
} = {}) {
    const workerMax = Math.max(0, Math.floor(Number(maxWorkers) || 0));
    const inlineBelowBytes = Math.max(0, Math.floor(Number(minBatchBytes) || 0));
    const slots = [];
    const ownerAffinities = new Map();
    const waiting = [];
    const pendingByteMax = Math.max(1024 * 1024, Math.floor(Number(maxPendingBytes) || 0));
    let pendingBytes = 0;
    let waitingBytes = 0;
    let sequence = 0;
    let closed = false;
    const stats = {
        inlineBatches: 0,
        offloadedBatches: 0,
        fallbackBatches: 0,
        parsedBytes: 0,
    };

    function parseInline(payloads) {
        return payloads.map((payload) => JSON.parse(payload));
    }

    function removeSlot(slot) {
        const index = slots.indexOf(slot);
        if (index >= 0) slots.splice(index, 1);
        for (const [owner, assigned] of ownerAffinities) {
            if (assigned === slot) ownerAffinities.delete(owner);
        }
    }

    function failSlot(slot) {
        if (slot.failed) return;
        slot.failed = true;
        removeSlot(slot);
        for (const task of slot.tasks.values()) {
            pendingBytes = Math.max(0, pendingBytes - task.bytes);
            task.detach();
            if (task.aborted) continue;
            stats.fallbackBatches += 1;
            try { task.resolve(parseInline(task.payloads)); }
            catch (error) { task.reject(error); }
        }
        slot.tasks.clear();
        try { slot.worker.terminate(); } catch {}
        drainWaiting();
    }

    function createSlot() {
        const worker = new WorkerImpl(new URL('./stream-json-worker.mjs', import.meta.url), {
            execArgv: [],
        });
        worker.unref?.();
        const slot = { worker, tasks: new Map(), failed: false };
        worker.on('message', (message) => {
            const task = slot.tasks.get(Number(message?.id));
            if (!task) return;
            slot.tasks.delete(Number(message.id));
            pendingBytes = Math.max(0, pendingBytes - task.bytes);
            task.detach();
            if (task.aborted) return;
            if (message?.ok === true) task.resolve(message.values);
            else task.reject(syntaxError(message?.error));
            drainWaiting();
        });
        worker.on('error', () => failSlot(slot));
        worker.on('exit', () => {
            if (!closed) failSlot(slot);
            else removeSlot(slot);
        });
        slots.push(slot);
        return slot;
    }

    function pickSlot(ownerKey) {
        const ready = slots.filter((slot) => !slot.failed);
        const owner = String(ownerKey || '').trim().slice(0, 240);
        const assigned = owner ? ownerAffinities.get(owner) : null;
        if (assigned && !assigned.failed) return assigned;
        const least = ready.sort((left, right) => left.tasks.size - right.tasks.size)[0] || null;
        const slot = ready.length < workerMax && (!least || least.tasks.size > 0)
            ? createSlot()
            : least || createSlot();
        if (owner) {
            ownerAffinities.set(owner, slot);
            while (ownerAffinities.size > 4096) {
                ownerAffinities.delete(ownerAffinities.keys().next().value);
            }
        }
        return slot;
    }

    function removeWaiting(task) {
        const index = waiting.indexOf(task);
        if (index < 0) return false;
        waiting.splice(index, 1);
        waitingBytes = Math.max(0, waitingBytes - task.bytes);
        return true;
    }

    function postTask(task) {
        const slot = pickSlot(task.ownerKey);
        task.slot = slot;
        slot.tasks.set(task.id, task);
        pendingBytes += task.bytes;
        try {
            slot.worker.postMessage({ id: task.id, payloads: task.payloads });
        } catch {
            slot.tasks.delete(task.id);
            pendingBytes = Math.max(0, pendingBytes - task.bytes);
            task.detach();
            stats.fallbackBatches += 1;
            try { task.resolve(parseInline(task.payloads)); }
            catch (error) { task.reject(error); }
            drainWaiting();
        }
    }

    function drainWaiting() {
        while (waiting.length > 0) {
            const task = waiting[0];
            if (pendingBytes > 0 && pendingBytes + task.bytes > pendingByteMax) return;
            waiting.shift();
            waitingBytes = Math.max(0, waitingBytes - task.bytes);
            if (task.aborted) continue;
            postTask(task);
        }
    }

    function parseBatch(values, {
        signal = null,
        ownerKey = currentProviderAdmissionOwner(),
    } = {}) {
        const payloads = (Array.isArray(values) ? values : [values]).map((value) => String(value));
        if (signal?.aborted) return Promise.reject(abortError(signal));
        const bytes = payloads.reduce((sum, payload) => sum + Buffer.byteLength(payload), 0);
        stats.parsedBytes += bytes;
        if (workerMax === 0 || bytes < inlineBelowBytes) {
            stats.inlineBatches += 1;
            try { return Promise.resolve(parseInline(payloads)); }
            catch (error) { return Promise.reject(error); }
        }
        if (closed) return Promise.reject(new Error('provider stream JSON pool is closed'));
        if (bytes > pendingByteMax) {
            const error = new Error(
                `provider stream JSON batch exceeded ${pendingByteMax} bytes`,
            );
            error.code = 'ERESOURCEPRESSURE';
            return Promise.reject(error);
        }

        const id = ++sequence;
        stats.offloadedBatches += 1;
        return new Promise((resolve, reject) => {
            const task = {
                id,
                ownerKey,
                bytes,
                payloads,
                resolve,
                reject,
                aborted: false,
                onAbort: null,
                detach() {
                    if (!task.onAbort || !signal) return;
                    try { signal.removeEventListener('abort', task.onAbort); } catch {}
                    task.onAbort = null;
                },
            };
            if (signal) {
                task.onAbort = () => {
                    if (task.aborted) return;
                    task.aborted = true;
                    task.detach();
                    if (removeWaiting(task)) {
                        reject(abortError(signal));
                        return;
                    }
                    reject(abortError(signal));
                };
                signal.addEventListener('abort', task.onAbort, { once: true });
            }
            if (pendingBytes > 0 && pendingBytes + bytes > pendingByteMax) {
                if (waitingBytes + bytes > pendingByteMax) {
                    task.detach();
                    const error = new Error(
                        `provider stream JSON backlog exceeded ${pendingByteMax} bytes`,
                    );
                    error.code = 'ERESOURCEPRESSURE';
                    reject(error);
                    return;
                }
                waiting.push(task);
                waitingBytes += bytes;
                return;
            }
            postTask(task);
        });
    }

    async function close(reason = 'provider stream JSON pool closed') {
        if (closed) return;
        closed = true;
        const error = new Error(reason);
        for (const task of waiting.splice(0)) {
            task.detach();
            if (!task.aborted) task.reject(error);
        }
        waitingBytes = 0;
        const workers = [];
        for (const slot of slots.splice(0)) {
            for (const task of slot.tasks.values()) {
                task.detach();
                if (!task.aborted) task.reject(error);
            }
            slot.tasks.clear();
            workers.push(Promise.resolve(slot.worker.terminate()).catch(() => {}));
        }
        ownerAffinities.clear();
        await Promise.all(workers);
    }

    function snapshot() {
        return {
            workers: slots.filter((slot) => !slot.failed).length,
            workerMax,
            activeBatches: slots.reduce((sum, slot) => sum + slot.tasks.size, 0),
            pendingBytes,
            waitingBatches: waiting.length,
            waitingBytes,
            maxPendingBytes: pendingByteMax,
            ownerAffinities: ownerAffinities.size,
            inlineBatches: stats.inlineBatches,
            offloadedBatches: stats.offloadedBatches,
            fallbackBatches: stats.fallbackBatches,
            parsedBytes: stats.parsedBytes,
        };
    }

    return { parseBatch, close, snapshot };
}

export const providerStreamJsonPool = createStreamJsonPool();
export const parseProviderJsonBatch = (payloads, options) =>
    providerStreamJsonPool.parseBatch(payloads, options);
export const providerStreamJsonSnapshot = () => providerStreamJsonPool.snapshot();
export const closeProviderStreamJsonPool = (reason) => providerStreamJsonPool.close(reason);
