// Installed before the async app imports. Worker notifications are retained
// until React subscribes, and a version query repairs notifications sent even
// before this module was evaluated.
export const SHELL_UPDATE_MESSAGE = "mixdog:shell-updated";
const SHELL_CHECK_MESSAGE = "mixdog:shell-check";
let pending = false;
let bootFailed = false;
let installed = false;
let updateVersion = "";
const listeners = new Set<() => void>();

function currentVersion(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="mixdog-shell-version"]')?.content ?? "";
}

function recoverBoot(): void {
  if (!bootFailed || !pending || !updateVersion) return;
  // A broken deployment must not create an automatic reload loop.
  const key = "mixdog.shell-recovery-version";
  try {
    if (window.sessionStorage.getItem(key) === updateVersion) return;
    window.sessionStorage.setItem(key, updateVersion);
  } catch { return; }
  window.location.reload();
}

export function checkShellUpdate(): void {
  const controller = navigator.serviceWorker?.controller;
  controller?.postMessage({ type: SHELL_CHECK_MESSAGE, version: currentVersion() });
}

export function installShellUpdateState(): void {
  if (installed || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  installed = true;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown; version?: unknown } | null;
    if (data?.type !== SHELL_UPDATE_MESSAGE) return;
    if (typeof data.version === "string" && data.version && data.version === currentVersion()) return;
    updateVersion = typeof data.version === "string" ? data.version : "";
    pending = true;
    for (const listener of [...listeners]) listener();
    recoverBoot();
  });
  navigator.serviceWorker.addEventListener("controllerchange", checkShellUpdate);
  checkShellUpdate();
}

export function subscribeShellUpdate(listener: () => void): () => void {
  installShellUpdateState();
  listeners.add(listener);
  if (pending) listener();
  checkShellUpdate();
  return () => { listeners.delete(listener); };
}

export function recoverShellBootstrap(): void {
  bootFailed = true;
  installShellUpdateState();
  checkShellUpdate();
  recoverBoot();
}
