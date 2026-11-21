import { useEffect, useRef } from 'react';
import { useStableEvent } from './use-stable-event';

export interface OpenRequestModule {
  peek(): unknown;
  load(): Promise<unknown>;
}

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
