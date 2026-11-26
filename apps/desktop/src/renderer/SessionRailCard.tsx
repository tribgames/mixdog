import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from './i18n';
import { bindScrollProgress } from './scroll-progress';
import {
  publishSessionRailSlot,
  SESSION_RAIL_DEFAULT_WIDTH,
  SESSION_RAIL_GAP,
  SESSION_RAIL_MAX_WIDTH,
  SESSION_RAIL_MIN_WIDTH,
  sessionRailFit,
  setSessionRailWidth,
  useSessionRailSlot,
  useSessionRailWidth,
} from './session-rail-layout';
import { type PaneSidePresentation, SESSION_RAIL_WIDTH_KEY } from './pane-side-dock-model';
import { usePanelWidthDrag } from './pane-side-dock-hooks';
import { useSidePanelWidth } from './workbench-side-view-layout';
import './session-rail.css';

const WIDTH_RANGE = { min: SESSION_RAIL_MIN_WIDTH, max: SESSION_RAIL_MAX_WIDTH, initial: SESSION_RAIL_DEFAULT_WIDTH };
/** One arrow press on the resize edge, as the session sidebar's edge moves. */
const WIDTH_STEP = 16;

/** The resize edge's keys: Left widens (the panel grows leftward), Right
 *  narrows, Home and End go to the least and the most. */
export function sessionRailWidthForKey(key: string, width: number): number | null {
  if (key === 'ArrowLeft') return width + WIDTH_STEP;
  if (key === 'ArrowRight') return width - WIDTH_STEP;
  if (key === 'Home') return SESSION_RAIL_MIN_WIDTH;
  if (key === 'End') return SESSION_RAIL_MAX_WIDTH;
  return null;
}

function applyRailDom(
  aside: HTMLElement | null,
  covered: boolean,
  nextWidth: number,
  nextReserve: number,
  nextPresentation: PaneSidePresentation
): void {
  const cell = aside?.parentElement;
  if (!aside || !cell || covered) return;
  const nextBeside = nextPresentation === 'beside';
  const nextFull = nextPresentation === 'full';
  const taken = nextWidth + SESSION_RAIL_GAP;
  aside.dataset.presentation = nextPresentation;
  if (nextFull) aside.style.removeProperty('width');
  else aside.style.width = `${nextWidth}px`;
  cell.style.setProperty('--session-rail-reserve', `${nextBeside ? nextReserve : 0}px`);
  // The panel's whole width: the tab strip ends at its edge, its toggle beside the panel; over the whole pane the
  // panel stands under the strip.
  cell.style.setProperty('--session-rail-band', `${nextFull ? 0 : taken}px`);
}

/** The session panel in a pane cell, a band at its right edge from the pane's
 *  top, beside the tab strip and the conversation's reading column or over
 *  the conversation (sessionRailFit), with its resize edge and the body slot
 *  the pane's conversation draws its categories into from the top; over the
 *  whole pane, the conversation's whole width under the tab strip, with no
 *  edge to resize. It has no title row of its own: the tab strip's end holds
 *  its toggle (pane-dock-toggles.tsx), in every presentation. Covered by a
 *  dock, it is not drawn and gives the conversation nothing, but its body
 *  stays as it is until the dock closes. */
