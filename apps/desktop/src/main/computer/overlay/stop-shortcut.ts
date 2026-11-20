import { globalShortcut } from 'electron';

import { watchGnomeStopSignal, usesGnomeHelper } from '../host/gnome-helper';

const STOP_SHORTCUT = 'CommandOrControl+Alt+Escape';

/** The emergency Stop chord. Another process may own it, so `ensure` retries on every render until it is ours. */
export function createStopShortcut(onStop: () => void, isDisposed: () => boolean) {
  let registered = false;
  let unavailable = false;
  let stopWatcher: (() => void) | null = null;
  return {
    /** True while the chord could not be taken: the pill says so. */
    unavailable: (): boolean => unavailable,
    ensure(): void {
      if (registered || isDisposed()) return;
      // Electron cannot register global shortcuts on Wayland; on GNOME the shell
      // extension owns the chord and reports it over D-Bus.
      if (usesGnomeHelper()) {
        stopWatcher ??= watchGnomeStopSignal(onStop);
        return;
      }
      registered = globalShortcut.register(STOP_SHORTCUT, onStop);
      if (registered) unavailable = false;
      else if (!unavailable) {
        // The pill's Stop control still works, but the documented emergency exit
        // does not: the pill says so (once per state change), besides the log.
        unavailable = true;
        console.warn('[computer-overlay] stop_shortcut_unavailable', STOP_SHORTCUT);
      }
    },
    dispose(): void {
      if (registered) globalShortcut.unregister(STOP_SHORTCUT);
      stopWatcher?.();
      stopWatcher = null;
    },
  };
}
