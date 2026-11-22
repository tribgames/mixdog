import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from './i18n';
import {
  markSessionRailPress,
  publishSessionRailSlot,
  SESSION_RAIL_DEFAULT_WIDTH,
  SESSION_RAIL_MAX_WIDTH,
  SESSION_RAIL_MIN_WIDTH,
  sessionRailPress,
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

/** The document body's child that holds `node`: the app's own root, or a
 *  layer appended above it (a dialog, a menu, a confirmation's own root). */
function bodyLayer(node: Node): Node {
  let layer = node;
  while (layer.parentNode && layer.parentNode !== layer.ownerDocument?.body) layer = layer.parentNode;
  return layer;
}

/** Outside the raised panel is the surface under it: a press or a key in a
 *  layer stacked above it (a confirmation, a dialog, a menu) is that layer's. */
function underPanel(target: EventTarget | null, panel: HTMLElement | null): boolean {
  if (!(target instanceof Node) || !panel) return false;
  const page = panel.ownerDocument;
  // Nothing focused (a key) or the bare page (a press) is the surface too.
  if (target === page.body || target === page.documentElement) return true;
  return bodyLayer(target) === bodyLayer(panel);
}

/** A raised panel lets go on its toggle, Escape (unless one
 *  of its own pickers is open, which Escape closes first) or a press outside. */
function useRaisedDismiss(raised: boolean, root: { current: HTMLElement | null }, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!raised) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (sessionRailPress(event) || !underPanel(event.target, root.current)) return;
      close.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      if (!underPanel(event.target, root.current)) return;
      if (root.current?.querySelector('[aria-haspopup][aria-expanded="true"]')) return;
      close.current();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [raised, root]);
}

/** The session panel's frame in a pane cell: the resize edge of a column and
 *  the body slot the pane's conversation draws into. The pane's own switch
 *  closes it; the frame has no title row. */
export function SessionRailColumn({
  leafId,
  sessionId,
  mode,
  width,
  onClose,
  onFocusPane,
}: {
  leafId: string;
  /** The session the pane shows: only its conversation draws here. */
  sessionId: string;
  mode: 'column' | 'raised';
  width: number;
  onClose(): void;
  /** Present while the pane is not the focused one: a press in the panel selects it, as a press in the dock does. */
  onFocusPane?: () => void;
}) {
  const root = useRef<HTMLElement | null>(null);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    publishSessionRailSlot(leafId, { element: body, mode, sessionId });
  }, [leafId, body, mode, sessionId]);
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
  useRaisedDismiss(mode === 'raised', root, onClose);
  return (
    <aside
      ref={root}
      className="session-rail"
      data-mode={mode}
      aria-label={t('Session')}
      style={{ width }}
      onPointerDownCapture={(event) => {
        markSessionRailPress(event.nativeEvent);
        if (event.button === 0) onFocusPane?.();
      }}
    >
      {mode === 'column' && (
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
