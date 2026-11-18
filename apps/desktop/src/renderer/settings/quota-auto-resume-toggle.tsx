// Settings → Providers: whether a session stopped by an exhausted provider
// quota resumes by itself when the quota resets.
import { useRef, useState } from 'react';

import type { DesktopApi } from '../../shared/contract';
import { t } from '../i18n';
import { Group, ToggleRow } from './capability-controls';
import { writeDesktopStatus } from './desktop-status-cache';
import { useDesktopStatus } from './use-desktop-status';

const desktopApi = () => (window as unknown as { mixdogDesktop?: Partial<DesktopApi> }).mixdogDesktop;

export function QuotaAutoResumeToggle() {
  const api = desktopApi();
  // Hidden only while unknown; a late or failed first read is corrected by the next settings announcement.
  const enabled = useDesktopStatus(api, 'quotaAutoResume');
  const latestWrite = useRef(0);
  const [failed, setFailed] = useState(false);
  if (enabled === null || !api?.setQuotaAutoResume) return null;
  return (
    <Group
      title={t('Usage limits')}
      description={t(
        'What happens when every connected account is used up. Applies only to subscription accounts with a known reset time.'
      )}
    >
      <ToggleRow
        title={t('Resume automatically when the limit resets')}
        checked={enabled}
        optimistic={false}
        onChange={(next) => {
          const write = ++latestWrite.current;
          setFailed(false);
          // The choice shows while the write is in flight; a failed write leaves the confirmed value.
          const report = (saved: boolean | undefined) => {
            if (write === latestWrite.current) setFailed(saved !== next);
          };
          void writeDesktopStatus(api, 'quotaAutoResume', () => api.setQuotaAutoResume?.(next), next).then(
            report,
            () => report(undefined)
          );
        }}
      />
      {failed && (
        <p className="settings-error" role="alert">
          {t('Could not save the auto-resume setting. Try again.')}
        </p>
      )}
    </Group>
  );
}
