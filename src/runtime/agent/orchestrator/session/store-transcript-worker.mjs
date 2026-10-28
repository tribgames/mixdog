/**
 * Off-thread read + parse + projection of a stored transcript.
 *
 * A cold pane read used to cost the daemon event loop the whole pipeline: a
 * chunked async read whose every 512 KB chunk waited for a loop turn, a
 * SHA-256 of the text, the strict record parse and a projection that meters
 * every message of the transcript (`slow stored projection`). Under a busy
 * loop each read stretched to seconds. This worker runs exactly that pipeline
 * (stat → read → stat, digest, readTopLevelLifecycleRecord →
 * projectStoredTranscript with no turn checkpoint) and hands back the
 * digest and one slice of the session's display history: the history itself
 * is built once per content and kept here with its base, and only the window
 * or page a request names (`slice`: `{ limit, skip }`) crosses back, with its
 * serialized size measured here.
 *
 * Inside the worker, one projection base (recovery, prepared session and
 * whole-transcript context gauge) per session content is shared by every
 * window and every concurrent request of it, and a new version of a session
 * reuses the parsed messages its previous version already metered wherever
 * they are unchanged, so an appended turn re-meters only the new tail.
 * Bodies read but not yet built are bounded (`createBaseBuilds`): room is
 * reserved before a record is read, and a newer version of a session
 * replaces its queued older build.
 *
 * Client (main thread): `projectStoredTranscriptOffThread`. Worker side is
 * active only when this file is loaded as a worker of that client.
 */
import { availableParallelism } from 'node:os';
import { isMainThread, workerData } from 'node:worker_threads';
import { createWorkerRequestClient, serveWorkerRequests } from '../../../shared/worker-requests.mjs';

/** Records of at least this many bytes go to the worker. Smaller ones cost
 *  only a few ms here, and their parse can then be handed to the resume that
 *  follows a pane read. */
export const OFFLOAD_MIN_CHARS = 256 * 1024;
const WORKER_KIND = 'stored-transcript-projection';
const IDLE_EXIT_MS = 120_000;
// A restore burst projects every pane at once; two threads halve its tail.
// A session always goes to the same worker, which holds its base.
const POOL_SIZE = Math.max(1, Math.min(2, availableParallelism() - 1));

const clients = [];

function clientFor(sessionId) {
  let hash = 0;
  for (let index = 0; index < sessionId.length; index += 1) hash = (hash * 31 + sessionId.charCodeAt(index)) >>> 0;
  const slot = hash % POOL_SIZE;
  clients[slot] ||= createWorkerRequestClient(new URL(import.meta.url), {
    idleExitMs: IDLE_EXIT_MS,
    workerData: { kind: WORKER_KIND },
  });
  return clients[slot];
}

/**
 * Read, digest and project the record at `recordPath` for `sessionId`.
 * Resolves `{ state, timing }` with state absent/unreadable when the file
 * cannot be read; otherwise `{ state, textChars, textHash, stamp, timing }`
 * plus `same: true` when the content is `known` ({ textChars, textHash }),
 * `unreadable: true` when it is not a strict, identity-matching session
 * record, or `{ value, lifecycle }` (`{ id, closed, generation }`). `stamp` is
 * the full file stamp the bytes provably came from, or null. Rejects when the
 * worker cannot answer; callers then run the pipeline on their own thread.
 */
export function projectStoredTranscriptOffThread({
  sessionId,
  recordPath,
  known = null,
  fingerprint = '',
  slice = null,
}) {
  return clientFor(sessionId)({ sessionId, recordPath, known, fingerprint, slice });
}

/** Whether the projection worker of `sessionId` is attached (a request now
 *  skips its start). */
export function storedTranscriptWorkerRunning(sessionId) {
  return clientFor(sessionId).running() === true;
}

/** Drop this session's projection base and queued builds in its worker (it
 *  went live). Never starts a worker just to forget. */
