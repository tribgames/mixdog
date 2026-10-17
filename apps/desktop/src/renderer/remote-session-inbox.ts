import type { DesktopSessionStateUpdate } from '../shared/contract';
import { isStreamingTextAppend } from '../shared/streaming-text-append';

type Frames = {
  request(callback: () => void): number;
  cancel(handle: number): void;
};

const animationFrames: Frames = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

/** The socket can deliver restored sessions before React installs its store.
 * Keep only the latest unread frame per session; once a store subscribes it
 * owns retention. Losing an overflowed frame must request a fresh baseline,
 * since an unchanged host snapshot otherwise produces no further delta.
 *
 * A proved streaming text append (the desktop mailbox's own test) waits for
 * the next animation frame and is replaced by any later append, so stores
 * apply at most one streaming snapshot per session per frame. Every other
 * frame is delivered at once and supersedes a held append: each snapshot is
 * complete, so the latest one is the transcript the desktop shows. */
export function createRemoteSessionInbox({
  maxEntries = 32,
  onGap,
  frames = animationFrames,
}: {
  maxEntries?: number;
  onGap(): void;
  frames?: Frames;
}) {
  const pending = new Map<string, DesktopSessionStateUpdate>();
  const listeners = new Set<(update: DesktopSessionStateUpdate) => void>();
  /** Last received live busy frame per session: the base an append is proved against. */
  const streaming = new Map<string, DesktopSessionStateUpdate>();
  const held = new Map<string, DesktopSessionStateUpdate>();
  let frame: number | null = null;
  let gap = false;
  const notify = (listener: (update: DesktopSessionStateUpdate) => void, update: DesktopSessionStateUpdate): void => {
    try {
      listener(update);
    } catch {
      /* Renderer faults cannot break delivery. */
    }
  };
  const deliver = (update: DesktopSessionStateUpdate): void => {
    if (listeners.size > 0) {
      for (const listener of [...listeners]) notify(listener, update);
      return;
    }
    pending.delete(update.sessionId);
    pending.set(update.sessionId, update);
    while (pending.size > Math.max(1, maxEntries)) {
      const oldest = pending.keys().next();
      if (oldest.done) break;
      pending.delete(oldest.value);
      gap = true;
    }
  };
  const flush = (): void => {
    frame = null;
    const due = [...held.values()];
    held.clear();
    for (const update of due) deliver(update);
  };
  return {
    reset(): void {
      if (frame !== null) frames.cancel(frame);
      frame = null;
      held.clear();
      streaming.clear();
      pending.clear();
      gap = false;
    },
    publish(update: DesktopSessionStateUpdate): void {
      const append = isStreamingTextAppend(streaming.get(update.sessionId) ?? null, update);
      if (update.frameSource === 'live' && update.snapshot?.busy === true) streaming.set(update.sessionId, update);
      else streaming.delete(update.sessionId);
      if (append && listeners.size > 0) {
        held.set(update.sessionId, update);
        if (frame === null) frame = frames.request(flush);
        return;
      }
      held.delete(update.sessionId);
      deliver(update);
    },
    subscribe(listener: (update: DesktopSessionStateUpdate) => void): () => void {
      listeners.add(listener);
      const retained = [...pending.values()];
      pending.clear();
      for (const update of retained) notify(listener, update);
      if (gap) {
        gap = false;
        onGap();
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
