import { browserPageTransition } from './browser-page-recovery';

/** Geometry churn is expected; a display that stops making progress is not.
 * Keep real transport/capture failures visible without flashing on one miss. */
export function createBrowserDisplayHealth() {
  let since: number | undefined;
  let geometry = '';
  return {
    recovered() {
      since = undefined;
      geometry = '';
    },
    failed(error: unknown, now: number, nextGeometry: string): string {
      const transition = browserPageTransition(error, 'capture');
      if (since === undefined || (transition && geometry !== nextGeometry)) since = now;
      geometry = nextGeometry;
      if (now - since < (transition ? 10_000 : 2500)) return '';
      if (transition) return 'Browser display did not recover after the page changed.';
      return error instanceof Error ? error.message : String(error);
    },
  };
}
