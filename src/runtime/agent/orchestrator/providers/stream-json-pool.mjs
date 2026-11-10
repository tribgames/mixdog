import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { currentProviderAdmissionOwner } from './admission-scheduler.mjs';
import { frameAndParseSse } from './lib/sse-framing.mjs';
import { positiveInt } from '../../../shared/numbers.mjs';
import { createStreamOrder } from './stream-json-pool/stream-order.mjs';
import { createOwnerAffinities } from './stream-json-pool/owner-affinity.mjs';
import { createWorkerSlots } from './stream-json-pool/worker-slots.mjs';
import { abortError, createBatchTask, createSseTask, parseInline } from './stream-json-pool/pool-tasks.mjs';

const DEFAULT_MIN_BATCH_BYTES = 32 * 1024;
// Soft cap on IDLE owner-affinity metadata. Owners with in-flight work are
// never evicted, so the live-stream count (not this number) bounds the map.
const MAX_IDLE_OWNER_AFFINITIES = 4096;

function configuredWorkerCount(env = process.env) {
  const configured = Number(env.MIXDOG_PROVIDER_STREAM_WORKERS);
  if (configured === 0) return 0;
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

function normalizeOwner(ownerKey) {
  return String(ownerKey || '')
    .trim()
    .slice(0, 240);
}

const streamKeyOf = (streamKey) => (streamKey ? String(streamKey).slice(0, 240) : '');

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
 * consume their independent message queues. The pieces live under
 * stream-json-pool/: stream-order (per-stream FIFO), owner-affinity
 * (owner → worker holds), worker-slots (threads + backpressure) and
 * pool-tasks (the two task shapes).
 */
export function createStreamJsonPool({
  maxWorkers = configuredWorkerCount(),
  minBatchBytes = Number(process.env.MIXDOG_PROVIDER_STREAM_WORKER_MIN_BYTES) || DEFAULT_MIN_BATCH_BYTES,
  maxPendingBytes = (Number(process.env.MIXDOG_PROVIDER_STREAM_PENDING_MB) || 32) * 1024 * 1024,
  maxIdleOwnerAffinities = MAX_IDLE_OWNER_AFFINITIES,
  WorkerImpl = Worker,
} = {}) {
  const workerMax = Math.max(0, Math.floor(Number(maxWorkers) || 0));
  const inlineBelowBytes = Math.max(0, Math.floor(Number(minBatchBytes) || 0));
  const pendingByteMax = Math.max(1024 * 1024, Math.floor(Number(maxPendingBytes) || 0));
  let sequence = 0;
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
  const order = createStreamOrder(stats);
  const affinities = createOwnerAffinities({
    idleMax: positiveInt(maxIdleOwnerAffinities, MAX_IDLE_OWNER_AFFINITIES),
  });
  const workers = createWorkerSlots({
    workerMax,
    pendingByteMax,
    WorkerImpl,
    stats,
    affinities,
    isClosed: () => closed,
  });

  function retainStream(streamKey, ownerKey = currentProviderAdmissionOwner()) {
    if (!streamKey) return false;
    const key = streamKeyOf(streamKey);
    if (!key) return false;
    return affinities.retainStream(key, normalizeOwner(ownerKey) || key);
  }

  function parseBatch(values, { signal = null, ownerKey = currentProviderAdmissionOwner() } = {}) {
    const payloads = (Array.isArray(values) ? values : [values]).map((value) => String(value));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const bytes = payloads.reduce((sum, payload) => sum + Buffer.byteLength(payload), 0);
    stats.parsedBytes += bytes;
    if (workerMax === 0 || bytes < inlineBelowBytes) {
      stats.inlineBatches += 1;
      try {
        return Promise.resolve(parseInline(payloads));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (closed) return Promise.reject(new Error('provider stream JSON pool is closed'));
    if (bytes > pendingByteMax) {
      const error = new Error(`provider stream JSON batch exceeded ${pendingByteMax} bytes`);
      error.code = 'ERESOURCEPRESSURE';
      return Promise.reject(error);
    }

    const id = ++sequence;
    const owner = normalizeOwner(ownerKey);
    stats.offloadedBatches += 1;
    // The hold spans the backpressure queue too, so a batch waiting for
    // pending-byte headroom keeps its owner's worker affinity.
    return affinities.underHold(
      owner,
      true,
      () =>
        new Promise((resolve, reject) => {
          workers.enqueue(
            createBatchTask({
              id,
              payloads,
              bytes,
              owner,
              signal,
              resolve,
              reject,
              removeWaiting: workers.removeWaiting,
            })
          );
        })
    );
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
  function frameSse(text, { currentEvent = '', ownerKey = currentProviderAdmissionOwner(), streamKey = null } = {}) {
    const region = typeof text === 'string' ? text : String(text ?? '');
    const carry = typeof currentEvent === 'string' ? currentEvent : String(currentEvent ?? '');
    const key = streamKeyOf(streamKey);
    // Owner affinity first (one agent's streams share a worker and its
    // parser caches); the stream key only stands in when the call runs
    // outside a provider admission scope.
    const affinityOwner = normalizeOwner(ownerKey) || key;
    // A chunk that must wait behind its stream's tail is already "queued
    // work" for this owner, so it takes an affinity hold even when it is
    // framed inline — that is the window in which a drainWaiting() burst
    // used to prune the owner and migrate the stream to another worker.
    const chained = key !== '' && order.has(key);
    if (!region) {
      return affinities.underHold(affinityOwner, chained, () =>
        order.withStreamOrder(key, () => ({ events: [], currentEvent: carry }))
      );
    }
    const bytes = Buffer.byteLength(region);
    stats.parsedBytes += bytes;
    // Bounded and failure-safe by construction: an oversized chunk or a
    // full in-flight budget runs inline instead of queueing or failing, so
    // pending worker bytes stay capped and no live stream is ever dropped
    // for resource pressure.
    const offloadable =
      workerMax > 0 && !closed && bytes >= inlineBelowBytes && bytes <= pendingByteMax && workers.hasHeadroom(bytes);
    if (!offloadable) {
      stats.inlineChunks += 1;
      return affinities.underHold(affinityOwner, chained, () =>
        order.withStreamOrder(key, () => {
          const framed = frameAndParseSse(region, carry);
          stats.framedEvents += framed.events.length;
          return framed;
        })
      );
    }
    stats.offloadedChunks += 1;
    return affinities.underHold(affinityOwner, true, () =>
      order.withStreamOrder(
        key,
        () =>
          new Promise((resolve, reject) => {
            workers.postTask(
              createSseTask({ id: ++sequence, region, carry, bytes, owner: affinityOwner, stats, resolve, reject })
            );
          })
      )
    );
  }

  function releaseStream(streamKey) {
    if (!streamKey) return;
    const key = streamKeyOf(streamKey);
    affinities.releaseStream(key);
    order.release(key);
  }

  async function close(reason = 'provider stream JSON pool closed') {
    if (closed) return;
    closed = true;
    const terminations = workers.close(new Error(reason));
    affinities.clear();
    order.clear();
    await Promise.all(terminations);
  }

  function snapshot() {
    return {
      ...workers.snapshot(),
      ownerAffinities: affinities.size,
      retainedStreams: affinities.retainedCount,
      orderedStreams: order.size,
      peakOrderedStreams: stats.peakOrderedStreams,
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

const providerStreamJsonPool = createStreamJsonPool();
export const parseProviderJsonBatch = (payloads, options) => providerStreamJsonPool.parseBatch(payloads, options);
export const frameProviderSseChunk = (text, options) => providerStreamJsonPool.frameSse(text, options);
export const retainProviderSseStream = (streamKey, ownerKey) =>
  providerStreamJsonPool.retainStream(streamKey, ownerKey);
export const releaseProviderSseStream = (streamKey) => providerStreamJsonPool.releaseStream(streamKey);
export const providerStreamJsonSnapshot = () => providerStreamJsonPool.snapshot();
export const closeProviderStreamJsonPool = (reason) => providerStreamJsonPool.close(reason);
