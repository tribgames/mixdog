import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from './i18n';
import { bindScrollProgress } from './scroll-progress';
import {
  publishSessionRailSlot,
  SESSION_RAIL_DEFAULT_WIDTH,
  SESSION_RAIL_GAP,
  SESSION_RAIL_MAX_WIDTH,
  SESSION_RAIL_MIN_WIDTH,
  setSessionRailWidth,
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

/** The session panel in a pane cell, a band at its right edge from the pane's
 *  top, beside the tab strip and the conversation's reading column or over
 *  the conversation (sessionRailFit), with its resize edge and the body slot
 *  the pane's conversation draws its categories into from the top; over the
 *  whole pane, the conversation's whole width under the tab strip, with no
 *  edge to resize. It has no title row of its own: the tab strip's end holds
 *  its toggle (pane-dock-toggles.tsx), in every presentation. */
export function SessionRailCard({
  leafId,
  sessionId,
  draftId = '',
  width,
  reserve,
  presentation = 'beside',
  onFocusPane,
}: {
  leafId: string;
  /** The session the pane shows: only its conversation draws here. */
  sessionId: string;
  /** The New Task draft the pane shows instead: only its conversation draws here. */
  draftId?: string;
  width: number;
  /** The width the conversation re-centres left of; 0 while its right margin holds the panel. */
  reserve: number;
  presentation?: PaneSidePresentation;
  /** Present while the pane is not the focused one: a press in the panel selects it, as a press in the dock does. */
  onFocusPane?: () => void;
}) {
  const root = useRef<HTMLElement | null>(null);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    publishSessionRailSlot(leafId, { element: body, sessionId, draftId });
  }, [leafId, body, sessionId, draftId]);
  useLayoutEffect(() => () => publishSessionRailSlot(leafId, null), [leafId]);
  // The column's position, for its edge fades (session-rail.css).
  useEffect(() => (body ? bindScrollProgress(body) : undefined), [body]);
  const beside = presentation === 'beside';
  const full = presentation === 'full';
  // What the conversation gives up on its right (spent in session-rail.css); nothing while the panel floats over it.
  useLayoutEffect(() => {
    const cell = root.current?.parentElement;
    if (!cell) return undefined;
    cell.style.setProperty('--session-rail-reserve', `${beside ? reserve : 0}px`);
    // While the margin holds the panel, the scroller ends at the panel's edge instead.
    cell.style.setProperty('--session-rail-over', `${beside && reserve === 0 ? width + SESSION_RAIL_GAP : 0}px`);
    // The panel's whole width: the tab strip ends at its edge, its toggle beside the panel; over the whole pane the
    // panel stands under the strip.
    cell.style.setProperty('--session-rail-band', `${full ? 0 : width + SESSION_RAIL_GAP}px`);
    return () => {
      cell.style.removeProperty('--session-rail-reserve');
      cell.style.removeProperty('--session-rail-over');
      cell.style.removeProperty('--session-rail-band');
    };
  }, [reserve, width, beside, full]);
  // Over the whole pane the conversation under it is out of reach: no Tab stop, no typing into a hidden composer.
  useLayoutEffect(() => {
    const stack = full ? root.current?.parentElement?.querySelector<HTMLElement>(':scope > .pane-surface-stack') : null;
    if (!stack) return undefined;
    stack.inert = true;
    return () => {
      stack.inert = false;
    };
  }, [full]);
  // The edge's drag sets the one width every pane's panel takes; a cancel
  // puts back the width chosen before it, not this pane's fitted one.
  const dragRailWidth = usePanelWidthDrag({
    dockPref: useSessionRailWidth(),
    setDockPref: (next) => setSessionRailWidth(next, false),
    storageKey: SESSION_RAIL_WIDTH_KEY,
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
