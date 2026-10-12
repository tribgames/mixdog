// Settings → Providers: whether a session stopped by an exhausted provider
// quota resumes by itself when the quota resets.
import { useEffect, useState } from 'react';

import type { DesktopApi } from '../../shared/contract';
import { t } from '../i18n';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { Group, ToggleRow } from './capability-controls';
import { getCachedDesktopStatus, readDesktopStatus, storeDesktopStatus } from './desktop-status-cache';

const desktopApi = () => (window as unknown as { mixdogDesktop?: Partial<DesktopApi> }).mixdogDesktop;

export function QuotaAutoResumeToggle() {
  const api = desktopApi();
  const [enabled, setEnabled] = useState<boolean | null>(() => getCachedDesktopStatus(api, 'quotaAutoResume') ?? null);
  useEffect(() => {
    let live = true;
    const read = () =>
      void readDesktopStatus(desktopApi(), 'quotaAutoResume')
        ?.then((value) => live && setEnabled(value))
        .catch(() => {});
    read();
    const unsubscribe = subscribeSetupChanges(read);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
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
        onChange={(next) => {
          setEnabled(next);
          void api
            .setQuotaAutoResume?.(next)
            .then((saved) => storeDesktopStatus(api, 'quotaAutoResume', saved))
            .catch(() => setEnabled(!next));
        }}
      />
    </Group>
  );
}
