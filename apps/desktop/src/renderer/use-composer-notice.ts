// Composer notices (slash confirmations, mic errors, hints) ride the app's
// toast lane instead of a banner stacked above the input. A newer notice
// replaces this composer's previous one; an empty message just clears it.
import { useCallback, useEffect, useRef } from 'react';
import { dismissDesktopToast, showDesktopToast } from './desktop-toasts';

type ComposerNoticeTone = 'info' | 'error';

export function useComposerNotice() {
  const current = useRef<string | undefined>(undefined);
  const clearNotice = useCallback(() => {
    dismissDesktopToast(current.current);
    current.current = undefined;
  }, []);
  const showNotice = useCallback(
    (message: string, tone: ComposerNoticeTone = 'info') => {
      clearNotice();
      if (message) current.current = showDesktopToast(message, tone, { scope: 'composer' });
    },
    [clearNotice]
  );
  useEffect(() => clearNotice, [clearNotice]);
  return { showNotice, clearNotice };
}