export function forgetStoredTranscriptOffThread(sessionId) {
  const request = clientFor(sessionId);
  if (request.running() === true) request({ forget: sessionId }).catch(() => {});
}

// ── Worker side ─────────────────────────────────────────────────────────────

/** The answer a superseded or forgotten queued build gives its waiters: read
 *  the record again (it now holds that newer content, or none). */
export const RESTART_READ = Symbol('restart-read');

// Source characters of records read but not yet built: reserved from the
// file size BEFORE a record is read and held until its build settles, it
// joins another build, or it is dropped. A record alone larger than this is
// admitted only when nothing else is reserved.
const BUILD_CHARS_LIMIT = 16 * 1024 * 1024;
// Source characters of the retained bases (their parsed records and memos
// stay alive with them). The newest base is kept even when it alone exceeds
// this; the worker's idle exit releases everything.
const BASE_CHARS_LIMIT = 16 * 1024 * 1024;

/**
 * Admission, build queue and retained bases of one worker.
 * `build(sessionId, text, previousMessages, timing)` builds a base; it runs
 * one at a time, in arrival order (metering yields between slices, so
 * concurrent builds would share the thread round-robin and every pane of a
 * restore burst would get its answer only at the end).
 *
 * A caller `admit`s the record's size before reading it, then `submit`s the
 * text with its ticket (or `release`s it): retained or in-progress builds of
 * the same content are shared; a newer version of a session replaces its
 * queued older build, whose waiters get RESTART_READ. The previous version's
 * messages are looked up when a build starts, so no queued build keeps an
 * evicted or replaced base alive.
 */
export function createBaseBuilds({ build, buildCharsLimit = BUILD_CHARS_LIMIT, baseCharsLimit = BASE_CHARS_LIMIT }) {
  /** sessionId -> { textHash, chars, built } (Map order is LRU). */
  const bases = new Map();
  let baseChars = 0;
  /** Unstarted builds: { sessionId, text, textHash, chars, ticket, timing, waiters, retain }. */
  const queue = [];
  let running = null;
  let draining = false;
  /** Waiting for room: { chars, resolve } in arrival order. */
  const admissions = [];
  let reservedChars = 0;
  let peakReservedChars = 0;
  let builds = 0;

  const dropBase = (sessionId) => {
    const entry = bases.get(sessionId);
    if (!entry) return;
    bases.delete(sessionId);
    baseChars -= entry.chars;
  };

  const retainBase = (sessionId, entry) => {
    dropBase(sessionId);
    bases.set(sessionId, entry);
    baseChars += entry.chars;
    while (baseChars > baseCharsLimit && bases.size > 1) dropBase(bases.keys().next().value);
  };

  const reserve = (ticket, chars) => {
    reservedChars += chars - ticket.chars;
    ticket.chars = chars;
    peakReservedChars = Math.max(peakReservedChars, reservedChars);
  };

  const pump = () => {
    while (admissions.length > 0 && (reservedChars === 0 || reservedChars + admissions[0].chars <= buildCharsLimit)) {
      const { chars, resolve } = admissions.shift();
      const ticket = { chars: 0, released: false };
      reserve(ticket, chars);
      resolve(ticket);
    }
  };

  const release = (ticket) => {
    if (!ticket || ticket.released) return;
    ticket.released = true;
    reservedChars -= ticket.chars;
    ticket.chars = 0;
    pump();
  };

  // An unstarted build nobody needs any more: its body and reservation go,
  // its waiters read again.
  const drop = (job) => {
    queue.splice(queue.indexOf(job), 1);
    job.text = null;
    release(job.ticket);
    for (const waiter of job.waiters.splice(0)) waiter.resolve(RESTART_READ);
  };

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        running = job;
        let outcome;
        try {
          const previous = bases.get(job.sessionId)?.built.messages ?? null;
          outcome = { value: await build(job.sessionId, job.text, previous, job.timing) };
        } catch (error) {
          outcome = { error };
        }
        running = null;
        job.text = null;
        release(job.ticket);
        builds += 1;
        const { value, error } = outcome;
        if (job.retain && value && !value.unreadable) {
          retainBase(job.sessionId, { textHash: job.textHash, chars: job.chars, built: value });
        }
        for (const waiter of job.waiters.splice(0)) {
          if (error) waiter.reject(error);
          else waiter.resolve(value);
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    /** Resolves a ticket reserving `chars` once they fit the budget. */
    admit(chars) {
      const admitted = new Promise((resolve) => admissions.push({ chars: Math.max(0, chars || 0), resolve }));
      pump();
      return admitted;
    },
    /** The record read is `chars` long (its size was only an estimate). */
    resize(ticket, chars) {
      if (!ticket.released) reserve(ticket, chars);
    },
    release,
    /** The base of this exact content (the ticket passes to the build or is
     *  released), or RESTART_READ. */
    submit(sessionId, text, textHash, ticket, timing) {
      const chars = text.length;
      const retained = bases.get(sessionId);
      if (retained && retained.textHash === textHash && retained.chars === chars) {
        release(ticket);
        retainBase(sessionId, retained);
        timing.base = 'shared';
        return Promise.resolve(retained.built);
      }
      const sameContent = (job) =>
        !!job && job.sessionId === sessionId && job.textHash === textHash && job.chars === chars;
      let job = sameContent(running) ? running : queue.find(sameContent);
      if (job) {
        release(ticket);
        timing.base = 'shared';
      } else {
        for (const older of queue.filter((queued) => queued.sessionId === sessionId)) drop(older);
        job = { sessionId, text, textHash, chars, ticket, timing, waiters: [], retain: true };
        queue.push(job);
      }
      const answer = new Promise((resolve, reject) => job.waiters.push({ resolve, reject }));
      void drain();
      return answer;
    },
    /** The session went live: drop its base and queued builds; one already
     *  running answers its waiters but is not retained. */
    forget(sessionId) {
      dropBase(sessionId);
      for (const queued of queue.filter((job) => job.sessionId === sessionId)) drop(queued);
      if (running?.sessionId === sessionId) running.retain = false;
    },
    stats() {
      return {
        reservedChars,
        peakReservedChars,
        queuedBuilds: queue.length,
        queuedChars: queue.reduce((sum, job) => sum + job.chars, 0),
        waitingAdmissions: admissions.length,
        builds,
        retainedBases: bases.size,
        baseChars,
      };
    },
  };
}

