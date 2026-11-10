/*
 * app/use-tui-ready.mjs — post-mount input gate.
 *
 * tuiReady stays false across the first render + commit. Let one event-loop
 * poll pass so Ink processes (and discards, because PromptInput is still
 * disabled) any keystrokes the OS buffered during terminal setup / initial
 * mount. After the tick, enable the input — new keystrokes land normally.
 */
import { useEffect, useState } from 'react';

export function useTuiReady() {
  const [tuiReady, setTuiReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setTuiReady(true), 0);
    return () => clearTimeout(timer);
  }, []);
  return tuiReady;
}
