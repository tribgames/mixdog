// Composer notices are transient helpers (mic errors, etc.): auto-dismiss
// after a beat instead of pinning to the composer forever (user-flagged).
import { useCallback, useEffect, useRef, useState } from 'react';

export function useComposerNotice() {
  const [notice, setNotice] = useState('');
  const timer = useRef(0);
  const showNotice = useCallback((message: string, durationMs = 6_000) => {
    window.clearTimeout(timer.current);
    setNotice(message);
    if (message) timer.current = window.setTimeout(() => setNotice(''), durationMs);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const clearNotice = useCallback(() => setNotice(''), []);
  return { notice, showNotice, clearNotice };
}