/** Whether two JSON.parse results are the same value, key order included
 *  (estimators serialize them). */
export function sameJsonValue(left, right) {
  if (left === right) return typeof left !== 'number' || Object.is(left, right);
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameJsonValue(left[index], right[index])) return false;
    }
    return true;
  }
  if (Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];
    if (rightKeys[index] !== key || !sameJsonValue(left[key], right[key])) return false;
  }
  return true;
}

/**
 * Replace the leading messages of `next` that are the same value as those of
 * `previous` with the previous objects, whose per-message meter memos the
 * projection then reads instead of re-metering. Returns how many were reused.
 * Projections never mutate messages, and the comparison is against each
 * previous object as it is now, so the result is the projection of `next`.
 */
export function reuseParsedPrefix(next, previous) {
  if (!Array.isArray(next) || !Array.isArray(previous)) return 0;
  const shared = Math.min(next.length, previous.length);
  let index = 0;
  while (index < shared && sameJsonValue(next[index], previous[index])) {
    next[index] = previous[index];
    index += 1;
  }
  return index;
}

async function buildBase(sessionId, text, previousMessages, timing) {
  const [{ readTopLevelLifecycleRecord, isLifecycleUnreadable }, { prepareStoredTranscriptBase }] = await Promise.all([
    import('./lifecycle-scan.mjs'),
    import('./store-transcript-projection.mjs'),
  ]);
  const parseStartedAt = performance.now();
  const record = readTopLevelLifecycleRecord(text);
  if (isLifecycleUnreadable(record) || record.id !== sessionId) return { unreadable: true };
  const messages = record.doc.messages;
  timing.reusedMessages = reuseParsedPrefix(messages, previousMessages);
  timing.parseMs = performance.now() - parseStartedAt;
  const base = await prepareStoredTranscriptBase(sessionId, record.doc, { checkpointAbsent: true });
  return {
    base,
    messages,
    lifecycle: { id: record.id, closed: record.closed, generation: record.generation },
  };
}

