// Composer notices (slash confirmations, mic errors, hints) ride the app's
// toast lane instead of a banner stacked above the input (user: 되도록
// 컴포저 위에 안 떴으면). A newer notice replaces this composer's previous
// one; an empty message just clears it.
import { useCallback, useEffect, useRef } from 'react';
import { dismissDesktopToast, showDesktopToast } from './desktop-toasts';

export type ComposerNoticeTone = 'info' | 'error';

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
