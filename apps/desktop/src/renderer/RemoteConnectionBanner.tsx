import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { nativeAppInfo } from '../shared/native-app';
import { t } from './i18n';
import { MxIcon } from './MxIcon';
import {
  currentRemoteConnectionState,
  forgetRemoteDesktopOffline,
  isRemoteConnectionOutage,
  isRemoteDesktopOffline,
  REMOTE_WAKE_EVENT,
  remoteRedialAt,
  subscribeRemoteConnectionState,
} from './remote-connection-state';

const DISCONNECTED_AFTER_MS = 10_000;
const RECOVERED_AFTER_MS = 3_000;
/** How long the line says it is connecting before it says the connection failed. The shim keeps redialing after that
 *  too; the line only stops promising it. The relay's own "PC offline" answer says so at once. */
const FAILED_AFTER_MS = 30_000;

/** What the connection line above the composer says about a relay surface's link to its PC. */
export type RemoteConnectionPhase = 'hidden' | 'connecting' | 'failed' | 'reconnected';

export interface RemoteConnectionLineView {
  readonly phase: RemoteConnectionPhase;
  /** Dial now instead of waiting out the backoff. */
  retry(): void;
}

const HIDDEN: RemoteConnectionLineView = { phase: 'hidden', retry: () => {} };

// The workspace's one outage clock (the banner in the app shell) publishes the line; every composer shows it.
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

/** The line says the link is down: nothing can be sent until it is back. */
export function useRemoteSendBlocked(): boolean {
  const { phase } = useRemoteConnectionLine();
  return phase === 'connecting' || phase === 'failed';
}

/** Re-renders every second while `active`, for a countdown read from the clock. */
function useSecondTick(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
}

/** The quota banner's island row: connecting with the next redial and a retry, failed with a retry (and, in the phone
 *  app, its PC list), or reconnected for a moment. */
function ConnectionLine({ line }: { line: RemoteConnectionLineView }) {
  const { phase, retry } = line;
  const redialAt = useSyncExternalStore(subscribeRemoteConnectionState, remoteRedialAt, () => null);
  const counting = phase === 'connecting' && redialAt !== null;
  useSecondTick(counting);
  const seconds = counting ? Math.ceil((redialAt - Date.now()) / 1_000) : 0;
  // Only the phone app has a PC list to return to.
  const native = nativeAppInfo();
  const failed = phase === 'failed';
  let title = t('Connecting to the server');
  let icon: 'loading' | 'warning' | 'check' = 'loading';
  if (failed) {
    title = t('Can’t connect to the server');
    icon = 'warning';
  } else if (phase === 'reconnected') {
    title = t('Reconnected');
    icon = 'check';
  }
  return (
    <section className="composer-connection-line" data-phase={phase} role={failed ? 'alert' : 'status'}>
      <MxIcon name={icon} size={16} className="composer-connection-line-icon" aria-hidden="true" />
      <div className="composer-connection-line-text">
        <strong className="composer-connection-line-title">{title}</strong>
        {seconds > 0 ? (
          <span className="composer-connection-line-note">{t('· Retrying in {{seconds}}s', { seconds })}</span>
        ) : null}
      </div>
      {phase === 'connecting' ? (
        <button
          type="button"
          className="composer-island-button composer-island-button-primary composer-connection-line-button"
          onClick={retry}
        >
          {t('Retry now')}
        </button>
      ) : null}
      {failed && native?.call ? (
        <button
          type="button"
          className="composer-island-button composer-connection-line-button"
          data-quiet="true"
          onClick={() => void native.call?.('openHostPicker').catch(() => undefined)}
        >
          {t('Other PC')}
        </button>
      ) : null}
      {failed ? (
        <button
          type="button"
          className="composer-island-button composer-island-button-primary composer-connection-line-button"
          onClick={retry}
        >
          {t('Try again')}
        </button>
      ) : null}
    </section>
  );
}

/** The connection line in a composer region (ComposerDock), between the island and the prompt input. */
export function ComposerConnectionLine() {
  const line = useRemoteConnectionLine();
  return line.phase === 'hidden' ? null : <ConnectionLine line={line} />;
}

/** The app shell's instance is the workspace's outage clock and publishes the line to every composer; the boot cover's
 *  instance (`boot`) shows it itself, where the composer will be. */
export function RemoteConnectionBanner({ boot = false }: { boot?: boolean } = {}) {
  const line = useRemoteOutage(boot);
  useEffect(() => {
    if (!boot) publishLine(line);
  }, [boot, line]);
  useEffect(() => (boot ? undefined : () => publishLine(HIDDEN)), [boot]);
  if (!boot || line.phase === 'hidden') return null;
  return (
    <div className="remote-boot-line">
      <ConnectionLine line={line} />
    </div>
  );
}

function useRemoteOutage(boot: boolean): RemoteConnectionLineView {
  const state = useSyncExternalStore(subscribeRemoteConnectionState, currentRemoteConnectionState, () => null);
  const waiting = useSyncExternalStore(
    subscribeRemoteConnectionState,
    () => isRemoteConnectionOutage(boot),
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
    if (!boot || !pageVisible || !waiting || !desktopOffline || overlay !== 'hidden') return;
    if (countdown.current !== null) window.clearTimeout(countdown.current);
    countdown.current = null;
    setOverlay('due');
  }, [boot, pageVisible, waiting, desktopOffline, overlay]);
  useEffect(() => {
    if (overlay === 'due' && recovery === 'lost') setOverlay('shown');
  }, [overlay, recovery]);
  const showing = recovery !== 'cleared' && (overlay === 'shown' || (overlay === 'due' && recovery === 'lost'));
  const down = showing && recovery === 'lost';
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
  // The shim redials at once; the line says connecting again until the relay answers "offline" again or the wait runs out again.
  const retry = useCallback(() => {
    forgetRemoteDesktopOffline();
    setFailed(false);
    window.dispatchEvent(new Event(REMOTE_WAKE_EVENT));
  }, []);
  let phase: RemoteConnectionPhase = 'hidden';
  // Connected, the boot cover only waits for the first screen to paint.
  if (showing && recovery === 'connected') phase = boot ? 'hidden' : 'reconnected';
  else if (showing) phase = failed ? 'failed' : 'connecting';
  return useMemo(() => ({ phase, retry }), [phase, retry]);
}
