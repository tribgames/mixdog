/**
 * Off-thread parse + projection of a large stored transcript.
 *
 * The strict record parse and the transcript projection of a multi-megabyte
 * session took 0.4-3s of daemon event-loop time (`slow stored projection`).
 * This module runs exactly that pure pipeline (readTopLevelLifecycleRecord →
 * projectStoredTranscript with no turn checkpoint) on a lazily started worker
 * thread and hands back the same projection value. The worker loads its own
 * module graph; only the finished projection crosses back.
 *
 * Client (main thread): `projectStoredTranscriptOffThread`. Worker side is
 * active only when this file is loaded as a worker of that client.
 */
import { isMainThread, workerData } from 'node:worker_threads';
import { createWorkerRequestClient, serveWorkerRequests } from '../../../shared/worker-requests.mjs';

/** Records at least this many characters go to the worker; smaller ones cost
 *  less on the main thread than the round trip. */
export const OFFLOAD_MIN_CHARS = 1_000_000;
const WORKER_KIND = 'stored-transcript-projection';
const IDLE_EXIT_MS = 120_000;

let client = null;

/**
 * Parse and project `text` for `sessionId`. Resolves `{ unreadable: true }`
 * when the record is not a strict, identity-matching session record, else
 * `{ value, lifecycle }` where `lifecycle` is `{ id, closed, generation }`.
 * Rejects when the worker cannot answer; callers fall back to the main thread.
 */
export function projectStoredTranscriptOffThread({ sessionId, text, itemLimit }) {
  client ||= createWorkerRequestClient(new URL(import.meta.url), {
    idleExitMs: IDLE_EXIT_MS,
    workerData: { kind: WORKER_KIND },
  });
  return client({ sessionId, text, itemLimit });
}

/** Whether a projection worker is attached (a request now skips its start). */
export function storedTranscriptWorkerRunning() {
  return client?.running() === true;
}

async function project({ sessionId, text, itemLimit }) {
  const importStartedAt = performance.now();
  const [{ readTopLevelLifecycleRecord, isLifecycleUnreadable }, { projectStoredTranscript }] = await Promise.all([
    import('./lifecycle-scan.mjs'),
    import('./store-transcript-projection.mjs'),
  ]);
  const parseStartedAt = performance.now();
  const record = readTopLevelLifecycleRecord(text);
  if (isLifecycleUnreadable(record) || record.id !== sessionId) return { unreadable: true };
  const projectStartedAt = performance.now();
  const value = await projectStoredTranscript(sessionId, record.doc, {
    itemLimit,
    includeMessages: false,
    checkpointAbsent: true,
  });
  const timing = {
    importMs: parseStartedAt - importStartedAt,
    parseMs: projectStartedAt - parseStartedAt,
    projectMs: performance.now() - projectStartedAt,
  };
  return { value, lifecycle: { id: record.id, closed: record.closed, generation: record.generation }, timing };
}

if (!isMainThread && workerData?.kind === WORKER_KIND) serveWorkerRequests(project);
