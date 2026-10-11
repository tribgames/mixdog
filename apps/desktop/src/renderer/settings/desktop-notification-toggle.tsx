// Settings → General, desktop window only: the OS notification the desktop
// shows when a session gives its final answer while the window is not focused.
// The web app has its own per-device Web Push switch instead
// (push-notification-toggle.tsx), so this hides outside Electron.
import { useEffect, useRef, useState } from 'react';

import { type DesktopApi, NOTIFICATION_VOLUME_MAX } from '../../shared/contract';
import { t } from '../i18n';
import { isRemoteHostRenderer } from '../remote-ui-projection';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { ActionButton, Group, ToggleRow } from './capability-controls';
import { getCachedDesktopStatus, readDesktopStatus, storeDesktopStatus } from './desktop-status-cache';

export function DesktopNotificationToggle() {
  const api = isRemoteHostRenderer()
    ? undefined
    : (window as unknown as { mixdogDesktop?: Partial<DesktopApi> }).mixdogDesktop;
  const cached = getCachedDesktopStatus(api, 'settings');
  const [enabled, setEnabled] = useState<boolean | null>(() => (cached ? cached.turnNotifications !== false : null));
  const [volume, setVolume] = useState<number | null>(() => (cached ? cached.notificationVolume : null));
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The volume only shapes the Windows notification sound Mixdog plays itself.
  const volumeSupported = Boolean(api?.setNotificationVolume) && navigator.userAgent.includes('Windows');
  useEffect(() => {
    let live = true;
    const read = () =>
      void readDesktopStatus(api, 'settings')
        ?.then((settings) => {
          if (!live) return;
          setEnabled(settings.turnNotifications !== false);
          if (!saveTimer.current) setVolume(settings.notificationVolume);
        })
        .catch(() => {});
    read();
    const unsubscribe = subscribeSetupChanges(read);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [api]);
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    []
  );
  const saveVolume = (next: number) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    return api?.setNotificationVolume?.(next).then((saved) => storeDesktopStatus(api, 'settings', saved));
  };
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
          void api
            .updateSetting?.('turnNotifications', next)
            .then((saved) => storeDesktopStatus(api, 'settings', saved))
            .catch(() => setEnabled(!next));
        }}
      />
      {volumeSupported && volume !== null && (
        <div className="mixdog-settings__row">
          <div className="mixdog-settings__copy">
            <span className="mixdog-settings__row-title">{t('Notification volume')}</span>
          </div>
          <div className="settings-row-control notification-volume-control">
            <input
              type="range"
              min={0}
              max={NOTIFICATION_VOLUME_MAX}
              step={10}
              value={volume}
              disabled={!enabled}
              aria-label={t('Notification volume')}
              onChange={(event) => {
                const next = Number(event.currentTarget.value);
                setVolume(next);
                if (saveTimer.current) clearTimeout(saveTimer.current);
                saveTimer.current = setTimeout(() => void saveVolume(next)?.catch(() => {}), 300);
              }}
            />
            <output>{`${volume}%`}</output>
            <ActionButton
              disabled={!enabled}
              onClick={() =>
                void Promise.resolve(saveVolume(volume))
                  .then(() => api.previewNotificationSound?.())
                  .catch(() => {})
              }
            >
              {t('Play test sound')}
            </ActionButton>
          </div>
        </div>
      )}
    </Group>
  );
}
