import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

// An expanded tool result mounts only the rows near its panel's viewport. The
// panel is a scroll box of capped height, so most of a long result is never on
// screen, yet mounting every row would keep it all in the DOM while the call
// stays open (34 opened calls held 3,900 rows, 21k nodes and ~90 MB).
//
// Each code of the result is cut into windows of at most TOOL_WINDOW_ROWS
// rows; section headers stay, so every file link is there to tab to. A window
// away from the viewport is one empty box: of its measured height once it has
// been shown, until then of its rows at one line each (13-tool-cards.css).
// The windows that start within the first TOOL_WINDOW_ROWS rows are always
// mounted: they are taller than the panel's cap, so the panel opens at its
// real height with its real first rows.
//
// The panel's scroll extent is therefore exact for rows that do not wrap and
// an estimate for wrapped rows not shown yet, as in every list that mounts by
// position; the rows on screen are always the real ones, in order.

/** Rows in one window. At one line each they are taller than a panel. */
export const TOOL_WINDOW_ROWS = 40;

/** How far beyond the panel's viewport, in viewports, windows stay mounted. */
const REACH_VIEWPORTS = 1;

export interface ToolPanelView {
  /** Reports, on every change, whether `element` is to be mounted: it is
   *  within reach of the panel's viewport, or a selection made in the panel
   *  reaches into it. Returns the call that ends the reports. */
  watch(element: Element, report: (near: boolean) => void): () => void;
}

export const ToolPanelViewContext = createContext<ToolPanelView | null>(null);

interface Watched {
  report: (near: boolean) => void;
  /** Within reach of the viewport, by the observer's last word. */
  reach: boolean;
  near: boolean;
}

export function createToolPanelView(body: () => Element | null): ToolPanelView {
  const watched = new Map<Element, Watched>();
  /** Windows out of reach that the selection keeps. */
  const selected = new Set<Element>();
  let observer: IntersectionObserver | null = null;

  /** The selection, when the reader made it in this panel (not a select-all of the page). A click's caret counts: a
   *  shift-click extends from it. */
  const selectionHere = () => {
    const selection = document.getSelection();
    const root = body();
    if (!selection || selection.rangeCount === 0 || !root) return null;
    return root.contains(selection.anchorNode) || root.contains(selection.focusNode) ? selection : null;
  };
  const settle = (element: Element, state: Watched, selection: Selection | null) => {
    if (!state.reach && selection?.containsNode(element, true)) selected.add(element);
    else selected.delete(element);
    const near = state.reach || selected.has(element);
    if (near === state.near) return;
    state.near = near;
    state.report(near);
  };
  // A selection takes its ends and its text from the DOM: every window it
  // reaches into is mounted while it lasts, and goes by the observer's word
  // once it ends.
  const onSelection = () => {
    const selection = selectionHere();
    if (!selection && selected.size === 0) return;
    for (const [element, state] of watched) settle(element, state, selection);
  };

  return {
    watch(element, report) {
      if (!observer) {
        observer = new IntersectionObserver(
          (entries) => {
            const selection = selectionHere();
            for (const entry of entries) {
              const state = watched.get(entry.target);
              // A panel without a box (a hidden pane) says nothing about distance.
              if (!state || !entry.rootBounds?.height) continue;
              state.reach = entry.isIntersecting;
              settle(entry.target, state, selection);
            }
          },
          { root: body(), rootMargin: `${REACH_VIEWPORTS * 100}% 0px` }
        );
        document.addEventListener('selectionchange', onSelection);
      }
      watched.set(element, { report, reach: false, near: false });
      observer.observe(element);
      return () => {
        watched.delete(element);
        selected.delete(element);
        observer?.unobserve(element);
        if (watched.size > 0) return;
        observer?.disconnect();
        observer = null;
        document.removeEventListener('selectionchange', onSelection);
      };
    },
  };
}

/** One window of a tool result's rows. `held`: it starts within the first
 *  TOOL_WINDOW_ROWS rows of its panel. */
export function ToolWindow({ rows, held, render }: { rows: number; held: boolean; render: () => ReactNode }) {
  const view = useContext(ToolPanelViewContext);
  const element = useRef<HTMLDivElement>(null);
  const measured = useRef<number | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = element.current;
    if (held || !view || !node) return;
    return view.watch(node, (next) => {
      if (!next) {
        // A window without a box (a hidden pane) keeps the height it had.
        const { height } = node.getBoundingClientRect();
        if (height > 0) measured.current = height;
      }
      setNear(next);
    });
  }, [held, view]);
  // One element either way: the panel keeps watching it.
  if (held || !view || near) {
    return (
      <div ref={element} className="tool-code-window">
        {render()}
      </div>
    );
  }
  return (
    <div
      ref={element}
      className="tool-code-window"
      data-away=""
      aria-hidden="true"
      style={measured.current === null ? ({ '--tool-away-rows': rows } as CSSProperties) : { height: measured.current }}
    />
  );
}
