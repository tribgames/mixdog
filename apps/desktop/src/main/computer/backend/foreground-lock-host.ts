/**
 * The foreground-lock leases the process hosting the bridge gives a worker
 * Windows refuses the lock to (MixForegroundLock.cs). Windows gives
 * LockSetForegroundWindow only to a process that may set the foreground; a
 * pooled worker rarely may, since a right it inherited or was granted ends
 * with the next input that is not its own, such as the user typing into their
 * own window. The foreground process may, and while the user works in a
 * Mixdog window that is this process. The protection is best effort: Windows
 * lifts the lock on the user's Alt key or click, and nothing here can end a
 * lock this process held when it died.
 *
 * The lock is taken and ended by a lease owner on its own worker thread
 * (sources/foreground-lease-thread.cjs), never by this event loop: a lease
 * ends at its deadline however long this loop is blocked. A worker asks with a
 * line on its stdout; the answer goes back on its stdin, a pipe only this
 * process can write, and names the request (action and sequence) and the
 * lease it answers, so the worker accepts nothing else. A line that is not a
 * well-formed request of the worker's own in-flight action is ignored, never
 * thrown into the worker's output handling.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { loadComputerSource } from './native-assets';

export const FOREGROUND_LOCK_LINE_PREFIX = '@@MIXDOG_FGLOCK@@';
/** Lease answers on a worker's stdin (MixForegroundLockHost.ReplyPrefix). */
export const FOREGROUND_LOCK_REPLY_PREFIX = '@@MIXDOG_FGLOCK_REPLY@@';
export const LEASE_THREAD_SOURCE = loadComputerSource('foreground-lease-thread.cjs');
/** No lease holds every other app's foreground changes for longer. */
const MAX_HOLD_MS = 1_000;
const MAX_ID = 2 ** 31 - 1;
/** Facts kept for replies that never came, before the oldest are dropped. */
const MAX_FACTS = 256;

/** One worker as the lease channel sees it. */
export interface LeaseWorker {
  /** This process's own number for the worker, never reused. */
  instance: number;
  pid: number | undefined;
  /** Whether `action` is a request the worker has in flight. */
  owns(action: number): boolean;
  /** One line onto the worker's stdin. */
  write(line: string): void;
}

export type LeaseThreadRequest =
  | { type: 'acquire'; instance: number; pid: number; action: number; seq: number; holdMs: number; answerBy: number }
  | { type: 'release'; instance: number; action: number; seq: number; lease: number }
  | { type: 'gone'; instance: number }
  | { type: 'dispose' };

type LeaseFacts = Record<string, unknown>;

/** How one unlock call made from this process's main thread went. */
export interface FallbackUnlock {
  outcome: 'released' | 'unknown' | 'failed';
  error?: string | number;
}

// `holding`: the thread may still hold the lock (a lease, or an unlock it has
// not proven), after the event.
export type LeaseThreadEvent =
  | { type: 'disposed'; outcome: string }
  | {
      holding: boolean;
      type: 'answer';
      instance: number;
      action: number;
      seq: number;
      lease: number;
      answer: string;
      deadlineAt: number;
      facts: LeaseFacts;
    }
  | {
      holding: boolean;
      type: 'released';
      instance: number;
      action: number;
      seq: number;
      lease: number;
      outcome: string;
      reply: boolean;
      facts: LeaseFacts | null;
    };

export interface LeaseThread {
  post(message: LeaseThreadRequest): void;
  /** Stops the thread at once. */
  stop(): void;
}

/** Starts the lease owner; `exit` reports that it can take no more leases. */
export type StartLeaseThread = (events: {
  message(event: LeaseThreadEvent): void;
  exit(reason: string): void;
}) => LeaseThread;

/** The lease thread, and the one unlock call this process's main thread makes
 *  when that thread ended and may have left the lock held. The lock belongs to
 *  the process, so any of its threads may end it. Never throws. */
