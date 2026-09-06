import type { DesktopSessionStateUpdate } from "../shared/contract";

/** The socket can deliver restored sessions before React installs its store.
 * Keep only the latest unread frame per session; once a store subscribes it
 * owns retention. Losing an overflowed frame must request a fresh baseline,
 * since an unchanged host snapshot otherwise produces no further delta. */
export function createRemoteSessionInbox({
  maxEntries = 32,
  onGap,
}: {
  maxEntries?: number;
  onGap(): void;
}) {
  const pending = new Map<string, DesktopSessionStateUpdate>();
  const listeners = new Set<(update: DesktopSessionStateUpdate) => void>();
  let gap = false;
  const notify = (
    listener: (update: DesktopSessionStateUpdate) => void,
    update: DesktopSessionStateUpdate,
  ): void => {
    try { listener(update); } catch { /* Renderer faults cannot break delivery. */ }
  };
  return {
    reset(): void {
      pending.clear();
      gap = false;
    },
    publish(update: DesktopSessionStateUpdate): void {
      if (listeners.size > 0) {
        for (const listener of [...listeners]) notify(listener, update);
        return;
      }
      pending.delete(update.sessionId);
      pending.set(update.sessionId, update);
      while (pending.size > Math.max(1, maxEntries)) {
        pending.delete(pending.keys().next().value!);
        gap = true;
      }
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
      return () => { listeners.delete(listener); };
    },
  };
}
