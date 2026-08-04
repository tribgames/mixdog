import { useCallback, useRef } from "react";

export type SidePanelFlipKind = "sidebar" | "dock";

// VS Code layout grammar (user decision): a side-panel toggle commits its
// FINAL geometry synchronously in the same frame, exactly like a workbench
// part toggle. The previous View Transition composited old/new text
// snapshots over the reflowing workspace for 180ms, which read as ghosting
// and font shimmer on every window-level layout shift.
export function useSidePanelOpenFlip() {
  const mainPanel = useRef<HTMLElement | null>(null);
  const commitNow = useCallback((_kind: SidePanelFlipKind, commit: () => void) => {
    commit();
  }, []);
  return { mainPanel, beginOpen: commitNow, beginClose: commitNow };
}
