// Settings → Connection, web app only: the switch that lets THIS device hear
// about a finished turn while the app is closed. The Electron window has the
// taskbar flash instead and never renders this — the shim is what supplies the
// push API, so its absence hides the group with no surface check.
import { useCallback, useEffect, useState } from 'react';

import type { DesktopApi } from '../../shared/contract';
import { t } from '../i18n';
import { Group, ToggleRow } from './capability-controls';

type PushApi = Partial<DesktopApi>;

/** The applicationServerKey travels as base64url text but subscribe() wants a
 *  BufferSource; the buffer is allocated at the exact length so passing it
 *  whole stays equivalent to the view. */
function bufferFromBase64Url(value: string): ArrayBuffer {
  const normalized = String(value || '').replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const raw = window.atob(padded);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return buffer;
}

function pushSupported(api: PushApi): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext
    && 'Notification' in window
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && typeof api.pushPublicKey === 'function';
}

export function PushNotificationToggle({ api }: { api: PushApi }) {
  const supported = pushSupported(api);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  // The browser owns the truth: a subscription can survive a reinstall of the
  // app or be cleared from browser settings without this UI ever hearing.
  useEffect(() => {
    if (!supported) return undefined;
    let live = true;
    void navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        if (live) setEnabled(Boolean(subscription));
      })
      .catch(() => { /* worker not ready yet; the toggle stays off */ });
    return () => { live = false; };
  }, [supported]);

  const change = useCallback((next: boolean) => {
    if (busy) return;
    setBusy(true);
    setNote('');
    void (async () => {
      const registration = await navigator.serviceWorker.ready;
      if (!next) {
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          // Server first: a browser-side unsubscribe that outlives a failed
          // call would leave this desktop pushing at a dead endpoint for days.
          await api.removePushSubscription?.(subscription.endpoint).catch(() => false);
          await subscription.unsubscribe().catch(() => false);
        }
        setEnabled(false);
        return;
      }
      // Must run inside the click: iOS only grants permission on a gesture.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setEnabled(false);
        setNote(permission === 'denied'
          ? 'Notifications are blocked for this app. Allow them in your browser or system settings first.'
          : 'Notification permission was dismissed.');
        return;
      }
      const publicKey = await api.pushPublicKey?.();
      if (!publicKey) throw new Error('missing key');
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bufferFromBase64Url(publicKey),
      });
      const keys = subscription.toJSON().keys ?? {};
      await api.registerPushSubscription?.({
        endpoint: subscription.endpoint,
        p256dh: String(keys.p256dh || ''),
        auth: String(keys.auth || ''),
      });
      setEnabled(true);
    })()
      .catch(() => {
        setEnabled(false);
        setNote('Could not turn notifications on. Check the connection to your desktop and try again.');
      })
      .finally(() => setBusy(false));
  }, [api, busy]);

  if (!supported) return null;
  return <Group title="Notifications"
    description="Get a notification on this device when a task finishes, even while the app is closed.">
    <ToggleRow title="Notify me when a task finishes" checked={enabled} disabled={busy}
      optimistic={false} onChange={change} />
    {note && <p className="settings-connection-note">{t(note)}</p>}
  </Group>;
}
