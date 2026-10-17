import { useCallback, useLayoutEffect, useRef } from 'react';
import { syncTranscriptWidths } from './transcript-list-resize-patch';

type SidePanelFlipKind = 'sidebar' | 'dock';

// A side-panel toggle commits its FINAL geometry in one frame — the old View
// Transition composited old/new text snapshots (ghosting, removed by user
// decision), and a width transition re-laid the workspace out on every frame
// (user: vscode 같은 매끄러움이 아니다). The layout snaps once, and the
// transcripts whose width it changed re-measure in the layout effect of that
// same commit: their rewrapped rows, positions and scroll anchor land before
// the frame paints, never a frame later through the rows' observers. The
// sidebar opens and closes from many places (rail, shortcuts, navigation), so
// the commit that flips the shell's collapsed class is detected here, after
// every commit of the host, by a class read (no layout).
export function useSidePanelOpenFlip() {
  const mainPanel = useRef<HTMLElement | null>(null);
  const collapsed = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const shell = mainPanel.current?.closest('.app-shell');
    if (!shell) return;
    const next = shell.classList.contains('sidebar-collapsed');
    const previous = collapsed.current;
    collapsed.current = next;
    if (previous !== null && previous !== next) syncTranscriptWidths();
  });
  const begin = useCallback((_kind: SidePanelFlipKind, commit: () => void) => {
    commit();
  }, []);
  return { mainPanel, beginOpen: begin, beginClose: begin };
}
