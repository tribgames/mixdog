import { useLayoutEffect, useRef, useState } from 'react';
import { t } from './i18n';
import {
  publishSessionRailSlot,
  SESSION_RAIL_DEFAULT_WIDTH,
  SESSION_RAIL_MAX_WIDTH,
  SESSION_RAIL_MIN_WIDTH,
  setSessionRailWidth,
  useSessionRailWidth,
} from './session-rail-layout';
import { SESSION_RAIL_WIDTH_KEY } from './pane-side-dock-model';
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

/** The session panel's column in a pane cell: the margin right of the
 *  conversation's reading column, with its resize edge and the body slot the
 *  pane's conversation draws its cards into. It has no frame or title row of
 *  its own. */
export function SessionRailCard({
  leafId,
  sessionId,
  width,
  onFocusPane,
}: {
  leafId: string;
  /** The session the pane shows: only its conversation draws here. */
  sessionId: string;
  width: number;
  /** Present while the pane is not the focused one: a press in the panel selects it, as a press in the dock does. */
  onFocusPane?: () => void;
}) {
  const root = useRef<HTMLElement | null>(null);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    publishSessionRailSlot(leafId, { element: body, sessionId });
  }, [leafId, body, sessionId]);
  useLayoutEffect(() => () => publishSessionRailSlot(leafId, null), [leafId]);
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
      style={{ width }}
      onPointerDownCapture={(event) => {
        if (event.button === 0) onFocusPane?.();
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable, draggable resize handle, not a thematic break; <hr> brings its own border and margins. */}
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
      <div ref={setBody} className="session-rail-body" />
    </aside>
  );
}
