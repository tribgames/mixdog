import { useEffect, useRef } from 'react';
import { subscribeDrawerDismiss } from '../drawer-intent';
import { useStableEvent } from '../use-stable-event';

interface SettingsModuleLoad {
  peek(): unknown;
  load(): Promise<unknown>;
}

/** "Open Settings" taps against a settings module that may still be loading.
 *  Loaded (or nothing to wait for): the open runs at once. Otherwise one
 *  request waits for the module, however many taps arrive (the newest tap's
 *  destination wins), and runs when it settles, a failed import included. It
 *  is dropped when the user moves on first: the drawer is asked to close (at
 *  that request, not at the later commit of the closed state), Settings opens
 *  by another route, or `cancel` reports another navigation. */
export function useSettingsOpenRequest({
  module,
  waits,
  settingsOpen,
}: {
  module: SettingsModuleLoad;
  /** False when there is no module to wait for. */
  waits(): boolean;
  settingsOpen: boolean;
}) {
  const pending = useRef<{ open(): void } | null>(null);
  const cancel = useStableEvent(() => {
    pending.current = null;
  });
  useEffect(() => {
    if (settingsOpen) pending.current = null;
  }, [settingsOpen]);
  useEffect(() => {
    const stop = subscribeDrawerDismiss(cancel);
    return () => {
      stop();
      pending.current = null;
    };
  }, [cancel]);
  const request = useStableEvent((open: () => void) => {
    if (module.peek() || !waits()) {
      pending.current = null;
      open();
      return;
    }
    if (pending.current) {
      pending.current.open = open;
      return;
    }
    const entry = { open };
    pending.current = entry;
    const settle = () => {
      if (pending.current !== entry) return;
      pending.current = null;
      entry.open();
    };
    module.load().then(settle, settle);
  });
  return { request, cancel };
}