export interface ForegroundLeaseRuntime {
  startThread: StartLeaseThread;
  fallbackUnlock(): FallbackUnlock;
}

export interface HostForegroundLock {
  /** One request line from `worker`, without its prefix. Never throws. */
  handle(payload: string, worker: LeaseWorker): void;
  /** This side's facts for a worker's action, once; undefined when it was not asked. */
  takeFacts(instance: number, action: number): LeaseFacts | undefined;
  /** The worker exited or was retired: a lease it holds ends now. */
  workerGone(instance: number): void;
  /** Ends the thread after asking it to release, and unlocks from here unless
   *  it confirmed the lock released or never held; how that went. */
  dispose(): Promise<LeaseFacts | undefined>;
}

/** How long dispose waits for the thread's own account of its release. */
const DISPOSE_ANSWER_MS = 100;

type LeaseLine =
  | { op: 'acquire'; action: number; seq: number; holdMs: number; answerBy: number }
  | { op: 'release'; action: number; seq: number; lease: number };

const boundedId = (value: unknown, min: number): number | undefined =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= MAX_ID
    ? (value as number)
    : undefined;

/** A well-formed request line, or undefined for anything else. */
function parseLeaseLine(payload: string): LeaseLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  const action = boundedId(message.action, 1);
  const seq = boundedId(message.seq, 1);
  if (action === undefined || seq === undefined) return undefined;
  if (message.op === 'acquire') {
    const holdMs = Number.isSafeInteger(message.hold_ms) ? (message.hold_ms as number) : 0;
    const answerBy = message.answer_by;
    if (holdMs < 1 || holdMs > MAX_HOLD_MS) return undefined;
    if (typeof answerBy !== 'number' || !Number.isFinite(answerBy) || answerBy < 0 || answerBy > 2 ** 52) {
      return undefined;
    }
    return { op: 'acquire', action, seq, holdMs, answerBy };
  }
  if (message.op === 'release') {
    const lease = boundedId(message.lease, 0);
    return lease === undefined ? undefined : { op: 'release', action, seq, lease };
  }
  return undefined;
}

