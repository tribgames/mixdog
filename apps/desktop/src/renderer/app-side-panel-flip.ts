import { useLayoutEffect, useRef } from 'react';
import { syncTranscriptWidths } from './transcript-list-resize-patch';

export function useSidePanelOpenFlip(overlayDrawer = false) {
  const mainPanel = useRef<HTMLElement | null>(null);
  const collapsed = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const shell = mainPanel.current?.closest('.app-shell');
    if (!shell) return;
    const next = shell.classList.contains('sidebar-collapsed');
    const previous = collapsed.current;
    collapsed.current = next;
    if (previous !== null && previous !== next && !overlayDrawer) syncTranscriptWidths();
  });
  return { mainPanel };
}
