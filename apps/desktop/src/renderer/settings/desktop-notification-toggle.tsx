// Settings → General, desktop window only: the OS notification the desktop
// shows when a session gives its final answer while the window is not focused.
// The web app has its own per-device Web Push switch instead
// (push-notification-toggle.tsx), so this hides outside Electron.
import { useEffect, useState } from 'react';

import type { DesktopApi } from '../../shared/contract';
import { t } from '../i18n';
import { isRemoteBrowserRenderer } from '../remote-ui-projection';
import { Group, ToggleRow } from './capability-controls';

export function DesktopNotificationToggle() {
  const api = isRemoteBrowserRenderer()
    ? undefined
    : (window as unknown as { mixdogDesktop?: Partial<DesktopApi> }).mixdogDesktop;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void api
      ?.readSettings?.()
      .then((settings) => {
        if (live) setEnabled(settings.turnNotifications !== false);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);
  if (enabled === null || !api?.updateSetting) return null;
  return (
    <Group
      title={t('Notifications')}
      description={t(
        'Get a notification on this computer when a task finishes while the Mixdog window is not in focus.'
      )}
    >
      <ToggleRow
        title={t('Notify me when a task finishes')}
        checked={enabled}
        onChange={(next) => {
          setEnabled(next);
          void api.updateSetting?.('turnNotifications', next).catch(() => setEnabled(!next));
        }}
      />
    </Group>
  );
}
