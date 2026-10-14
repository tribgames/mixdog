/**
 * Follows the primary display's scale factor and refreshes page surfaces when
 * it changes; returns the function that stops following.
 */
import type { Screen } from 'electron';

export function followBrowserDisplayScale(
  screen: Pick<Screen, 'getPrimaryDisplay' | 'on' | 'removeListener'>,
  refreshScale: () => void,
  onDiagnostic?: (event: string, data: Record<string, unknown>) => void
): () => void {
  let primaryScale = screen.getPrimaryDisplay().scaleFactor;
  let refreshFailureReported = false;
  const follow = () => {
    const scale = screen.getPrimaryDisplay().scaleFactor;
    if (scale === primaryScale) return;
    primaryScale = scale;
    try {
      refreshScale();
    } catch (error) {
      // A screen event must not become an uncaught main-process exception;
      // report the first failure through diagnostics.
      if (refreshFailureReported) return;
      refreshFailureReported = true;
      onDiagnostic?.('browser-scale-refresh-failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  screen.on('display-metrics-changed', follow);
  screen.on('display-added', follow);
  screen.on('display-removed', follow);
  return () => {
    screen.removeListener('display-metrics-changed', follow);
    screen.removeListener('display-added', follow);
    screen.removeListener('display-removed', follow);
  };
}
