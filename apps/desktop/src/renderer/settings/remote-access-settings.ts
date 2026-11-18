import { useCallback, useEffect, useState } from 'react';

import type { DesktopApi, DesktopRemoteAccessSettings } from '../../shared/contract';
import { startSettingsReadRecovery } from './read-recovery';

type RemoteAccessSettingsApi = Partial<
  Pick<DesktopApi, 'getRemoteAccessSettings' | 'getRemoteConnectionState' | 'subscribeRemoteAccessSettings'>
>;

// The last answer per host API: reopening a page paints it at once instead of
// waiting for the host again.
const lastKnownSettings = new WeakMap<object, DesktopRemoteAccessSettings>();

/** "Use this PC from other devices" and this PC's name, kept current. Null
 *  until the host answers (or when it has no such setting); `settled` turns
 *  true once the first answer or failure is in. */
export function useRemoteAccessSettings(
  api: RemoteAccessSettingsApi | undefined
): [DesktopRemoteAccessSettings | null, (next: DesktopRemoteAccessSettings) => void, boolean] {
  const [settings, setSettingsState] = useState<DesktopRemoteAccessSettings | null>(
    () => (api && lastKnownSettings.get(api)) || null
  );
  const [settled, setSettled] = useState(false);
  const setSettings = useCallback(
    (next: DesktopRemoteAccessSettings) => {
      if (api) lastKnownSettings.set(api, next);
      setSettingsState(next);
    },
    [api]
  );
  useEffect(() => {
    const read = api?.getRemoteAccessSettings;
    if (!read) return undefined;
    let live = true;
    let revision = 0;
    const reread = async (signal?: AbortSignal) => {
      const stamp = revision;
      try {
        const next = await read();
        if (live && !signal?.aborted && stamp === revision && next) setSettings(next);
      } finally {
        if (live && !signal?.aborted) setSettled(true);
      }
    };
    // The main Connection read already recovers settings on cores with a full state lane.
    const recovery = api?.getRemoteConnectionState ? undefined : startSettingsReadRecovery(reread, 10_000, true, true);
    if (!recovery) void reread().catch(() => undefined);
    const unsubscribe = api?.subscribeRemoteAccessSettings?.((next) => {
      if (!live || !next) return;
      revision += 1;
      setSettings(next);
    });
    return () => {
      live = false;
      recovery?.stop();
      unsubscribe?.();
    };
  }, [api, setSettings]);
  return [settings, setSettings, settled];
}