export function createHostForegroundLock(runtime: ForegroundLeaseRuntime): HostForegroundLock {
  let thread: LeaseThread | undefined;
  // Why no lease thread can answer any more; empty while one can be started.
  let threadDown = '';
  let disposed = false;
  // Whether the thread may hold the lock: as it last said, or an acquire it
  // has not answered yet.
  let reportedHolding = false;
  let unansweredAcquires = 0;
  // How the thread ended and what main's own unlock call did, for the facts.
  let threadEnd: LeaseFacts | undefined;
  let disposedAnswer: ((outcome: string | undefined) => void) | undefined;
  const fallbackUnlock = (): LeaseFacts => {
    try {
      const result = runtime.fallbackUnlock();
      return {
        fallback_unlock: result.outcome,
        ...(result.error === undefined ? {} : { fallback_error: result.error }),
      };
    } catch (error) {
      return { fallback_unlock: 'failed', fallback_error: error instanceof Error ? error.message : String(error) };
    }
  };
  const workers = new Map<number, LeaseWorker>();
  const factsByAction = new Map<string, LeaseFacts>();
  const factsKey = (instance: number, action: number) => `${instance}:${action}`;

  const write = (instance: number, line: string): void => {
    try {
      workers.get(instance)?.write(line);
    } catch {
      // The worker's wait runs out, which it reads as no answer.
    }
  };
  const file = (instance: number, action: number, facts: LeaseFacts): void => {
    const key = factsKey(instance, action);
    factsByAction.delete(key);
    factsByAction.set(key, facts);
    if (factsByAction.size > MAX_FACTS) factsByAction.delete(factsByAction.keys().next().value as string);
  };
  const answer = (instance: number, action: number, seq: number, lease: number, said: string, deadlineAt: number) =>
    write(instance, `${FOREGROUND_LOCK_REPLY_PREFIX}ack ${action} ${seq} ${lease} ${said} ${deadlineAt.toFixed(3)}\n`);
  const released = (instance: number, action: number, seq: number, lease: number, outcome: string) =>
    write(instance, `${FOREGROUND_LOCK_REPLY_PREFIX}released ${action} ${seq} ${lease} ${outcome}\n`);

  function onEvent(event: LeaseThreadEvent): void {
    if (event.type === 'disposed') {
      disposedAnswer?.(event.outcome);
      return;
    }
    reportedHolding = event.holding;
    if (event.type === 'answer') unansweredAcquires = Math.max(0, unansweredAcquires - 1);
    if (disposed) return;
    if (event.type === 'answer') {
      file(event.instance, event.action, event.facts);
      answer(event.instance, event.action, event.seq, event.lease, event.answer, event.deadlineAt);
      return;
    }
    const key = factsKey(event.instance, event.action);
    // Only the action's own lease updates its facts; a late end of an older one does not.
    if (event.facts && factsByAction.get(key)?.lease === event.lease) factsByAction.set(key, event.facts);
    if (event.reply) released(event.instance, event.action, event.seq, event.lease, event.outcome);
  }

  function leaseThread(): LeaseThread | undefined {
    if (thread || threadDown || disposed) return thread;
    let ended = false;
    try {
      thread = runtime.startThread({
        message: (event) => {
          try {
            onEvent(event);
          } catch {
            // A worker without its answer reads that as none.
          }
        },
        // A thread that crashed or was stopped may have left the lock held:
        // main makes one unlock call of its own, and dispose makes its own.
        exit: (reason) => {
          if (ended) return;
          ended = true;
          thread = undefined;
          threadDown ||= reason;
          if (disposed) return;
          const mayHold = reportedHolding || unansweredAcquires > 0;
          threadEnd = { reason, holding: mayHold, ...(mayHold ? fallbackUnlock() : {}) };
          reportedHolding = false;
          unansweredAcquires = 0;
        },
      });
    } catch (error) {
      threadDown = `the lease thread could not start: ${error instanceof Error ? error.message : String(error)}`;
    }
    return thread;
  }

  return {
    handle(payload, worker) {
      try {
        const line = parseLeaseLine(payload);
        if (!line || !worker.owns(line.action) || disposed) return;
        workers.set(worker.instance, worker);
        const active = line.op === 'acquire' ? leaseThread() : thread;
        if (line.op === 'acquire') {
          if (active) {
            unansweredAcquires++;
            active.post({
              type: 'acquire',
              instance: worker.instance,
              pid: worker.pid ?? 0,
              action: line.action,
              seq: line.seq,
              holdMs: line.holdMs,
              answerBy: line.answerBy,
            });
            return;
          }
          file(worker.instance, line.action, {
            lease: 0,
            answer: 'unavailable',
            host_pid: process.pid,
            reason: threadDown,
          });
          answer(worker.instance, line.action, line.seq, 0, 'unavailable', 0);
          return;
        }
        if (active) {
          active.post({
            type: 'release',
            instance: worker.instance,
            action: line.action,
            seq: line.seq,
            lease: line.lease,
          });
          return;
        }
        // A thread that ended holding the lock got main's one unlock call, whose
        // outcome is the account; one that held nothing, or never started, left none.
        const ended = threadEnd?.holding ? String(threadEnd.fallback_unlock) : 'none';
        released(worker.instance, line.action, line.seq, line.lease, ended);
      } catch {
        // Ignored like any other line the channel cannot use.
      }
    },
    takeFacts(instance, action) {
      const key = factsKey(instance, action);
      const facts = factsByAction.get(key);
      factsByAction.delete(key);
      return facts && threadEnd ? { ...facts, lease_thread: threadEnd } : facts;
    },
    workerGone(instance) {
      if (!workers.delete(instance)) return;
      for (const key of [...factsByAction.keys()]) if (key.startsWith(`${instance}:`)) factsByAction.delete(key);
      try {
        thread?.post({ type: 'gone', instance });
      } catch {
        // The lease still ends at its deadline.
      }
    },
    // Asks the thread to end any lease, waits briefly for its account, then
    // stops it. Unless it confirmed released or none, main unlocks once; no
    // retry follows, since the app is going and the user's Alt key or click
    // lifts anything left.
    async dispose() {
      if (disposed) return undefined;
      disposed = true;
      const active = thread;
      thread = undefined;
      workers.clear();
      factsByAction.clear();
      if (!active) return threadEnd;
      const outcome = await new Promise<string | undefined>((resolve) => {
        disposedAnswer = resolve;
        setTimeout(() => resolve(undefined), DISPOSE_ANSWER_MS);
        try {
          active.post({ type: 'dispose' });
        } catch {
          resolve(undefined);
        }
      });
      disposedAnswer = undefined;
      active.stop();
      const confirmed = outcome === 'released' || outcome === 'none';
      return { thread_release: outcome ?? 'no_answer', ...(confirmed ? {} : fallbackUnlock()) };
    },
  };
}

