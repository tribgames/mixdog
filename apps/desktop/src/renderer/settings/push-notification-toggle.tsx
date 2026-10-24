// Settings → Notifications → On this device: the registration that lets THIS
// device hear about a notification while the app is closed (the web app's push
// switch, the phone app's OS permission status). The Electron window has the
// taskbar flash instead and never renders this — the shim is what supplies the
// push API, so its absence hides the switch with no surface check. The
// "Connect to another PC" window is Electron too, running the shim: it has no
// push service at all, so it never offers the switch either.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import type { DesktopApi } from '../../shared/contract';
import { nativeAppInfo } from '../../shared/native-app';
import { remoteWindowInfo } from '../../shared/remote-window';
import { t } from '../i18n';
import {
  PushEnableError,
  relayPushHostStates,
  relayWebPushKey,
  removePushSubscription,
  statePushSubscription,
  type PushHostState,
} from '../push-notification-bridge';
import {
  nativePushPermission,
  openNativeNotificationSettings,
  subscribeNativePushPermission,
  syncNativePush,
} from '../native-push-bridge';
import { readSavedPcs } from '../remote-saved-pcs';
import { ActionButton, ToggleRow } from './capability-controls';

type PushApi = Partial<DesktopApi>;

// A browser cannot open its own site settings, so the way there is spelled out.
const blockedNote = (): string =>
  t(
    "Notifications are blocked for this site. In your browser's site settings (the icon beside the address bar, or Settings → Site settings → Notifications), allow notifications for this site, then turn this on again."
  );

/** The note for a failed turn-on, by what actually failed. */
export function pushEnableFailureNote(error: unknown): string {
  switch (error instanceof PushEnableError ? error.reason : null) {
    case 'push-service':
      return t('This browser has no push service, so it cannot notify you while the app is closed.');
    case 'blocked':
      return blockedNote();
    case 'outdated':
      return t('Update Mixdog on this PC to get its notifications on this device.');
    case 'unreachable':
      return t('Could not turn notifications on. Check the connection to your desktop and try again.');
    default:
      return t('Could not turn notifications on. Try again.');
  }
}

/** Paired PCs by saved name: those delivering to this browser through the
 *  relay, and those too old to (they keep no subscription here until
 *  updated). Null on the legacy path, where only the connected PC delivers. */
interface PcRegistrations {
  registered: string[];
  outdated: string[];
  /** Deliver through the relay but do not hold this subscription yet. */
  pending: string[];
}

/** How long an incomplete registration waits before it is stated again. */
const REGISTRATION_RETRY_MS = 15000;

function pcNames(deviceIds: readonly string[]): string[] {
  const saved = readSavedPcs();
  return deviceIds.map((id) => saved.find((pc) => pc.deviceId === id.toLowerCase())?.name || t('PC'));
}

function pcRegistrations(states: readonly PushHostState[]): PcRegistrations | null {
  if (!states.some((state) => state.supported === true)) return null;
  return {
    registered: pcNames(states.filter((state) => state.registered).map((state) => state.deviceId)),
    outdated: pcNames(states.filter((state) => state.supported === false).map((state) => state.deviceId)),
    pending: pcNames(states.filter((state) => state.supported === true && !state.registered).map((s) => s.deviceId)),
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
      {pcs.pending.length > 0 && (
        <p className="settings-connection-note">
          {t('Still connecting these PCs to notifications: {{names}}', { names: pcs.pending.join(', ') })}
        </p>
      )}
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

export function pushSupported(api: PushApi): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    !remoteWindowInfo() &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof api.pushPublicKey === 'function'
  );
}

/** Why a web app that should offer the switch cannot, when the user can do
 *  something about it. Null where the switch is simply not this surface's
 *  (the desktop window, the "Connect to another PC" window, the phone app,
 *  whose shell owns its notifications) or where nothing can be done.
 *  'install': iOS Safari only exposes Web Push to a Home Screen install.
 *  `navigator.standalone` is defined on iOS Safari alone (false in a tab, true
 *  when installed), which is why this is not a user-agent test; no other
 *  property tells an iPhone tab from a browser that lacks push.
 *  'secure': Web Push needs https. */
export function pushUnavailableReason(api: PushApi): 'install' | 'secure' | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return null;
  if (typeof api.pushPublicKey !== 'function' || remoteWindowInfo() || nativeAppInfo()) return null;
  if (pushSupported(api)) return null;
  if (!window.isSecureContext) return 'secure';
  if ((navigator as { standalone?: boolean }).standalone === false) return 'install';
  return null;
}

