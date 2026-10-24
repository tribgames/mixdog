// The guided LibreOffice install started from a failed Office preview. It lives
// at module level so leaving the pane mid-install neither cancels it nor loses
// its outcome: a pane opened later reads the same state, and every pane that is
// open when the install succeeds retries its own preview.
import { useSyncExternalStore } from 'react';
import { readDesktopStatus, storeDesktopStatus, subscribeDesktopStatus } from './settings/desktop-status-cache';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';

export interface OfficeInstallState {
  phase: 'idle' | 'installing' | 'failed';
  error: string;
}

let state: OfficeInstallState = { phase: 'idle', error: '' };
let running: Promise<void> | null = null;
const changeListeners = new Set<() => void>();
const installedListeners = new Set<() => void>();

function publish(next: OfficeInstallState): void {
  state = next;
  for (const listener of [...changeListeners]) listener();
}

// LibreOffice newly recorded as installed — by this pane, by Settings, or by a
// fresh status read: a stale failure is dropped and every open pane retries.
function officeInstalled(): void {
  publish({ phase: 'idle', error: '' });
  for (const listener of [...installedListeners]) listener();
}

subscribeDesktopStatus((key, value, previous) => {
  if (key !== 'libreOffice' || !(value as { installed?: boolean }).installed) return;
  if ((previous as { installed?: boolean } | undefined)?.installed) return;
  officeInstalled();
});

const REFRESH_THROTTLE_MS = 3000;
let lastRefreshAt = Number.NEGATIVE_INFINITY;

/** Re-reads the Office engine status (an install done outside Mixdog records no
 *  change by itself). A newly installed engine reaches the open failed previews
 *  through the cache subscription above. Throttled: activation and window focus
 *  can fire back to back. */
export function refreshOfficeAvailability(api: typeof window.mixdogDesktop): void {
  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_THROTTLE_MS) return;
  lastRefreshAt = now;
  void readDesktopStatus(api, 'libreOffice', true)?.catch(() => undefined);
}

/** Runs the existing guided install once; a second click while it runs joins it. */
export function installOfficeForPreview(api: typeof window.mixdogDesktop): Promise<void> {
  if (running) return running;
  const install = api?.installLibreOffice;
  if (!install) return Promise.resolve();
  publish({ phase: 'installing', error: '' });
  running = (async () => {
    try {
      const dependency = await install.call(api);
      if (!dependency?.installed) throw new Error(t('LibreOffice installation did not complete.'));
      // Records the status; the cache subscription below clears the state and
      // tells the open panes, the same as an install done from Settings.
      storeDesktopStatus(api, 'libreOffice', dependency);
      // A cache that already said "installed" records no change.
      if (state.phase === 'installing') officeInstalled();
    } catch (reason) {
      publish({ phase: 'failed', error: errorMessageText(reason) });
    } finally {
      running = null;
    }
  })();
  return running;
}

export function subscribeOfficeInstalled(listener: () => void): () => void {
  installedListeners.add(listener);
  return () => {
    installedListeners.delete(listener);
  };
}

function subscribe(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

export function useOfficeInstall(): OfficeInstallState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Forgets the outcome of an earlier install (tests). */
export function resetOfficeInstall(): void {
  running = null;
  lastRefreshAt = Number.NEGATIVE_INFINITY;
  state = { phase: 'idle', error: '' };
}
