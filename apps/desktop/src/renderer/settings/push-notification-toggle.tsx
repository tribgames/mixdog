// Settings → Connection, web app only: the switch that lets THIS device hear
// about a finished turn while the app is closed. The Electron window has the
// taskbar flash instead and never renders this — the shim is what supplies the
// push API, so its absence hides the group with no surface check.
import { useCallback, useEffect, useState } from 'react';

import type { DesktopApi } from '../../shared/contract';
import { t } from '../i18n';
import {
  relayPushHostStates,
  relayWebPushKey,
  statePushSubscription,
  unregisterRelayPushSubscription,
  type PushHostState,
} from '../push-notification-bridge';
import { readSavedPcs } from '../remote-saved-pcs';
import { Group, ToggleRow } from './capability-controls';

type PushApi = Partial<DesktopApi>;

const BLOCKED_NOTE = 'Notifications are blocked for this app. Allow them in your browser or system settings first.';

/** Paired PCs by saved name: those delivering to this browser through the
 *  relay, and those too old to (they keep no subscription here until
 *  updated). Null on the legacy path, where only the connected PC delivers. */
interface PcRegistrations {
  registered: string[];
  outdated: string[];
}

function pcNames(deviceIds: readonly string[]): string[] {
  const saved = readSavedPcs();
  return deviceIds.map((id) => saved.find((pc) => pc.deviceId === id.toLowerCase())?.name || t('PC'));
}

function pcRegistrations(states: readonly PushHostState[]): PcRegistrations | null {
  if (!states.some((state) => state.supported === true)) return null;
  return {
    registered: pcNames(states.filter((state) => state.registered).map((state) => state.deviceId)),
    outdated: pcNames(states.filter((state) => state.supported === false).map((state) => state.deviceId)),
  };
}

function RegisteredPcs({ pcs }: { pcs: PcRegistrations | null }) {
  if (pcs === null) return null;
  return (
    <>
      <p className="settings-connection-note">
        {pcs.registered.length > 0
          ? t('Notifications reach this device from: {{names}}', { names: pcs.registered.join(', ') })
          : t('No paired PC can notify this device yet.')}
      </p>
      {pcs.outdated.length > 0 && (
        <p className="settings-connection-note">
          {t('Update Mixdog on these PCs to get their notifications here: {{names}}', {
            names: pcs.outdated.join(', '),
          })}
        </p>
      )}
    </>
  );
}

function pushSupported(api: PushApi): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof api.pushPublicKey === 'function'
  );
}

export function PushNotificationToggle({ api }: { api: PushApi }) {
  const supported = pushSupported(api);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  // Which paired PCs deliver to this browser (relay-owned push only).
  const [pcs, setPcs] = useState<PcRegistrations | null>(null);

  // The browser owns the truth: a subscription can survive a reinstall of the
  // app or be cleared from browser settings without this UI ever hearing. A
  // subscription is only ON while the OS still lets this app notify: blocking
  // it in system settings keeps the subscription but shows nothing. Re-read on
  // return, since that change happens outside the app. The relay owns the
  // other half: which of this browser's PCs hold an association with it.
  useEffect(() => {
    if (!supported) return undefined;
    let live = true;
    const refresh = (): void => {
      if (document.visibilityState === 'hidden') return;
      void navigator.serviceWorker.ready
        .then((registration) => registration.pushManager.getSubscription())
        .then(async (subscription) => {
          if (!live) return;
          const permission = Notification.permission;
          const on = Boolean(subscription) && permission === 'granted';
          setEnabled(on);
          if (subscription && permission === 'denied') setNote(BLOCKED_NOTE);
          const relayKey = on && subscription ? await relayWebPushKey().catch(() => null) : null;
          const states = relayKey && subscription ? await relayPushHostStates(subscription.endpoint) : [];
          if (live) setPcs(pcRegistrations(states));
        })
        .catch(() => {
          /* worker not ready yet; the toggle stays off */
        });
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [supported]);

  const change = useCallback(
    (next: boolean) => {
      if (busy) return;
      setBusy(true);
      setNote('');
      void (async () => {
        const registration = await navigator.serviceWorker.ready;
        if (!next) {
          const subscription = await registration.pushManager.getSubscription();
          // Null on a relay that predates relay-owned push: the legacy path.
          const relayKey = subscription ? await relayWebPushKey() : null;
          if (subscription) {
            // Server first: a browser-side unsubscribe that outlives a failed
            // call would leave a PC pushing at a dead endpoint for days.
            if (relayKey) await unregisterRelayPushSubscription(subscription.endpoint);
            else await api.removePushSubscription?.(subscription.endpoint).catch(() => false);
            await subscription.unsubscribe().catch(() => false);
          }
          setEnabled(false);
          setPcs(null);
          return;
        }
        // Must run inside the click: iOS only grants permission on a gesture.
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          setEnabled(false);
          setNote(permission === 'denied' ? BLOCKED_NOTE : 'Notification permission was dismissed.');
          return;
        }
        // One subscription with the relay's key, registered for every paired
        // PC that delivers through the relay with that PC's own credential;
        // until any does, the connected PC's own key (legacy).
        const state = await statePushSubscription(api, registration.pushManager, true);
        if (!state.subscription) throw new Error('no subscription');
        setPcs(state.mode === 'relay' ? pcRegistrations(state.hosts) : null);
        setEnabled(true);
      })()
        .catch(() => {
          setEnabled(false);
          setNote('Could not turn notifications on. Check the connection to your desktop and try again.');
        })
        .finally(() => setBusy(false));
    },
    [api, busy]
  );

  if (!supported) return null;
  return (
    <Group
      title={t('Notifications')}
      description={t('Get a notification on this device when a task finishes, even while the app is closed.')}
    >
      <ToggleRow
        title={t('Notify me when a task finishes')}
        checked={enabled}
        disabled={busy}
        optimistic={false}
        onChange={change}
      />
      {enabled && <RegisteredPcs pcs={pcs} />}
      {note && <p className="settings-connection-note">{t(note)}</p>}
    </Group>
  );
}
