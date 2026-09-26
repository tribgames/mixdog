// Installed before the async app imports. Worker notifications are retained
// until React subscribes, and a version query repairs notifications sent even
// before this module was evaluated.
export const SHELL_UPDATE_MESSAGE = 'mixdog:shell-updated';
const SHELL_CHECK_MESSAGE = 'mixdog:shell-check';
const SHELL_REFRESH_MESSAGE = 'mixdog:shell-refresh';
/** At most one release probe per foreground return in this window. */
export const SHELL_REFRESH_INTERVAL_MS = 60_000;
let lastRefreshAt = -Infinity;
let pending = false;
let bootFailed = false;
let installed = false;
let updateVersion = '';
const listeners = new Set<() => void>();

function currentVersion(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="mixdog-shell-version"]')?.content ?? '';
}

function recoverBoot(): void {
  if (!bootFailed || !pending || !updateVersion) return;
  // A broken deployment must not create an automatic reload loop.
  const key = 'mixdog.shell-recovery-version';
  try {
    if (window.sessionStorage.getItem(key) === updateVersion) return;
    window.sessionStorage.setItem(key, updateVersion);
  } catch {
    return;
  }
  window.location.reload();
}

export function checkShellUpdate(): void {
  const controller = navigator.serviceWorker?.controller;
  controller?.postMessage({ type: SHELL_CHECK_MESSAGE, version: currentVersion() });
}

export function installShellUpdateState(): void {
  if (installed || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  installed = true;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown; version?: unknown } | null;
    if (data?.type !== SHELL_UPDATE_MESSAGE) return;
    if (typeof data.version === 'string' && data.version && data.version === currentVersion()) return;
    updateVersion = typeof data.version === 'string' ? data.version : '';
    pending = true;
    for (const listener of [...listeners]) listener();
    recoverBoot();
  });
  navigator.serviceWorker.addEventListener('controllerchange', checkShellUpdate);
  checkShellUpdate();
  // An installed app kept open is never navigated, so the worker never
  // re-fetched its document and a deploy never reached it. Returning to the
  // foreground refreshes the worker script and asks for the current release.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - lastRefreshAt < SHELL_REFRESH_INTERVAL_MS) return;
    lastRefreshAt = now;
    void refreshShellRelease();
  });
}

async function refreshShellRelease(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  } catch {
    /* offline: the controller below may still answer */
  }
  navigator.serviceWorker.controller?.postMessage({ type: SHELL_REFRESH_MESSAGE });
}

export function subscribeShellUpdate(listener: () => void): () => void {
  installShellUpdateState();
  listeners.add(listener);
  if (pending) listener();
  checkShellUpdate();
  return () => {
    listeners.delete(listener);
  };
}

export function recoverShellBootstrap(): void {
  bootFailed = true;
  installShellUpdateState();
  checkShellUpdate();
  recoverBoot();
}
