// Settings → Connection (this PC's window): reopen the server windows that
// were open at quit when the app starts. On by default.
import { useEffect, useState } from 'react';

import { getReopenServerWindows, setReopenServerWindows } from '../connections-core-api';
import { t } from '../i18n';
import { ToggleRow } from './capability-controls';

export function ReopenServerWindowsToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void getReopenServerWindows()
      .then((value) => live && setEnabled(value))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (enabled === null) return null;
  return (
    <ToggleRow
      title={t('Reopen server windows when the app starts')}
      checked={enabled}
      onChange={(next) => {
        setEnabled(next);
        void setReopenServerWindows(next)
          .then((saved) => setEnabled(saved))
          .catch(() => setEnabled(!next));
      }}
    />
  );
}