const baseBuilds = createBaseBuilds({ build: buildBase });

// Serialized bytes of the display histories this worker keeps for slicing:
// one larger than the per-session bound is rebuilt per request instead, and
// the oldest go once all of them exceed the worker's bound. The worker's idle
// exit releases every one.
// Measured: a history is about as large as its record (74 MB record: 75 MB
// history) and a page of a retained one costs ~0.2 s, a rebuilt one ~1 s. 96
// MB keeps the largest sessions seen (~78 MB records) smooth; 128 MB holds
// one of those beside a few ordinary ones.
export const WORKER_HISTORY_SESSION_MAX_BYTES = 96 * 1024 * 1024;
export const WORKER_HISTORY_MAX_BYTES = 128 * 1024 * 1024;

/**
 * The display histories one worker retains (`{ value, rowBytes, bytes }`,
 * keyed by session, Map order LRU) within `sessionMaxBytes` each and
 * `maxBytes` together. A history of other content (`owner`, the record
 * content it was built from, and its sidecar fingerprint) is never served.
 */
export function createHistoryRetention({
  sessionMaxBytes = WORKER_HISTORY_SESSION_MAX_BYTES,
  maxBytes = WORKER_HISTORY_MAX_BYTES,
} = {}) {
  const histories = new Map();
  let retainedBytes = 0;
  const drop = (sessionId) => {
    const entry = histories.get(sessionId);
    if (!entry) return;
    histories.delete(sessionId);
    retainedBytes -= entry.history.bytes;
  };
  return {
    get(sessionId, owner, fingerprint) {
      const entry = histories.get(sessionId);
      if (!entry || entry.owner !== owner || entry.fingerprint !== fingerprint) return null;
      histories.delete(sessionId);
      histories.set(sessionId, entry);
      return entry.history;
    },
    /** Keeps `history` when it fits; whether it was kept. */
    retain(sessionId, owner, fingerprint, history) {
      drop(sessionId);
      if (history.bytes > sessionMaxBytes) return false;
      histories.set(sessionId, { owner, fingerprint, history });
      retainedBytes += history.bytes;
      while (retainedBytes > maxBytes && histories.size > 1) drop(histories.keys().next().value);
      return true;
    },
    forget: drop,
    stats: () => ({ histories: histories.size, retainedBytes }),
  };
}

const historyRetention = createHistoryRetention();
/** sessionId -> { owner, fingerprint, promise }: histories being built. */
const historyBuilds = new Map();

/** The display history of `built` (one base) under sidecar `fingerprint`,
 *  with each row's serialized bytes: retained, joined while another request
 *  builds it, or built now. */
async function displayHistory(sessionId, built, content, fingerprint, projection) {
  const retained = historyRetention.get(sessionId, content, fingerprint);
  if (retained) return { history: retained, historyBuilt: false };
  const pending = historyBuilds.get(sessionId);
  if (pending && pending.owner === content && pending.fingerprint === fingerprint) {
    return { history: await pending.promise, historyBuilt: false };
  }
  const promise = (async () => {
    const value = await projection.windowStoredTranscript(sessionId, built.base, {
      history: true,
      includeMessages: false,
    });
    const rowBytes = new Float64Array(value.items.length);
    let bytes = 0;
    for (let index = 0; index < value.items.length; index += 1) {
      rowBytes[index] = Buffer.byteLength(JSON.stringify(value.items[index] ?? null));
      bytes += rowBytes[index];
    }
    return { value, rowBytes, bytes };
  })();
  const record = { owner: content, fingerprint, promise };
  historyBuilds.set(sessionId, record);
  try {
    const history = await promise;
    if (historyBuilds.get(sessionId) === record) historyRetention.retain(sessionId, content, fingerprint, history);
    return { history, historyBuilt: true };
  } finally {
    if (historyBuilds.get(sessionId) === record) historyBuilds.delete(sessionId);
  }
}

