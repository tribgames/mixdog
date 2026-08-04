import { useCallback, useRef } from "react";

export type SidePanelFlipKind = "sidebar" | "dock";

// A side-panel toggle still commits its FINAL geometry synchronously — the
// old View Transition composited old/new text snapshots (ghosting, removed
// by user decision), and a width transition re-laid the workspace out on
// every frame (user: vscode 같은 매끄러움이 아니다). Smoothness now comes
// from COMPOSITOR motion only: layout snaps once, then the opening panel
// slides into its already-reserved space via transform. The per-kind html
// class arms that slide for one settle window on OPEN; closes commit
// instantly (VS Code grammar), and drag-resize never sees any class.
export function useSidePanelOpenFlip() {
  const mainPanel = useRef<HTMLElement | null>(null);
  const settleTimers = useRef<Record<string, number>>({});
  const beginOpen = useCallback((kind: SidePanelFlipKind, commit: () => void) => {
    const root = document.documentElement;
    const cls = `mx-open-${kind}`;
    root.classList.add(cls);
    if (settleTimers.current[cls]) window.clearTimeout(settleTimers.current[cls]);
    settleTimers.current[cls] = window.setTimeout(() => {
      root.classList.remove(cls);
      settleTimers.current[cls] = 0;
    }, 240);
    commit();
  }, []);
  const beginClose = useCallback((_kind: SidePanelFlipKind, commit: () => void) => {
    commit();
  }, []);
  return { mainPanel, beginOpen, beginClose };
}
