import { useEffect, useRef, useState } from 'react';
import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';

/** Replay the latest open once the deferred host has mounted. A failed import
 *  reports its error without taking down the surrounding surface. */
export function useDeferredOpen<Handle>(load: () => Promise<unknown>, active = true) {
  const ref = useRef<Handle>(null);
  const [requested, setRequested] = useState<{ open(handle: Handle): void } | null>(null);
  useEffect(() => {
    if (!requested) return;
    if (!active) setRequested(null);
    else if (ref.current) {
      requested.open(ref.current);
      setRequested(null);
    }
  });
  const request = (open: (handle: Handle) => void) => {
    if (!active) return;
    if (ref.current) {
      open(ref.current);
      return;
    }
    setRequested({ open });
    load().catch((error: unknown) => {
      setRequested(null);
      showDesktopToast(errorMessageText(error), 'error');
    });
  };
  return { ref, request };
}
