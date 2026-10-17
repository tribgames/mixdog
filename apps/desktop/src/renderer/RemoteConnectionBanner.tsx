import { WifiOff } from 'lucide-react';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';

import { t } from './i18n';
import {
  currentRemoteConnectionLabel,
  currentRemoteConnectionState,
  REMOTE_WAKE_EVENT,
  subscribeRemoteConnectionLabel,
  subscribeRemoteConnectionState,
  type RemoteConnectionLabel,
} from './remote-connection-state';

function labelText(label: RemoteConnectionLabel): string {
  if (label === 'no-internet') return t('No internet');
  if (label === 'pc-offline') return t('PC offline or asleep');
  if (label === 'updating') return t('Updating messages…');
  return t('Reconnecting…');
}

// Every foreground return costs a short reconnect gap (socket recycle, relay
// dial, E2EE handshake). That blip is NOT an outage and gets NO surface at all
// (user: 백그라운드 갔다오니 디스커넥트 창). Only a gap that outlives
// DISCONNECTED_AFTER_MS is treated as disconnected. An unstable link must not
// flicker, so only a connection that holds for RECOVERED_AFTER_MS counts as
// restored: that alone drops the overlay and starts the countdown over from
// zero. A shorter 'connected' blip, or a 'connecting' state in between, neither
// hides a shown overlay nor restarts a running countdown.
const DISCONNECTED_AFTER_MS = 10_000;
const RECOVERED_AFTER_MS = 3_000;

export function RemoteConnectionBanner({ boot = false }: { boot?: boolean } = {}) {
  const state = useSyncExternalStore(subscribeRemoteConnectionState, currentRemoteConnectionState, () => null);
  const label = useSyncExternalStore(
    subscribeRemoteConnectionLabel,
    currentRemoteConnectionLabel,
    (): RemoteConnectionLabel => 'reconnecting'
  );
  const labelId = useId();
  const waiting = state === 'reconnecting' || state === 'syncing' || (boot && state === 'connecting');
  let recovery: 'cleared' | 'connected' | 'lost' = 'lost';
  if (state === null) recovery = 'cleared';
  else if (state === 'connected') recovery = 'connected';
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
    if (overlay === 'due' && recovery === 'lost') setOverlay('shown');
  }, [overlay, recovery]);
  if (recovery === 'cleared' || !(overlay === 'shown' || (overlay === 'due' && recovery === 'lost'))) return null;

  // The card only informs: reconnection never waits for the user. A tap is a
  // silent shortcut that retries now instead of waiting out the backoff.
  return (
    <button
      type="button"
      className="remote-connection-overlay"
      aria-label={t('Retry')}
      aria-describedby={labelId}
      data-reason={label}
      onClick={() => window.dispatchEvent(new Event(REMOTE_WAKE_EVENT))}
    >
      <span className="remote-connection-overlay-card">
        <WifiOff aria-hidden="true" />
        <span id={labelId} className="remote-connection-overlay-label">
          {labelText(label)}
        </span>
        {/* The reconnecting label already says it; the hint would repeat it. */}
        {label !== 'reconnecting' && <span className="remote-connection-overlay-hint">{t('Reconnecting…')}</span>}
      </span>
    </button>
  );
}
