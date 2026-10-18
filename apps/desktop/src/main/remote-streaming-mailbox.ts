import type { DesktopSessionStateUpdate } from '../shared/contract';
import { isStreamingTextAppend } from '../shared/streaming-text-append';
import { createLatestStateMailbox, type LatestStateMailbox } from './desktop-service-protocol';

/** A phone repaints a whole markdown tail per frame it receives. At 16ms
 *  nearly every desktop update became its own socket frame (168 frames for
 *  173 updates) and a throttled phone missed half its vsyncs; ~90ms keeps
 *  text visibly flowing at ~11 paints a second. The window opens with the
 *  append that ends a quiet spell, which travels at once: the first words of
 *  a reply never wait for it. */
export const REMOTE_STREAM_BATCH_MS = 90;

type Timers = {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};

/** One latest snapshot and one timer per session, before delta encoding.
 *  Non-text transitions remain non-droppable even if a later text append
 *  replaces their queued snapshot while the socket is busy. */
export function createRemoteStreamingMailbox(
  send: (sequence: number, update: DesktopSessionStateUpdate, critical: boolean) => void,
  timers: Timers = { setTimeout, clearTimeout }
): LatestStateMailbox<DesktopSessionStateUpdate> {
  let previous: DesktopSessionStateUpdate | null = null;
  let delayed: DesktopSessionStateUpdate | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let criticalPending = false;
  const mailbox = createLatestStateMailbox<DesktopSessionStateUpdate>((sequence, update) => {
    const critical = criticalPending;
    criticalPending = false;
    send(sequence, update, critical);
  });
  const cancelDelay = (): void => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    delayed = null;
  };
  // An append sent now holds the appends after it for one window; the
  // window's latest append ends it and opens the next one.
  const sendAndHold = (update: DesktopSessionStateUpdate): void => {
    mailbox.publish(update);
    timer = timers.setTimeout(() => {
      timer = null;
      const latest = delayed;
      delayed = null;
      if (latest) sendAndHold(latest);
    }, REMOTE_STREAM_BATCH_MS);
    timer.unref?.();
  };
  return {
    publish(update): void {
      // Batch only a proved text append; every other transition bypasses the timer.
      const append = isStreamingTextAppend(previous, update);
      previous = update;
      if (!append) {
        cancelDelay();
        criticalPending = true;
        mailbox.publish(update);
        return;
      }
      if (timer !== null) {
        delayed = update;
        return;
      }
      sendAndHold(update);
    },
    acknowledge: mailbox.acknowledge,
    reset(update): void {
      cancelDelay();
      previous = update;
      criticalPending = true;
      mailbox.reset(update);
    },
    clear(): void {
      cancelDelay();
      previous = null;
      criticalPending = false;
      mailbox.clear();
    },
  };
}
