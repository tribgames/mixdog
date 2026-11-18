// Settings → Connection (this PC's window): reopen the server windows that
// were open at quit when the app starts. On by default.
import { useRef, useState } from 'react';

import { getReopenServerWindows, setReopenServerWindows } from '../connections-core-api';
import { t } from '../i18n';
import { ToggleRow } from './capability-controls';
import { useSettingsReread } from './use-desktop-status';

export function ReopenServerWindowsToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  // Only the newest read or write lands. A failed read keeps the toggle hidden (unknown) until the next settings
  // announcement reads again.
  const newest = useRef(0);
  useSettingsReread(window.mixdogDesktop, () => {
    const mine = ++newest.current;
    void getReopenServerWindows()
      .then((value) => {
        if (mine === newest.current) setEnabled(value);
      })
      .catch(() => undefined);
  });
  if (enabled === null) return null;
  return (
    <ToggleRow
      title={t('Reopen server windows when the app starts')}
      checked={enabled}
      onChange={(next) => {
        setEnabled(next);
        newest.current += 1;
        void setReopenServerWindows(next)
          .then((saved) => setEnabled(saved))
          .catch(() => setEnabled(!next));
      }}
    />
  );
}
