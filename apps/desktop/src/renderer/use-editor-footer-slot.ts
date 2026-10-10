// The pane cell's footer slot: the main tab's status row portals into it.
import { useCallback, useState } from 'react';

export function useEditorFooterSlot() {
  const [footerSlot, setFooterSlot] = useState<Element | null>(null);
  const bindFooterSlot = useCallback((node: HTMLElement | null) => {
    setFooterSlot(node?.closest('.pane-cell')?.querySelector(':scope > .pane-footer-slot') ?? null);
  }, []);
  return { footerSlot, bindFooterSlot };
}
