import { useCallback, useEffect, useState } from 'react';

import type { DesktopApi, DesktopRemoteAccessSettings } from '../../shared/contract';

type RemoteAccessSettingsApi = Partial<Pick<DesktopApi, 'getRemoteAccessSettings' | 'subscribeRemoteAccessSettings'>>;

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
    if (!api?.getRemoteAccessSettings) return undefined;
    let live = true;
    void api
      .getRemoteAccessSettings()
      .then((next) => live && setSettings(next))
      .catch(() => undefined)
      .finally(() => live && setSettled(true));
    const unsubscribe = api.subscribeRemoteAccessSettings?.((next) => live && setSettings(next));
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [api, setSettings]);
  return [settings, setSettings, settled];
}
