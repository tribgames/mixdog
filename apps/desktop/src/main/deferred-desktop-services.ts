import type { BrowserWindow } from 'electron';

type TimerHandle = ReturnType<typeof setTimeout>;

export interface DeferredDesktopServiceScheduleOptions {
  awaitServiceReady(): Promise<void>;
  start(): void | Promise<void>;
  quietMs?: number;
  onReady?: () => void;
  onCancelled?: () => void;
  onError?: (error: unknown) => void;
  setTimer?: (task: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}

/**
 * Starts non-critical Desktop services only after the daemon handshake and a
 * quiet input window. The BrowserWindow's WebContents reference is captured
 * while live because Electron's getter throws after window destruction.
 */
export function scheduleDeferredDesktopServices(
  window: BrowserWindow,
  options: DeferredDesktopServiceScheduleOptions,
): () => void {
  const webContents = window.webContents;
  const quietMs = Math.max(0, options.quietMs ?? 2_000);
  const setTimer = options.setTimer ?? ((task, delayMs) => setTimeout(task, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  let timer: TimerHandle | null = null;
  let serviceReady = false;
  let started = false;
  let cancelled = false;

  const clearQuietTimer = () => {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  };
  const removeInputListener = () => {
    if (!webContents.isDestroyed()) {
      webContents.removeListener('before-input-event', postpone);
    }
  };
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    clearQuietTimer();
    removeInputListener();
    if (!started) options.onCancelled?.();
  };
  const start = () => {
    timer = null;
    if (cancelled || started || window.isDestroyed() || webContents.isDestroyed()) {
      cancel();
      return;
    }
    started = true;
    removeInputListener();
    void Promise.resolve()
      .then(options.start)
      .catch((error) => options.onError?.(error));
  };
  const scheduleQuiet = () => {
    clearQuietTimer();
    timer = setTimer(start, quietMs);
    timer.unref?.();
  };
  function postpone() {
    if (serviceReady && !started && !cancelled) scheduleQuiet();
  }

  webContents.on('before-input-event', postpone);
  window.once('closed', cancel);
  void Promise.resolve()
    .then(options.awaitServiceReady)
    .then(() => {
      if (cancelled || window.isDestroyed() || webContents.isDestroyed()) {
        cancel();
        return;
      }
      serviceReady = true;
      options.onReady?.();
      scheduleQuiet();
    })
    .catch((error) => {
      options.onError?.(error);
      cancel();
    });
  return cancel;
}
