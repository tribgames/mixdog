import type { DesktopSessionStateUpdate } from '../shared/contract';
import { createLatestStateMailbox, type LatestStateMailbox } from './desktop-service-protocol';

export const REMOTE_STREAM_BATCH_MS = 16;

type Timers = {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};

function sameFields(before: Record<string, unknown>, after: Record<string, unknown>, omitted: string): boolean {
  const left = Object.keys(before).filter((key) => key !== omitted);
  const right = Object.keys(after).filter((key) => key !== omitted);
  return left.length === right.length && left.every((key) =>
    Object.hasOwn(after, key)
    && (Object.is(before[key], after[key]) || JSON.stringify(before[key]) === JSON.stringify(after[key])));
}

/** Batch only a proved text append. Every other state transition — including
 *  unknown future approval fields — bypasses the timer without an allowlist. */
function isTextAppend(before: DesktopSessionStateUpdate | null, after: DesktopSessionStateUpdate): boolean {
  const old = before?.snapshot;
  const next = after.snapshot;
  if (before?.frameSource !== 'live' || after.frameSource !== 'live'
    || before.sessionId !== after.sessionId || after.laneEnd
    || !old || !next || old.busy !== true || next.busy !== true
    || old.items !== next.items) return false;
  const left = old.streamingTail;
  const right = next.streamingTail;
  if (!left || !right || left.id == null || left.id !== right.id
    || right.kind !== 'assistant' || typeof left.text !== 'string' || typeof right.text !== 'string'
    || right.text.length <= left.text.length || !right.text.startsWith(left.text)) return false;
  return sameFields(left, right, 'text') && sameFields(old, next, 'streamingTail');
}

/** One latest snapshot and one timer per session, before delta encoding.
 *  Non-text transitions remain non-droppable even if a later text append
 *  replaces their queued snapshot while the socket is busy. */
export function createRemoteStreamingMailbox(
  send: (sequence: number, update: DesktopSessionStateUpdate, critical: boolean) => void,
  timers: Timers = { setTimeout, clearTimeout },
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
  return {
    publish(update): void {
      const append = isTextAppend(previous, update);
      previous = update;
      if (!append) {
        cancelDelay();
        criticalPending = true;
        mailbox.publish(update);
        return;
      }
      delayed = update;
      if (timer !== null) return;
      timer = timers.setTimeout(() => {
        timer = null;
        const latest = delayed;
        delayed = null;
        if (latest) mailbox.publish(latest);
      }, REMOTE_STREAM_BATCH_MS);
      timer.unref?.();
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
