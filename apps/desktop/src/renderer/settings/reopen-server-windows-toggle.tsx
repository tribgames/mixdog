// Settings → Connection (this PC's window): reopen the server windows that
// were open at quit when the app starts. On by default.
import { useEffect, useState } from 'react';

import type { DesktopApi } from '../../shared/contract';
import { t } from '../i18n';
import { ToggleRow } from './capability-controls';

export function ReopenServerWindowsToggle({ api }: { api: Partial<DesktopApi> }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void api
      .getReopenServerWindows?.()
      .then((value) => live && setEnabled(value))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api]);
  if (enabled === null || !api.setReopenServerWindows) return null;
  return (
    <ToggleRow
      title={t('Reopen server windows when the app starts')}
      checked={enabled}
      onChange={(next) => {
        setEnabled(next);
        void api
          .setReopenServerWindows?.(next)
          .then((saved) => setEnabled(saved))
          .catch(() => setEnabled(!next));
      }}
    />
  );
}
