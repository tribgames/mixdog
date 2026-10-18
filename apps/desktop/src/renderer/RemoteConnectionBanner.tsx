import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { t } from './i18n';
import {
  currentRemoteConnectionState,
  isRemoteConnectionOutage,
  REMOTE_WAKE_EVENT,
  subscribeRemoteConnectionState,
} from './remote-connection-state';

// The shim retries every connection problem on its own, forever, so nothing
// here is a failure: there is no error state, no cause (no internet, PC
// offline) and nothing that blocks the screen. Every foreground return costs
// a short reconnect gap (socket recycle, relay dial, E2EE handshake); that
// blip gets NO surface at all (user: 백그라운드 갔다오니 디스커넥트 창 / 팝업 뜨지
// 말고 자동으로 빨리 연결). Only an outage that outlives DISCONNECTED_AFTER_MS
// earns one tiny status dot — no text, no card, nothing over the screen. An
// unstable link must not flicker, so only a connection that holds for
// RECOVERED_AFTER_MS counts as restored: that alone drops the dot and starts
// the countdown over from zero. A shorter 'connected' blip, or
// a 'connecting' state in between, neither hides a shown pill nor restarts a
// running countdown.
const DISCONNECTED_AFTER_MS = 10_000;
const RECOVERED_AFTER_MS = 3_000;

export function RemoteConnectionBanner({ boot = false }: { boot?: boolean } = {}) {
  const state = useSyncExternalStore(subscribeRemoteConnectionState, currentRemoteConnectionState, () => null);
  const waiting = useSyncExternalStore(
    subscribeRemoteConnectionState,
    () => isRemoteConnectionOutage(boot),
    () => false
  );
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
    if (overlay === 'due' && recovery === 'lost') setOverlay('shown');
  }, [overlay, recovery]);
  if (recovery === 'cleared' || !(overlay === 'shown' || (overlay === 'due' && recovery === 'lost'))) return null;

  // The dot only informs: reconnection never waits for the user. A tap is a
  // silent shortcut that retries now instead of waiting out the backoff.
  return (
    <button
      type="button"
      className="remote-connection-indicator"
      aria-label={t('Connecting…')}
      onClick={() => window.dispatchEvent(new Event(REMOTE_WAKE_EVENT))}
    >
      <i className="remote-connection-indicator-dot" aria-hidden="true" />
    </button>
  );
}
