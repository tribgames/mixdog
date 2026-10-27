// Settings › Notifications state: the preference hook and its labels.
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  DesktopApi,
  NotificationDevicePreferences,
  NotificationPreferencesPatch,
  NotificationPreferencesState,
  NotificationScope,
} from '../../shared/contract';
import { t, uiFormatLocale } from '../i18n';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { timeFormatOptions } from '../time-format-preference';

type NotificationApi = Partial<Pick<DesktopApi, 'getNotificationPreferences' | 'setNotificationPreferences'>>;

function applyPreferencesPatch(
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
  // The last failed read / write (null once one succeeds); the panel shows them.
  const [readError, setReadError] = useState<unknown>(null);
  const [writeError, setWriteError] = useState<unknown>(null);
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
          setReadError(null);
          show();
        })
        .catch((error: unknown) => {
          if (live) setReadError(error);
        });
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
          setWriteError(null);
        } catch (error) {
          // Only this write's change is dropped (it leaves `pending` below); the failure is exposed.
          setWriteError(error);
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
  const retry = useCallback(() => rereadRef.current(), []);
  return { state, save, readError, writeError, retry };
}

export function scopeLabel(scope: NotificationScope): string {
  if (scope === 'all') return t('All conversations');
  if (scope === 'bots') return t('Bot chats only');
  return t('Off');
}

/** 'HH:MM' in the UI language's clock (or the chosen time format). */
export function quietTimeLabel(value: string): string {
  const [hours, minutes] = value.split(':').map(Number);
  return new Date(2000, 0, 1, hours || 0, minutes || 0).toLocaleTimeString(uiFormatLocale(), {
    hour: 'numeric',
    minute: '2-digit',
    ...timeFormatOptions(),
  });
}