/** Starts the lease owner as a worker thread. `workerData` names how it loads
 *  user32: `koffiPath`, or a test's `nativeModule`. */
export function leaseThreadStarter(workerData: Record<string, unknown>): StartLeaseThread {
  return (events) => {
    const worker = new Worker(LEASE_THREAD_SOURCE, { eval: true, workerData });
    // Never what keeps the app alive; a lease it holds ends at its deadline or at dispose.
    worker.unref();
    worker.on('message', (event: LeaseThreadEvent) => events.message(event));
    worker.on('error', (error) => events.exit(`the lease thread failed: ${error.message}`));
    worker.on('exit', (code) => events.exit(`the lease thread exited (${code})`));
    return {
      post: (message) => worker.postMessage(message),
      stop: () => void worker.terminate(),
    };
  };
}

/** The app's lease thread, loading user32 through koffi resolved from
 *  `resolveFrom`: this bundle, or the app directory for a harness bundled
 *  outside it. A packaged app keeps koffi unpacked beside its asar archive
 *  (electron-builder.yml asarUnpack), which the thread loads directly. */
export function koffiLeaseThread(resolveFrom: string = import.meta.url): StartLeaseThread {
  return (events) => {
    const resolved = createRequire(resolveFrom).resolve('koffi');
    const unpacked = resolved.replace(/\.asar([\\/])/, '.asar.unpacked$1');
    const koffiPath = unpacked !== resolved && existsSync(unpacked) ? unpacked : resolved;
    return leaseThreadStarter({ koffiPath })(events);
  };
}

/** One LockSetForegroundWindow(LSFW_UNLOCK) from the calling (main) thread,
 *  with koffi loaded on first use. A false return is unknown, as on the lease
 *  thread; a load or call that throws is failed. */
export function koffiFallbackUnlock(resolveFrom: string = import.meta.url): () => FallbackUnlock {
  let unlock: (() => FallbackUnlock) | undefined;
  return () => {
    try {
      unlock ??= (() => {
        const koffi: typeof import('koffi') = createRequire(resolveFrom)('koffi');
        const lockSetForegroundWindow = koffi
          .load('user32.dll')
          .func('bool __stdcall LockSetForegroundWindow(uint32_t code)');
        const getLastError = koffi.load('kernel32.dll').func('uint32_t __stdcall GetLastError()');
        return (): FallbackUnlock =>
          lockSetForegroundWindow(2) ? { outcome: 'released' } : { outcome: 'unknown', error: Number(getLastError()) };
      })();
      return unlock();
    } catch (error) {
      return { outcome: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  };
}

/** The app's lease thread and main-thread fallback, both through koffi
 *  resolved from `resolveFrom`. */
export function koffiForegroundLease(resolveFrom: string = import.meta.url): ForegroundLeaseRuntime {
  return { startThread: koffiLeaseThread(resolveFrom), fallbackUnlock: koffiFallbackUnlock(resolveFrom) };
}
