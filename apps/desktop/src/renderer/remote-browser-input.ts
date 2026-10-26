import type { DesktopRemoteBrowserControl } from '../shared/contract';
import type { RemoteWebrtcRelayInputOrder } from '../shared/remote-webrtc';

// The order beside each relay control on a `browserWebrtc` host is the
// contract's RemoteWebrtcRelayInputOrder: `stream` names this queue, `seq`
// rises with every control sent, `run` rises after a failure (and when the
// page's document is replaced). The host applies nothing more of a run once
// one of its controls failed, so input sent behind an uncertain failure is
// dropped, never replayed.

/** Input admitted but not yet settled; past it, input is refused as busy. */
const MAX_PENDING_INPUT = 128;

function newStreamId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Human input to the remote page, in order, without tying every keystroke to
 * a new screenshot. Each action keeps the document/frame the user was looking
 * at when it was queued. A failed or uncertain action is never replayed, and
 * input queued behind it is dropped.
 *
 * An older host gets one control at a time, each waiting for the previous
 * reply. A host taking ordered input (`pipelined`) gets them as they come:
 * a relay round trip no longer separates a tap's move, press and release. */
export function createRemoteBrowserInputQueue(options: {
  /** `order` is null for a host that predates ordered input. */
  send(input: DesktopRemoteBrowserControl, order: RemoteWebrtcRelayInputOrder | null): Promise<void>;
  failure(message: string): void;
  settled(): void;
  /** Read per send: a reconnect may reach another host. */
  pipelined?(): boolean;
  streamId?: string;
}) {
  const stream = options.streamId ?? newStreamId();
  /** Serial mode: the previous action's settlement. */
  let tail: Promise<void> = Promise.resolve();
  /** Pipelined mode: the newest fence; later input waits for it to settle. */
  let barrier: Promise<void> = Promise.resolve();
  /** Pipelined input admitted and not yet answered; a fence waits for all of it. */
  const inflight = new Set<Promise<void>>();
  let pending = 0;
  let generation = 0;
  let run = 1;
  let seq = 0;
  let active = true;

  const fail = (failedRun: number, error: unknown): void => {
    // Only the first failure of a run speaks; the rest of that run was
    // refused (or lost) because of it.
    if (!active || failedRun !== run) return;
    generation += 1;
    run += 1;
    const message = error instanceof Error ? error.message : String(error);
    options.failure(`${message} Pending input was not sent.`);
  };
  const settle = (): void => {
    pending -= 1;
    if (active) options.settled();
  };

  return {
    activate() {
      active = true;
    },
    /** Drop input admitted but not yet sent (the document it targeted is gone). */
    reset() {
      generation += 1;
      run += 1;
    },
    dispose() {
      active = false;
      generation += 1;
      run += 1;
    },
    enqueue(input: DesktopRemoteBrowserControl): Promise<void> {
      if (!active) return Promise.resolve();
      if (pending >= MAX_PENDING_INPUT) {
        options.failure('Remote Browser Use input is busy; input was not sent.');
        return Promise.resolve();
      }
      const admitted = generation;
      pending += 1;
      if (options.pipelined?.() === true) {
        const work = barrier.then(() => {
          if (!active || admitted !== generation) return;
          const sentRun = run;
          seq += 1;
          return options
            .send(input, { v: 1, stream, run: sentRun, seq })
            .catch((error: unknown) => fail(sentRun, error));
        });
        // Counted from admission: a fence after it waits for its answer even
        // when it has not left yet.
        inflight.add(work);
        return work.finally(() => {
          inflight.delete(work);
          settle();
        });
      }
      const work = tail.then(async () => {
        if (!active || admitted !== generation) return;
        const sentRun = run;
        await options.send(input, null).catch((error: unknown) => fail(sentRun, error));
      });
      tail = work.finally(settle);
      return tail;
    },
    /** Runs `work` on the relay after every control sent before it has been
     *  answered, and holds every control after it until `work` settles (the
     *  WebRTC promotion and demotion acknowledgements). A failed `work` drops
     *  what waits behind it, like a failed control, and the returned promise
     *  rejects with its error: the caller's barrier is uncertain. */
    fence(work: () => Promise<void>): Promise<void> {
      const previous = Promise.all([barrier, tail, ...inflight]);
      const fenced = previous.then(async () => {
        if (!active) return;
        const fencedRun = run;
        await work().catch((error: unknown) => {
          fail(fencedRun, error);
          throw error;
        });
      });
      // Later input waits for the fence to settle, not for it to succeed.
      const settled = fenced.catch(() => {});
      barrier = settled;
      tail = settled;
      return fenced;
    },
  };
}
