import { useEffect, useState } from 'react';

import type { DesktopApi, DesktopRemoteAccessSettings } from '../../shared/contract';

type RemoteAccessSettingsApi = Partial<Pick<DesktopApi, 'getRemoteAccessSettings' | 'subscribeRemoteAccessSettings'>>;

/** "Use this PC from other devices" and this PC's name, kept current. Null
 *  until the host answers (or when it has no such setting). */
export function useRemoteAccessSettings(api: RemoteAccessSettingsApi | undefined): [DesktopRemoteAccessSettings | null, (next: DesktopRemoteAccessSettings) => void] {
  const [settings, setSettings] = useState<DesktopRemoteAccessSettings | null>(null);
  useEffect(() => {
    if (!api?.getRemoteAccessSettings) return undefined;
    let live = true;
    void api
      .getRemoteAccessSettings()
      .then((next) => live && setSettings(next))
      .catch(() => undefined);
    const unsubscribe = api.subscribeRemoteAccessSettings?.((next) => live && setSettings(next));
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [api]);
  return [settings, setSettings];
}

