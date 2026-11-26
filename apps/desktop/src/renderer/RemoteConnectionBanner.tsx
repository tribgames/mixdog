import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  currentRemoteConnectionState,
  isRemoteConnectionOutage,
  isRemoteDesktopOffline,
  subscribeRemoteConnectionState,
} from './remote-connection-state';

const DISCONNECTED_AFTER_MS = 10_000;
const RECOVERED_AFTER_MS = 3_000;
const FAILED_AFTER_MS = 30_000;

export type RemoteConnectionPhase = 'hidden' | 'connecting' | 'failed';

export interface RemoteConnectionLineView {
  readonly phase: RemoteConnectionPhase;
}

const HIDDEN: RemoteConnectionLineView = { phase: 'hidden' };
const CONNECTING: RemoteConnectionLineView = { phase: 'connecting' };
const FAILED: RemoteConnectionLineView = { phase: 'failed' };

// The workspace's one outage clock in the app shell publishes the link phase to composers and the brand dot.
let publishedLine = HIDDEN;
const lineListeners = new Set<() => void>();

function publishLine(line: RemoteConnectionLineView): void {
  if (publishedLine === line) return;
  publishedLine = line;
  for (const listener of [...lineListeners]) listener();
}

function subscribeLine(listener: () => void): () => void {
  lineListeners.add(listener);
  return () => void lineListeners.delete(listener);
}

export function useRemoteConnectionLine(): RemoteConnectionLineView {
  return useSyncExternalStore(
    subscribeLine,
    () => publishedLine,
    () => HIDDEN
  );
}

/** The link is down: nothing can be sent until it is back. */
export function useRemoteSendBlocked(): boolean {
  const { phase } = useRemoteConnectionLine();
  return phase === 'connecting' || phase === 'failed';
}

/** Headless workspace outage clock: publishes the connection phase without rendering any card UI. */
export function RemoteConnectionBanner(): null {
  const line = useRemoteOutage();
  useEffect(() => {
    publishLine(line);
  }, [line]);
  useEffect(() => () => publishLine(HIDDEN), []);
  return null;
}

function useRemoteOutage(): RemoteConnectionLineView {
  const state = useSyncExternalStore(subscribeRemoteConnectionState, currentRemoteConnectionState, () => null);
  const waiting = useSyncExternalStore(
    subscribeRemoteConnectionState,
    () => isRemoteConnectionOutage(false),
    () => false
  );
  const desktopOffline = useSyncExternalStore(subscribeRemoteConnectionState, isRemoteDesktopOffline, () => false);
  // Only outage time counts: a healthy view sync on a socket that is up is as
  // good as connected here, so it holds toward recovery like 'connected' and
  // a countdown that expires during it shows nothing unless the link drops.
  let recovery: 'cleared' | 'connected' | 'lost' = 'lost';
  if (state === null) recovery = 'cleared';
  else if (!waiting) recovery = 'connected';
  // 'due' is an elapsed countdown that surfaces as soon as the link is not
  // connected; 'shown' stays up until the connection is proven restored.
  const [overlay, setOverlay] = useState<'hidden' | 'due' | 'shown'>('hidden');
  // A hidden page has no one waiting: its gap is not counted, and every return
  // to the foreground starts the countdown from zero.
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== 'hidden');
  const countdown = useRef<number | null>(null);
  useEffect(() => {
    const onVisibility = (): void => {
      const visible = document.visibilityState !== 'hidden';
      setPageVisible(visible);
      if (visible) return;
      if (countdown.current !== null) window.clearTimeout(countdown.current);
      countdown.current = null;
      setOverlay('hidden');
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (countdown.current !== null) window.clearTimeout(countdown.current);
      countdown.current = null;
    };
  }, []);
  useEffect(() => {
    if (!pageVisible || !waiting || overlay !== 'hidden' || countdown.current !== null) return;
    countdown.current = window.setTimeout(() => {
      countdown.current = null;
      setOverlay('due');
    }, DISCONNECTED_AFTER_MS);
  }, [pageVisible, waiting, overlay]);
  useEffect(() => {
    if (recovery === 'lost') return () => {};
    const reset = (): void => {
      if (countdown.current !== null) window.clearTimeout(countdown.current);
      countdown.current = null;
      setOverlay('hidden');
    };
    if (recovery === 'cleared') {
      reset();
      return () => {};
    }
    const timer = window.setTimeout(reset, RECOVERED_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [recovery]);
  useEffect(() => {
    if (overlay !== 'due' || recovery !== 'lost') return;
    setOverlay('shown');
  }, [overlay, recovery]);
  const down = recovery === 'lost' && (overlay === 'shown' || overlay === 'due');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!down) {
      setFailed(false);
      return undefined;
    }
    if (failed) return undefined;
    if (desktopOffline) {
      setFailed(true);
      return undefined;
    }
    const timer = window.setTimeout(() => setFailed(true), FAILED_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [down, failed, desktopOffline]);
  if (!down) return HIDDEN;
  return failed ? FAILED : CONNECTING;
}
