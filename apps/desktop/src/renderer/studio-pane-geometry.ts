import { type MutableRefObject, type RefObject, useLayoutEffect } from 'react';
import { cancelLayoutFrame, scheduleLayoutFrame } from './interaction-frame-scheduler';
import { STUDIO_GRID_MAX_WIDTH } from './studio-support';
import { STUDIO_NARROW_PANE } from './studio-pane-support';

// Tile hover chrome follows the Studio PANE width, and the composer dock
// height is published as a CSS variable for the results overlay padding.
export function useStudioPaneObserver(
  studioRootRef: RefObject<HTMLDivElement | null>,
  dockRef: RefObject<HTMLDivElement | null>,
  setNarrowPane: (narrow: boolean) => void
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs and the state setter are stable; the observer attaches once on mount
  useLayoutEffect(() => {
    const element = studioRootRef.current;
    if (!element) return undefined;
    const dock = dockRef.current;
    const apply = (width: number) => {
      if (width > 0) setNarrowPane(width <= STUDIO_NARROW_PANE);
    };
    const applyDockHeight = (height: number) => {
      if (height > 0) {
        element.style.setProperty('--studio-dock-overlay-height', `${Math.ceil(height)}px`);
      }
    };
    apply(element.getBoundingClientRect().width);
    applyDockHeight(dock?.getBoundingClientRect().height || 0);
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver((entries) => {
      const rootEntry = entries.find((candidate) => candidate.target === element);
      if (rootEntry) apply(rootEntry.contentRect.width || element.getBoundingClientRect().width);
      const dockEntry = entries.find((candidate) => candidate.target === dock);
      if (dockEntry) applyDockHeight(dockEntry.contentRect.height);
    });
    observer.observe(element);
    if (dock) observer.observe(dock);
    return () => {
      observer.disconnect();
      element.style.removeProperty('--studio-dock-overlay-height');
    };
  }, []);
}

// Track the real grid width so rows stay flush when the window resizes.
// Layout effect: measuring after paint made the first frame use the 800px
// fallback and then jump.
export function useStudioGridWidth(
  active: boolean,
  gridRef: RefObject<HTMLDivElement | null>,
  gridMotionFrame: MutableRefObject<number | null>,
  setGridMotionReady: (ready: boolean) => void,
  setGridWidth: (width: number) => void
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs and state setters are stable; the observer must only restart when `active` changes
  useLayoutEffect(() => {
    const element = gridRef.current;
    if (!active || !element) return undefined;
    setGridMotionReady(false);
    setGridWidth(Math.round(element.getBoundingClientRect().width) || STUDIO_GRID_MAX_WIDTH);
    if (gridMotionFrame.current !== null) window.cancelAnimationFrame(gridMotionFrame.current);
    if (typeof window.requestAnimationFrame === 'function') {
      gridMotionFrame.current = window.requestAnimationFrame(() => {
        gridMotionFrame.current = window.requestAnimationFrame(() => {
          gridMotionFrame.current = null;
          setGridMotionReady(true);
        });
      });
    } else {
      setGridMotionReady(true);
    }
    if (typeof ResizeObserver === 'undefined') return undefined;
    let pendingWidth = 0;
    const observer = new ResizeObserver((entries) => {
      pendingWidth = Math.round(entries[0]?.contentRect.width || 0);
      if (pendingWidth > 0) {
        scheduleLayoutFrame(element, () => setGridWidth(pendingWidth));
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelLayoutFrame(element);
      if (gridMotionFrame.current !== null) {
        window.cancelAnimationFrame(gridMotionFrame.current);
        gridMotionFrame.current = null;
      }
    };
  }, [active]);
}
