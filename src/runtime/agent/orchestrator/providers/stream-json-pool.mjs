import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { currentProviderAdmissionOwner } from './admission-scheduler.mjs';
import { frameAndParseSse } from './lib/sse-framing.mjs';

const DEFAULT_MIN_BATCH_BYTES = 32 * 1024;
// Soft cap on IDLE owner-affinity metadata. Owners with in-flight work are
// never evicted, so the live-stream count (not this number) bounds the map.
const MAX_IDLE_OWNER_AFFINITIES = 4096;
// After this many consecutive worker-construction failures the pool stops
// trying to spawn and stays inline. This is a failure latch, not a throttle:
// it never limits concurrent streams, it only stops re-throwing constructors.
const MAX_SPAWN_FAILURES = 3;

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

function normalizeOwner(ownerKey) {
    return String(ownerKey || '').trim().slice(0, 240);
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
 * Reusable worker pool for the CPU part of provider stream handling.
 *
 * Two units of work share it:
 *   - `parseBatch(payloads)` — a batch of JSON payloads (Gemini/OpenAI).
 *   - `frameSse(chunk)` — a whole SSE network chunk: line framing plus
 *     per-record JSON parsing, so a chunk never costs one task (or one
 *     microtask) per event on the shared event loop.
 *
 * Small work stays inline because a Worker round-trip costs more than doing
 * it; large chunks are framed/parsed off the daemon event loop. Calls are
 * never admission-capped: every request is posted immediately and workers
 * consume their independent message queues.
 */
export function createStreamJsonPool({
    maxWorkers = configuredWorkerCount(),
    minBatchBytes = Number(process.env.MIXDOG_PROVIDER_STREAM_WORKER_MIN_BYTES)
        || DEFAULT_MIN_BATCH_BYTES,
    maxPendingBytes = (Number(process.env.MIXDOG_PROVIDER_STREAM_PENDING_MB) || 32)
        * 1024 * 1024,
    maxIdleOwnerAffinities = MAX_IDLE_OWNER_AFFINITIES,
    WorkerImpl = Worker,
} = {}) {
    const workerMax = Math.max(0, Math.floor(Number(maxWorkers) || 0));
    const inlineBelowBytes = Math.max(0, Math.floor(Number(minBatchBytes) || 0));
    const idleAffinityMax = positiveInt(maxIdleOwnerAffinities, MAX_IDLE_OWNER_AFFINITIES);
    const slots = [];
    // owner -> { slot, active }. `active` counts the in-flight tasks holding
    // this affinity; an owner with work in flight is NEVER evicted, because
    // moving a live stream to another worker is exactly what reorders it.
    const ownerAffinities = new Map();
    // Per-stream FIFO tail: streamKey -> { tail, pending }. One stream can mix
    // routes (inline below the threshold, offloaded above it, inline again
    // after backpressure or a lost worker); chaining every submission on its
    // stream tail keeps chunk N+1 settling after chunk N no matter which route
    // each took. Entries are refcounted and self-delete at pending === 0, so
    // only idle metadata is ever dropped: an ACTIVE stream can never lose its
    // ordering state to a capacity bound (the live-stream count bounds it).
    const streamTails = new Map();
    // Explicit transport-lifetime holds. A stream can be active while waiting
    // for its next network chunk, when no pool task exists to carry the normal
    // per-submission hold. The transport retains once and releases in finally.
    const retainedStreamAffinities = new Map();
    const waiting = [];
    const pendingByteMax = Math.max(1024 * 1024, Math.floor(Number(maxPendingBytes) || 0));
    let pendingBytes = 0;
    let waitingBytes = 0;
    let sequence = 0;
    let spawnFailures = 0;
    let closed = false;
    const stats = {
        inlineBatches: 0,
        offloadedBatches: 0,
        fallbackBatches: 0,
        inlineChunks: 0,
        offloadedChunks: 0,
        framedEvents: 0,
        peakOrderedStreams: 0,
        spawnFailures: 0,
        parsedBytes: 0,
    };

    function parseInline(payloads) {
        return payloads.map((payload) => JSON.parse(payload));
    }

    /**
     * Re-run a task's work on the owner thread. Every task kind carries an
     * `inline()` that is the exact equivalent of the worker computation, so a
     * dead worker, a failed postMessage or a closing pool degrades to local
     * CPU instead of failing a live stream.
     */
    function settleInline(task) {
        stats.fallbackBatches += 1;
        try { task.resolve(task.inline()); }
        catch (error) { task.reject(error); }
    }

    /**
     * Serialize one stream's submissions. Returns the raw (possibly
     * synchronous) result when the stream has nothing in flight, so the common
     * inline path stays free of promise/microtask overhead.
     */
    function withStreamOrder(streamKey, run) {
        if (!streamKey) return run();
        let entry = streamTails.get(streamKey) || null;
        const started = entry ? entry.tail.then(run, run) : run();
        if (!started || typeof started.then !== 'function') {
            // Nothing was in flight for this stream and the work completed
            // synchronously: there is no ordering state to retain.
            return started;
        }
        const settled = started.then(() => {}, () => {});
        if (entry) {
            entry.tail = settled;
            entry.pending += 1;
        } else {
            entry = { tail: settled, pending: 1 };
            streamTails.set(streamKey, entry);
        }
        if (streamTails.size > stats.peakOrderedStreams) {
            stats.peakOrderedStreams = streamTails.size;
        }
        const owned = entry;
        settled.then(() => {
            if (streamTails.get(streamKey) !== owned) return;
            owned.pending = Math.max(0, owned.pending - 1);
            // A stream releases ONLY its own slot, and only once nothing of
            // that stream is in flight. There is no cross-stream eviction, so
            // an active stream can never lose the tail that orders its chunks.
            if (owned.pending === 0) streamTails.delete(streamKey);
        });
        return started;
    }

    /**
     * Affinity refcount.
     *
     * A hold is taken when a submission ENTERS the pool — before it waits
     * behind its stream's FIFO tail, before it is queued for backpressure and
     * before any worker owns it — and released when that submission settles.
     * An owner with queued OR in-flight work therefore has `active > 0` for
     * the whole window, so neither pruning nor a drainWaiting() burst can move
     * a live stream to a different worker between its chunks.
     */
    function acquireAffinity(owner) {
        if (!owner) return null;
        let entry = ownerAffinities.get(owner);
        if (!entry) {
            pruneOwnerAffinities();
            entry = { slot: null, active: 0 };
            ownerAffinities.set(owner, entry);
        }
        entry.active += 1;
        return entry;
    }

    function releaseAffinity(entry) {
        if (!entry) return;
        entry.active = Math.max(0, entry.active - 1);
        // Settlement is itself a pruning opportunity: metadata that just went
        // idle is reclaimed here, so a finished fan-out burst does not leave
        // the map above its cap until some unrelated owner happens to arrive.
        if (entry.active === 0) pruneOwnerAffinities();
    }

    function releaseAffinityWhenSettled(entry, result) {
        if (!entry) return result;
        if (!result || typeof result.then !== 'function') {
            releaseAffinity(entry);
            return result;
        }
        result.then(() => releaseAffinity(entry), () => releaseAffinity(entry));
        return result;
    }

    /** Run one submission under an affinity hold spanning its whole lifetime. */
    function underAffinityHold(owner, needsHold, produce) {
        const entry = needsHold ? acquireAffinity(owner) : null;
        if (!entry) return produce();
        let result;
        try { result = produce(); }
        catch (error) { releaseAffinity(entry); throw error; }
        return releaseAffinityWhenSettled(entry, result);
    }

    /** Drop only IDLE affinity entries when the soft cap is reached. */
    function pruneOwnerAffinities() {
        if (ownerAffinities.size < idleAffinityMax) return;
        for (const [owner, entry] of ownerAffinities) {
            if (entry.active > 0) continue;
            ownerAffinities.delete(owner);
            if (ownerAffinities.size < idleAffinityMax) return;
        }
    }

    function retainStream(streamKey, ownerKey = currentProviderAdmissionOwner()) {
        if (!streamKey) return false;
        const key = String(streamKey).slice(0, 240);
        if (!key || retainedStreamAffinities.has(key)) return !!key;
        const entry = acquireAffinity(normalizeOwner(ownerKey) || key);
        if (!entry) return false;
        retainedStreamAffinities.set(key, entry);
        return true;
    }

    /**
     * A worker keeps the event loop alive only while it owes an answer: idle
     * workers stay unref'd (no process is held open by the pool), busy workers
     * are ref'd (an in-flight chunk can never be lost to an early exit).
     */
    function syncSlotRef(slot) {
        try {
            if (slot.tasks.size > 0) slot.worker.ref?.();
            else slot.worker.unref?.();
        } catch { /* ref/unref is best-effort */ }
    }

    function removeSlot(slot) {
        const index = slots.indexOf(slot);
        if (index >= 0) slots.splice(index, 1);
        for (const entry of ownerAffinities.values()) {
            // Keep the entry — its refcount tracks live queued/in-flight work.
            // Only the dead slot pointer is dropped, so the next chunk re-picks
            // a worker while the owner's hold stays intact.
            if (entry.slot === slot) entry.slot = null;
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
            settleInline(task);
        }
        slot.tasks.clear();
        try { slot.worker.terminate(); } catch {}
        drainWaiting();
    }

    /**
     * Spawn a worker slot.
     *
     * Construction and listener wiring can throw (missing worker file, thread
     * limit, restricted runtime). That must never reach a live stream, so a
     * failure is latched and reported as `null` — "no worker available" — and
     * the caller runs the same work inline instead.
     */
    function createSlot() {
        let worker;
        try {
            worker = new WorkerImpl(new URL('./stream-json-worker.mjs', import.meta.url), {
                execArgv: [],
            });
        } catch {
            spawnFailures += 1;
            stats.spawnFailures += 1;
            return null;
        }
        const slot = { worker, tasks: new Map(), failed: false };
        try {
            worker.unref?.();
            wireSlot(slot);
        } catch {
            spawnFailures += 1;
            stats.spawnFailures += 1;
            try { worker.terminate?.(); } catch {}
            return null;
        }
        spawnFailures = 0;
        slots.push(slot);
        return slot;
    }

    function spawnAllowed() {
        return !closed && workerMax > 0 && spawnFailures < MAX_SPAWN_FAILURES;
    }

    function wireSlot(slot) {
        const worker = slot.worker;
        worker.on('message', (message) => {
            const task = slot.tasks.get(Number(message?.id));
            if (!task) return;
            slot.tasks.delete(Number(message.id));
            syncSlotRef(slot);
            pendingBytes = Math.max(0, pendingBytes - task.bytes);
            task.detach();
            if (task.aborted) return;
            if (message?.ok === true) task.resolve(task.decode(message));
            else if (task.kind === 'sse') settleInline(task);
            else task.reject(syntaxError(message?.error));
            drainWaiting();
        });
        worker.on('error', () => failSlot(slot));
        worker.on('exit', () => {
            if (!closed) failSlot(slot);
            else removeSlot(slot);
        });
        // Attaching the message listener starts (and refs) the public port, so
        // the pre-listener unref() above is not enough: an idle worker must not
        // hold a short-lived process open until the pool is closed.
        syncSlotRef(slot);
    }

    /** Pick a worker slot for `owner`, or null when none can be provided. */
    function pickSlot(owner) {
        const entry = owner ? ownerAffinities.get(owner) : null;
        if (entry?.slot && !entry.slot.failed) return entry.slot;
        const ready = slots.filter((slot) => !slot.failed);
        const least = ready.sort((left, right) => left.tasks.size - right.tasks.size)[0] || null;
        const wantsNew = ready.length < workerMax && (!least || least.tasks.size > 0);
        let slot;
        if (wantsNew) {
            // This task asked for its OWN worker. When the spawn fails (or the
            // failure latch is set) it settles INLINE instead of being queued
            // behind a worker it deliberately avoided: a broken spawn must
            // never serialize unrelated offload work onto one thread.
            slot = spawnAllowed() ? createSlot() : null;
            if (!slot) return null;
        } else {
            slot = least;
            if (!slot) return null;
        }
        if (entry) entry.slot = slot;
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
        const owner = normalizeOwner(task.ownerKey);
        let slot = null;
        try {
            slot = pickSlot(owner);
        } catch {
            // A WorkerImpl whose constructor (or wiring) throws must not fail
            // the caller: treat it as "no worker available".
            spawnFailures += 1;
            stats.spawnFailures += 1;
            slot = null;
        }
        if (!slot) {
            // Deterministic inline fallback: same computation, same result,
            // no rejection, and abort/retry semantics are untouched.
            task.detach();
            if (!task.aborted) settleInline(task);
            return;
        }
        task.slot = slot;
        slot.tasks.set(task.id, task);
        pendingBytes += task.bytes;
        syncSlotRef(slot);
        try {
            slot.worker.postMessage(task.message);
        } catch {
            slot.tasks.delete(task.id);
            syncSlotRef(slot);
            pendingBytes = Math.max(0, pendingBytes - task.bytes);
            task.detach();
            if (!task.aborted) settleInline(task);
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
        // The hold spans the backpressure queue too, so a batch waiting for
        // pending-byte headroom keeps its owner's worker affinity.
        return underAffinityHold(normalizeOwner(ownerKey), true, () => new Promise((resolve, reject) => {
            const task = {
                id,
                kind: 'batch',
                ownerKey,
                bytes,
                message: { id, payloads },
                inline: () => parseInline(payloads),
                decode: (result) => result.values,
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
        }));
    }

    /**
     * Frame + parse ONE SSE network chunk as a single unit of work.
     *
     * The caller hands over the complete-record region of its decode buffer;
     * line framing, per-record JSON parsing and per-record error isolation all
     * happen in one place — inside a worker once the chunk is worth the
     * round-trip, otherwise inline. The inline route returns a plain object
     * synchronously (no promise, no microtask), which is what removes the
     * former one-await-per-SSE-event amplification from the shared event loop.
     *
     * Ordering: submissions carrying the same `streamKey` settle in submission
     * order. `currentEvent` is the caller's carry at submission time, so a
     * caller that pipelines chunks must keep feeding the carry it already
     * holds (the Anthropic reader submits one chunk at a time and threads the
     * returned carry forward).
     */
    function frameSse(text, {
        currentEvent = '',
        ownerKey = currentProviderAdmissionOwner(),
        streamKey = null,
    } = {}) {
        const region = typeof text === 'string' ? text : String(text ?? '');
        const carry = typeof currentEvent === 'string' ? currentEvent : String(currentEvent ?? '');
        const key = streamKey ? String(streamKey).slice(0, 240) : '';
        const owner = normalizeOwner(ownerKey);
        const affinityOwner = owner || key;
        // A chunk that must wait behind its stream's tail is already "queued
        // work" for this owner, so it takes an affinity hold even when it is
        // framed inline — that is the window in which a drainWaiting() burst
        // used to prune the owner and migrate the stream to another worker.
        const chained = key !== '' && streamTails.has(key);
        if (!region) {
            return underAffinityHold(affinityOwner, chained, () =>
                withStreamOrder(key, () => ({ events: [], currentEvent: carry })));
        }
        const bytes = Buffer.byteLength(region);
        stats.parsedBytes += bytes;
        // Bounded and failure-safe by construction: an oversized chunk or a
        // full in-flight budget runs inline instead of queueing or failing, so
        // pending worker bytes stay capped and no live stream is ever dropped
        // for resource pressure.
        const offloadable = workerMax > 0
            && !closed
            && bytes >= inlineBelowBytes
            && bytes <= pendingByteMax
            && (pendingBytes === 0 || pendingBytes + bytes <= pendingByteMax);
        if (!offloadable) {
            stats.inlineChunks += 1;
            return underAffinityHold(affinityOwner, chained, () => withStreamOrder(key, () => {
                const framed = frameAndParseSse(region, carry);
                stats.framedEvents += framed.events.length;
                return framed;
            }));
        }
        stats.offloadedChunks += 1;
        return underAffinityHold(affinityOwner, true, () => withStreamOrder(key, () => new Promise((resolve, reject) => {
            const id = ++sequence;
            const task = {
                id,
                kind: 'sse',
                // Owner affinity first (one agent's streams share a worker and
                // its parser caches); the stream key only stands in when the
                // call runs outside a provider admission scope.
                ownerKey: affinityOwner,
                bytes,
                message: { id, kind: 'sse', text: region, event: carry },
                inline: () => frameAndParseSse(region, carry),
                decode: (result) => ({
                    events: Array.isArray(result?.events) ? result.events : [],
                    currentEvent: String(result?.event || ''),
                }),
                resolve: (value) => {
                    stats.framedEvents += Array.isArray(value?.events) ? value.events.length : 0;
                    resolve(value);
                },
                reject,
                aborted: false,
                onAbort: null,
                detach() {},
            };
            postTask(task);
        })));
    }

    /**
     * Drop a finished stream's ordering slot. An entry that still has work in
     * flight is left alone — it self-deletes once its last chunk settles — so
     * an early/late release can never unorder a stream that is still running.
     */
    function releaseStream(streamKey) {
        if (!streamKey) return;
        const key = String(streamKey).slice(0, 240);
        const retainedAffinity = retainedStreamAffinities.get(key);
        if (retainedAffinity) {
            retainedStreamAffinities.delete(key);
            releaseAffinity(retainedAffinity);
        }
        const entry = streamTails.get(key);
        if (entry && entry.pending === 0) streamTails.delete(key);
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
                if (task.aborted) continue;
                // A live provider stream must not fail because the pool is
                // shutting down: finish its chunk inline instead.
                if (task.kind === 'sse') settleInline(task);
                else task.reject(error);
            }
            slot.tasks.clear();
            workers.push(Promise.resolve(slot.worker.terminate()).catch(() => {}));
        }
        retainedStreamAffinities.clear();
        ownerAffinities.clear();
        streamTails.clear();
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
            retainedStreams: retainedStreamAffinities.size,
            orderedStreams: streamTails.size,
            peakOrderedStreams: stats.peakOrderedStreams,
            spawnFailures: stats.spawnFailures,
            workerSpawnDisabled: !spawnAllowed(),
            inlineBatches: stats.inlineBatches,
            offloadedBatches: stats.offloadedBatches,
            fallbackBatches: stats.fallbackBatches,
            inlineChunks: stats.inlineChunks,
            offloadedChunks: stats.offloadedChunks,
            framedEvents: stats.framedEvents,
            parsedBytes: stats.parsedBytes,
        };
    }

    return { parseBatch, frameSse, retainStream, releaseStream, close, snapshot };
}

export const providerStreamJsonPool = createStreamJsonPool();
export const parseProviderJsonBatch = (payloads, options) =>
    providerStreamJsonPool.parseBatch(payloads, options);
export const frameProviderSseChunk = (text, options) =>
    providerStreamJsonPool.frameSse(text, options);
export const retainProviderSseStream = (streamKey, ownerKey) =>
    providerStreamJsonPool.retainStream(streamKey, ownerKey);
export const releaseProviderSseStream = (streamKey) =>
    providerStreamJsonPool.releaseStream(streamKey);
export const providerStreamJsonSnapshot = () => providerStreamJsonPool.snapshot();
export const closeProviderStreamJsonPool = (reason) => providerStreamJsonPool.close(reason);
