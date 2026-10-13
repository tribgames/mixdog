// Which sessions' pages a streaming phone currently drives (its viewport wins
// over the PC pane's), from the host's remote-viewer notices.
import { useSyncExternalStore } from 'react';

import type { DesktopBrowserRemoteViewerChange } from '../shared/contract';

const drivenSessions = new Set<string>();
const listeners = new Set<() => void>();

/** A viewer that stopped streaming no longer drives; otherwise only a notice
 *  that names `driving` changes it. */
export function noteBrowserRemoteViewer(change: DesktopBrowserRemoteViewerChange | null | undefined): void {
  const sessionId = String(change?.sessionId || '');
  if (!sessionId) return;
  let driving: boolean;
  if (change?.active !== true) driving = false;
  else if (typeof change.driving === 'boolean') driving = change.driving;
  else return;
  if (driving === drivenSessions.has(sessionId)) return;
  if (driving) drivenSessions.add(sessionId);
  else drivenSessions.delete(sessionId);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useBrowserRemoteDriving(sessionId: string): boolean {
  return useSyncExternalStore(subscribe, () => drivenSessions.has(sessionId));
}
