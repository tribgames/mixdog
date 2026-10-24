// Shared by Settings › Notifications and the Connection tab's per-device
// summary: the preference state hook, the "open Notifications on this device"
// request, and the texts both pages show.
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  DesktopApi,
  NotificationDevicePreferences,
  NotificationDeviceSummary,
  NotificationPreferencesPatch,
  NotificationPreferencesState,
  NotificationScope,
} from '../../shared/contract';
import { t, uiFormatLocale } from '../i18n';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { timeFormatOptions } from '../time-format-preference';

type NotificationApi = Partial<Pick<DesktopApi, 'getNotificationPreferences' | 'setNotificationPreferences'>>;

let pendingDevice: string | null = null;

/** Settings › Connection → Notifications with this device selected. */
export function requestNotificationDevice(deviceId: string): void {
  pendingDevice = deviceId;
}

/** The waiting device request, once. */
export function takeNotificationDeviceRequest(): string | null {
  const id = pendingDevice;
  pendingDevice = null;
  return id;
}

export function applyPreferencesPatch(
  prefs: NotificationDevicePreferences,
  patch: NotificationPreferencesPatch
): NotificationDevicePreferences {
  return {
    ...prefs,
    ...patch,
    events: { ...prefs.events, ...patch.events },
    quietHours: { ...prefs.quietHours, ...patch.quietHours },
  } as NotificationDevicePreferences;
}

interface PendingWrite {
  deviceId: string;
  patch: NotificationPreferencesPatch;
}

function withPatch(
  state: NotificationPreferencesState,
  { deviceId, patch }: PendingWrite
): NotificationPreferencesState {
  const prefs = state.preferences[deviceId];
  if (!prefs) return state;
  return { ...state, preferences: { ...state.preferences, [deviceId]: applyPreferencesPatch(prefs, patch) } };
}

/** The state, re-read on every settings change, and an optimistic writer.
 *  Writes run one after the other; what is shown is the last confirmed state
 *  with the writes still waiting applied on top, so a failed write drops only
 *  its own change. A read that started before a write began or finished is
 *  older than that write and is discarded. */
export function useNotificationPreferences(api: NotificationApi | undefined) {
  const [state, setState] = useState<NotificationPreferencesState | null>(null);
  const confirmed = useRef<NotificationPreferencesState | null>(null);
  const pending = useRef<PendingWrite[]>([]);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const writeEpoch = useRef(0);
  // A read that arrived during a write is dropped; it is redone once the queue drains.
  const discardedRead = useRef(false);
  const rereadRef = useRef<() => void>(() => {});
  const show = useCallback(() => {
    setState(confirmed.current && pending.current.reduce(withPatch, confirmed.current));
  }, []);
  useEffect(() => {
    if (!api?.getNotificationPreferences) return undefined;
    let live = true;
    const read = () => {
      const epoch = writeEpoch.current;
      void api
        .getNotificationPreferences?.()
        .then((next) => {
          if (!live) return;
          if (epoch !== writeEpoch.current || pending.current.length > 0) {
            if (pending.current.length === 0) read();
            else discardedRead.current = true;
            return;
          }
          confirmed.current = next;
          show();
        })
        .catch(() => {});
    };
    rereadRef.current = read;
    read();
    const unsubscribe = subscribeSetupChanges(read);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [api, show]);
  const save = useCallback(
    (deviceId: string, patch: NotificationPreferencesPatch) => {
      const write: PendingWrite = { deviceId, patch };
      pending.current = [...pending.current, write];
      writeEpoch.current += 1;
      show();
      chain.current = chain.current.then(async () => {
        try {
          const next = await api?.setNotificationPreferences?.(deviceId, patch);
          if (next) confirmed.current = next;
        } catch {
          /* only this write's change is dropped */
        }
        pending.current = pending.current.filter((entry) => entry !== write);
        writeEpoch.current += 1;
        show();
        if (pending.current.length === 0 && discardedRead.current) {
          discardedRead.current = false;
          rereadRef.current();
        }
      });
    },
    [api, show]
  );
  return { state, save };
}

export const scopeLabel = (scope: NotificationScope): string =>
  scope === 'all' ? t('All conversations') : scope === 'bots' ? t('Bot chats only') : t('Off');

/** 'HH:MM' in the UI language's clock (or the chosen time format). */
export function quietTimeLabel(value: string): string {
  const [hours, minutes] = value.split(':').map(Number);
  return new Date(2000, 0, 1, hours || 0, minutes || 0).toLocaleTimeString(uiFormatLocale(), {
    hour: 'numeric',
    minute: '2-digit',
    ...timeFormatOptions(),
  });
}

/** The Connection tab's line for one device; muted ones are not links. */
export function notificationSummary(
  device: NotificationDeviceSummary,
  prefs: NotificationDevicePreferences | undefined
): { text: string; muted: boolean } | null {
  if (!device.canNotify) return { text: t('Notifications off — allow them on this device'), muted: true };
  if (!prefs) return null;
  const quiet = prefs.quietHours;
  const base = t('Notifications: {{scope}}', { scope: scopeLabel(prefs.scope) });
  const text = quiet.enabled
    ? `${base} · ${t('Quiet {{start}}–{{end}}', { start: quietTimeLabel(quiet.start), end: quietTimeLabel(quiet.end) })}`
    : base;
  return { text, muted: false };
}
