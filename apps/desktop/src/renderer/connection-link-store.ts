// A server window's link to its daemon, as main pushes it: the state the
// banner, the title-bar chip, the composer and the terminals read, the notices
// main sends once attached again, and the tool calls whose result never came.
import { useSyncExternalStore } from 'react';

import type {
  DesktopConnectionLinkView,
  DesktopConnectionNotice,
  DesktopServerRestoreProgress,
} from '../shared/contract';
import { isSshConnectionWindow } from './desktop-connection';
import { invalidateSidebarReferenceForMutation } from './sidebar-reference-cache';

/** Fired on window when a server window is attached again after an outage:
 *  terminals re-attach and replay what they missed. */
export const CONNECTION_REATTACHED_EVENT = 'mixdog:connection-reattached';

let view: DesktopConnectionLinkView | null = null;
let started = false;
const listeners = new Set<() => void>();
const noticeListeners = new Set<(notice: DesktopConnectionNotice) => void>();
const unknownTools = new Set<string>();
let unknownVersion = 0;
const unknownListeners = new Set<() => void>();

/** Reconnecting or lost: the composer is blocked and terminals show it. */
export function isConnectionDown(current: DesktopConnectionLinkView | null): boolean {
  return current?.state.status === 'reconnecting' || current?.state.status === 'lost';
}

/** The model login changed: the provider status and model lists re-read
 *  once the restarted daemon is attached. */
let modelLoginChanged = false;

function apply(next: DesktopConnectionLinkView | null): void {
  const wasDown = isConnectionDown(view);
  if (view && next && view.modelLogin !== next.modelLogin) modelLoginChanged = true;
  view = next;
  for (const listener of listeners) listener();
  if (next?.state.status === 'connected' && modelLoginChanged) {
    modelLoginChanged = false;
    invalidateSidebarReferenceForMutation('completeOAuthProviderLogin');
  }
  if (wasDown && next?.state.status === 'connected') window.dispatchEvent(new Event(CONNECTION_REATTACHED_EVENT));
}

function start(): void {
  if (started) return;
  started = true;
  const api = window.mixdogDesktop;
  if (!isSshConnectionWindow() || !api) return;
  api.subscribeConnectionLink?.((next) => apply(next));
  api.subscribeConnectionNotice?.((notice) => {
    if (notice.kind === 'outcome-unknown') {
      for (const id of notice.toolIds) unknownTools.add(id);
      unknownVersion += 1;
      for (const listener of unknownListeners) listener();
    }
    for (const listener of noticeListeners) listener(notice);
  });
  void api
    .getConnectionLink?.()
    .then((current) => {
      if (current && !view) apply(current);
    })
    .catch(() => undefined);
}

export function connectionLinkView(): DesktopConnectionLinkView | null {
  start();
  return view;
}

export function subscribeConnectionLinkView(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConnectionLink(): DesktopConnectionLinkView | null {
  return useSyncExternalStore(subscribeConnectionLinkView, connectionLinkView, () => null);
}

export function subscribeConnectionNotices(listener: (notice: DesktopConnectionNotice) => void): () => void {
  start();
  noticeListeners.add(listener);
  return () => noticeListeners.delete(listener);
}

function isToolOutcomeUnknown(toolId: unknown): boolean {
  return toolId !== undefined && toolId !== null && unknownTools.has(String(toolId));
}

/** Tool calls whose result was lost with the link ("outcome unknown", never
 *  re-run): the returned check re-renders its reader when the set grows. */
export function useToolOutcomeUnknown(): (toolId: unknown) => boolean {
  useSyncExternalStore(
    (listener) => {
      start();
      unknownListeners.add(listener);
      return () => unknownListeners.delete(listener);
    },
    () => unknownVersion,
    () => 0
  );
  return isToolOutcomeUnknown;
}

/** Startup reopening of server windows, as this PC's window hears it. */
export function subscribeServerRestore(listener: (progress: DesktopServerRestoreProgress) => void): () => void {
  return window.mixdogDesktop?.subscribeServerRestoreProgress?.(listener) ?? (() => {});
}