const unavailableNote = (reason: 'install' | 'secure'): string =>
  reason === 'install'
    ? t(
        'To get notifications on iPhone or iPad, add Mixdog to your Home Screen from the Share menu, then open it from there.'
      )
    : t('Notifications need a secure (https) connection to your desktop.');

/** The phone app's notifications belong to the OS: show where they stand and,
 *  when denied, the way to the system setting that can change it. */
function NativePushStatus() {
  const permission = useSyncExternalStore(subscribeNativePushPermission, nativePushPermission);
  useEffect(() => {
    void syncNativePush();
  }, []);
  if (permission !== 'granted' && permission !== 'denied') return null;
  return (
    <>
      <p className="settings-connection-note">
        {permission === 'granted'
          ? t('Notifications are on for this app.')
          : t("Notifications are turned off for this app in your phone's settings.")}
      </p>
      {permission === 'denied' && (
        <ActionButton onClick={() => void openNativeNotificationSettings()}>{t('Open settings')}</ActionButton>
      )}
    </>
  );
}

/** The rows that let THIS device receive notifications (Settings › Notifications › On this device). */
export function DevicePushRegistration({ api }: { api: PushApi }) {
  return nativeAppInfo()?.call ? <NativePushStatus /> : <WebPushToggle api={api} />;
}

function WebPushToggle({ api }: { api: PushApi }) {
  const supported = pushSupported(api);
  const unavailable = supported ? null : pushUnavailableReason(api);
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
          // Blocked says so even with nothing subscribed; once allowed again
          // (changed in browser settings, outside the app) the note goes.
          if (permission === 'denied') setNote(blockedNote());
          else setNote((shown) => (shown === blockedNote() ? '' : shown));
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

  // PCs that did not take the registration are asked again until they do.
  const [retries, setRetries] = useState(0);
  const pending = enabled && (pcs?.pending.length ?? 0) > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `retries` re-arms the timer after an attempt that left a PC pending.
  useEffect(() => {
    if (!supported || !pending) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      void navigator.serviceWorker.ready
        .then((registration) => statePushSubscription(api, registration.pushManager, false))
        .then((state) => {
          if (live) setPcs(state.mode === 'relay' ? pcRegistrations(state.hosts) : null);
        })
        .catch(() => undefined)
        .finally(() => {
          if (live) setRetries((count) => count + 1);
        });
    }, REGISTRATION_RETRY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [supported, pending, api, retries]);

  const change = useCallback(
    (next: boolean) => {
      if (busy) return;
      setBusy(true);
      setNote('');
      const turnOff = async (): Promise<void> => {
        const registration = await navigator.serviceWorker.ready;
        await removePushSubscription(api, registration.pushManager);
        setEnabled(false);
        setPcs(null);
      };
      const turnOn = async (): Promise<void> => {
        // Must be the first thing the click does: iOS only grants permission
        // on a gesture, and waiting on the worker first could outlive it.
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          setEnabled(false);
          setNote(permission === 'denied' ? blockedNote() : t('Notification permission was dismissed.'));
          return;
        }
        const registration = await navigator.serviceWorker.ready;
        // One subscription with the relay's key, registered for every paired
        // PC that delivers through the relay with that PC's own credential;
        // until any does, the connected PC's own key (legacy).
        const state = await statePushSubscription(api, registration.pushManager, true);
        if (!state.subscription) throw new Error('no subscription');
        // A subscription no PC holds notifies nobody: not turned on.
        if (!state.confirmed) throw new PushEnableError('unreachable');
        setPcs(state.mode === 'relay' ? pcRegistrations(state.hosts) : null);
        setEnabled(true);
      };
      void (next ? turnOn() : turnOff())
        .catch((error: unknown) => {
          if (next) {
            setEnabled(false);
            setNote(pushEnableFailureNote(error));
          } else {
            setNote(t('Could not turn notifications off. Check the connection to your desktop and try again.'));
            // Show what the browser really holds, not what was asked for.
            void navigator.serviceWorker.ready
              .then((registration) => registration.pushManager.getSubscription())
              .then((subscription) => setEnabled(Boolean(subscription) && Notification.permission === 'granted'))
              .catch(() => undefined);
          }
        })
        .finally(() => setBusy(false));
    },
    [api, busy]
  );

  if (unavailable) return <p className="settings-connection-note">{unavailableNote(unavailable)}</p>;
  if (!supported) return null;
  return (
    <>
      <ToggleRow
        title={t('Allow notifications on this device')}
        checked={enabled}
        disabled={busy}
        optimistic={false}
        onChange={change}
      />
      {enabled && <RegisteredPcs pcs={pcs} />}
      {note && <p className="settings-connection-note">{note}</p>}
    </>
  );
}
