import { useEffect, useRef } from 'react';
import { useStableEvent } from './use-stable-event';

export interface OpenRequestModule {
  peek(): unknown;
  load(): Promise<unknown>;
}

/** Opens of a view whose module may still be loading, gated on that module so
 *  the view opens with its content instead of an empty frame. Loaded (or
 *  nothing to wait for): the open runs at once. Otherwise one request waits for
 *  the module, however many arrive (the newest one's open wins), and runs when
 *  the import settles, a failed import included (the view then reports it).
 *  It is dropped when the user moves on first: `subscribeDismiss` reports a
 *  dismissal (said at the request to close, before the closed state commits),
 *  `opened` turns true (opened by another route), `cancel` reports another
 *  navigation, or the owner unmounts. */
export function useModuleOpenRequest({
  module,
  waits,
  opened = false,
  subscribeDismiss,
}: {
  module: OpenRequestModule;
  /** False when there is no module to wait for. */
  waits(): boolean;
  opened?: boolean;
  subscribeDismiss?(listener: () => void): () => void;
}) {
  const pending = useRef<{ open(): void } | null>(null);
  const cancel = useStableEvent(() => {
    pending.current = null;
  });
  useEffect(() => {
    if (opened) pending.current = null;
  }, [opened]);
  useEffect(() => {
    const stop = subscribeDismiss?.(cancel);
    return () => {
      stop?.();
      pending.current = null;
    };
  }, [cancel, subscribeDismiss]);
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