async function project({ sessionId, recordPath, known, fingerprint = '', slice = null }) {
  const importStartedAt = performance.now();
  const [
    { statSessionStamp, sameSessionStamp },
    { readTextFile, PROBE_PRESENT },
    { transcriptTextHash, historyStampOf },
    projection,
  ] = await Promise.all([
    import('./store/canonical-reader.mjs'),
    import('./store/fs-probe.mjs'),
    import('./store-transcript-cache.mjs'),
    import('./store-transcript-projection.mjs'),
  ]);
  const timing = { importMs: performance.now() - importStartedAt };
  const observe = () => {
    try {
      return statSessionStamp(recordPath);
    } catch {
      return null;
    }
  };
  for (let restarts = 0; ; restarts += 1) {
    if (restarts > 0) timing.restarts = restarts;
    // Room for the body is reserved before it is read (bytes bound chars).
    const sized = observe();
    const admitStartedAt = performance.now();
    const ticket = await baseBuilds.admit(sized ? Number(sized.size) : 0);
    timing.admitMs = performance.now() - admitStartedAt;
    let submitted = false;
    try {
      const readStartedAt = performance.now();
      const before = observe();
      let body = readTextFile(recordPath);
      if (body.state !== PROBE_PRESENT) return { state: body.state, timing };
      const stamp = before && sameSessionStamp(before, observe()) ? before : null;
      let text = body.text;
      body = null;
      baseBuilds.resize(ticket, text.length);
      const digest = {
        state: PROBE_PRESENT,
        textChars: text.length,
        textHash: transcriptTextHash(text),
        stamp,
        timing,
      };
      timing.readMs = performance.now() - readStartedAt;
      if (known && known.textHash === digest.textHash && known.textChars === digest.textChars) {
        return { ...digest, same: true };
      }
      const projectStartedAt = performance.now();
      submitted = true;
      const pending = baseBuilds.submit(sessionId, text, digest.textHash, ticket, timing);
      // Only the build may keep the body; a joined read lets go of its copy.
      text = null;
      const built = await pending;
      if (built === RESTART_READ) continue;
      if (built.unreadable) return { ...digest, unreadable: true };
      // The whole display history stays here (within its budgets); only the
      // requested slice crosses back.
      const { history, historyBuilt } = await displayHistory(
        sessionId,
        built,
        `${digest.textHash}:${digest.textChars}`,
        fingerprint,
        projection
      );
      const request = slice || {};
      const historyStamp = historyStampOf(sessionId, digest.textHash, digest.textChars, fingerprint, request.epoch);
      const proven = Boolean(request.held) && request.baseHistory === historyStamp;
      const value = projection.storedHistorySlice(
        history.value,
        { ...request, proven },
        {
          digestOf: request.held && !proven ? await projection.heldRowsDigester() : null,
          rowBytes: (index) => history.rowBytes[index],
        }
      );
      const { windowStamp } = value;
      delete value.windowStamp;
      value.projectionStamp = `${historyStamp}/${windowStamp}`;
      const bytes = Buffer.byteLength(JSON.stringify(value));
      timing.projectMs = performance.now() - projectStartedAt;
      return { ...digest, value, bytes, historyBuilt, lifecycle: built.lifecycle };
    } finally {
      if (!submitted) baseBuilds.release(ticket);
    }
  }
}

if (!isMainThread && workerData?.kind === WORKER_KIND) {
  serveWorkerRequests((payload) => {
    if (!payload?.forget) return project(payload);
    historyRetention.forget(payload.forget);
    historyBuilds.delete(payload.forget);
    return baseBuilds.forget(payload.forget);
  });
}