export function SessionRailCard({
  leafId,
  sessionId,
  draftId = '',
  width,
  reserve,
  presentation = 'beside',
  covered = false,
  onFocusPane,
}: {
  leafId: string;
  /** The session the pane shows: only its conversation draws here. */
  sessionId: string;
  /** The New Task draft the pane shows instead: only its conversation draws here. */
  draftId?: string;
  width: number;
  /** The width the conversation gives up on its right and re-centres left of. */
  reserve: number;
  presentation?: PaneSidePresentation;
  /** A dock open at the pane's side covers the panel (paneDockRailLayout). */
  covered?: boolean;
  /** Present while the pane is not the focused one: a press in the panel selects it, as a press in the dock does. */
  onFocusPane?: () => void;
}) {
  const root = useRef<HTMLElement | null>(null);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    publishSessionRailSlot(leafId, { element: body, sessionId, draftId, covered });
  }, [leafId, body, sessionId, draftId, covered]);
  useLayoutEffect(() => () => publishSessionRailSlot(leafId, null), [leafId]);
  // Shown again in the commit its conversation shows its rows again (it reads the same slot): a panel laid out before
  // its rows are would clamp its scroll to the empty column.
  const slotCovered = useSessionRailSlot(leafId).covered === true;
  const hidden = covered || slotCovered;
  // The column's position, for its edge fades (session-rail.css).
  useEffect(() => (body && !hidden ? bindScrollProgress(body) : undefined), [body, hidden]);
  const full = presentation === 'full';
  // What the conversation gives up on its right (spent in session-rail.css); nothing while the panel floats over it.
  useLayoutEffect(() => {
    const cell = root.current?.parentElement;
    if (!cell || covered) return undefined;
    applyRailDom(root.current, covered, width, reserve, presentation);
    return () => {
      cell.style.removeProperty('--session-rail-reserve');
      cell.style.removeProperty('--session-rail-band');
    };
  }, [reserve, width, presentation, covered]);
  // Over the whole pane the conversation under it is out of reach: no Tab stop, no typing into a hidden composer.
  const overPane = full && !covered;
  useLayoutEffect(() => {
    const stack = overPane
      ? root.current?.parentElement?.querySelector<HTMLElement>(':scope > .pane-surface-stack')
      : null;
    if (!stack) return undefined;
    stack.inert = true;
    return () => {
      stack.inert = false;
    };
  }, [overPane]);
  // Imperative DOM preview during drag keeps width subscribers from re-rendering
  // every frame; the shared store updates once on commit.
  const dragRailWidth = usePanelWidthDrag({
    dockPref: useSessionRailWidth(),
    setDockPref: (next) => setSessionRailWidth(next, false),
    storageKey: SESSION_RAIL_WIDTH_KEY,
    preview: (next) => {
      if (next === null) {
        applyRailDom(root.current, covered, width, reserve, presentation);
        return;
      }
      const cellWidth = root.current?.parentElement?.clientWidth ?? 0;
      const fitted =
        cellWidth > 0 ? sessionRailFit({ cellWidth, railPref: next }) : { width: next, reserve, presentation };
      applyRailDom(root.current, covered, fitted.width, fitted.reserve, fitted.presentation);
    },
  });
  const { resizeHandleProps } = useSidePanelWidth({
    side: 'right',
    widthRange: WIDTH_RANGE,
    widthOverride: width,
    onWidthDrag: dragRailWidth,
  });
  return (
    <aside
      ref={root}
      className="session-rail"
      aria-label={t('Session')}
      data-presentation={presentation}
      hidden={hidden || undefined}
      style={full ? undefined : { width }}
      onPointerDownCapture={(event) => {
        if (event.button === 0) onFocusPane?.();
      }}
    >
      {!full && (
        // biome-ignore lint/a11y/useSemanticElements: a focusable, draggable resize handle, not a thematic break; <hr> brings its own border and margins.
        <div
          className="workbench-side-panel-resize session-rail-resize"
          role="separator"
          tabIndex={0}
          aria-label={t('Resize session panel')}
          aria-orientation="vertical"
          aria-valuemin={SESSION_RAIL_MIN_WIDTH}
          aria-valuemax={SESSION_RAIL_MAX_WIDTH}
          aria-valuenow={width}
          aria-valuetext={t('{{width}} pixels', { width })}
          onKeyDown={(event) => {
            const next = sessionRailWidthForKey(event.key, width);
            if (next === null) return;
            event.preventDefault();
            setSessionRailWidth(next, true);
          }}
          onDoubleClick={() => setSessionRailWidth(SESSION_RAIL_DEFAULT_WIDTH, true)}
          {...resizeHandleProps}
        />
      )}
      <div ref={setBody} className="session-rail-body" />
    </aside>
  );
}
