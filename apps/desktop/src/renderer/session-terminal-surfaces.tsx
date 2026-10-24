/**
 * One persistent terminal root per conversation session. The root stays under
 * one parking host and is positioned over the preferred visible dock slot, so
 * duplicate session tabs never fight over the same xterm DOM.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { disposeTerminalPane } from './lazy-widgets';
import { SessionTerminalTabs } from './SessionTerminalTabs';
import { releaseSessionTerminalTabs, sessionTerminalId } from './session-terminal-tabs';
import { useSlotRemeasure } from './surface-slot-remeasure';
import {
  applySurfaceInteractivity,
  expandedSurfaceRect,
  placeFixedSurface,
  preferredSurfaceSlot,
  renderSurfaceRoot,
  unmountSurfaceRoot,
} from './surface-slots';
import { cachedShellProfiles, loadShellProfiles } from './terminal-shell-profiles';

type TerminalSurfaceSlot = {
  active: boolean;
  foreground: boolean;
  /** Its sheet slides closed: pixels kept, interaction gone (applySurfaceInteractivity). */
  exiting: boolean;
  cwd: string | null;
};

type TerminalSurface = {
  sessionId: string;
  cwd: string | null;
  /** Rendered by a warm-up (prewarm) and not opened since: its panes only
   *  attach to shells already running, never start or change one. */
  warm: boolean;
  expanded: boolean;
  /** Side dock header widened while this surface is expanded. */
  header: HTMLElement | null;
  container: HTMLDivElement;
  root: Root;
  slots: Map<HTMLDivElement, TerminalSurfaceSlot>;
};

type SessionTerminalSurfaceRenderProps = {
  sessionId: string;
  cwd: string | null;
  active: boolean;
  foreground: boolean;
  parked: boolean;
  /** Warm-up render (TerminalSurface.warm): attach-only panes. */
  attachOnly: boolean;
  expanded: boolean;
  onToggleExpanded(): void;
};

type SessionTerminalSurfaceRenderer = (props: SessionTerminalSurfaceRenderProps) => ReactNode;

export { sessionTerminalId };

type SessionTerminalSurfaceDisposer = (terminalId: string) => void;

const disposeDefaultTerminalSurface: SessionTerminalSurfaceDisposer = (terminalId) => {
  void disposeTerminalPane(terminalId);
};

interface SessionTerminalSurfaceController {
  registerSlot(
    sessionId: string,
    node: HTMLDivElement,
    active: boolean,
    foreground: boolean,
    cwd: string | null,
    exiting?: boolean
  ): void;
  unregisterSlot(sessionId: string, node: HTMLDivElement): void;
  prewarm(sessionId: string): void;
  refresh(sessionId: string): void;
  release(sessionId: string): void;
  setParkingHost(node: HTMLDivElement | null): void;
}

const renderDefaultTerminalSurface: SessionTerminalSurfaceRenderer = ({
  sessionId,
  cwd,
  active,
  attachOnly,
  expanded,
  onToggleExpanded,
}) => (
  <SessionTerminalTabs
    sessionId={sessionId}
    cwd={cwd}
    active={active}
    attachOnly={attachOnly}
    expanded={expanded}
    onToggleExpanded={onToggleExpanded}
  />
);

export function useSessionTerminalSurfaces(
  renderTerminalSurface: SessionTerminalSurfaceRenderer = renderDefaultTerminalSurface,
  disposeTerminalSurface: SessionTerminalSurfaceDisposer = disposeDefaultTerminalSurface
): SessionTerminalSurfaceController {
  const surfaces = useRef(new Map<string, TerminalSurface>());
  const parkingHost = useRef<HTMLDivElement | null>(null);

  const position = useCallback((surface: TerminalSurface): [HTMLDivElement, TerminalSurfaceSlot] | null => {
    const host = parkingHost.current;
    if (host && surface.container.parentElement !== host) {
      host.appendChild(surface.container);
    }
    const selected = preferredSurfaceSlot(surface.slots);
    const expanded = surface.expanded && selected?.[1].foreground === true;
    const rect = expandedSurfaceRect(selected?.[0], expanded, surface) ?? selected?.[0].getBoundingClientRect();
    surface.container.dataset.expanded = expanded ? 'true' : 'false';
    const visible = Boolean(selected && rect && rect.width >= 1 && rect.height >= 1);
    if (visible && rect) {
      placeFixedSurface(surface.container, rect, selected?.[0]);
      surface.container.dataset.parked = 'false';
      applySurfaceInteractivity(surface.container, selected?.[1].exiting !== true);
      return selected;
    }
    surface.expanded = false;
    applySurfaceInteractivity(surface.container, false);
    surface.container.style.left = '-10000px';
    surface.container.style.top = '0';
    // Preserve the last visible grid while parked. Browser Use intentionally
    // takes a synthetic desktop viewport, but resizing a hidden PTY would send
    // a false SIGWINCH and restore the wrong row count on return.
    surface.container.dataset.parked = 'true';
    return null;
  }, []);

  const commit = useCallback(
    (surface: TerminalSurface) => {
      const selected = position(surface);
      if (selected) surface.cwd = selected[1].cwd;
      // A closing sheet's slot keeps the terminal placed (its pixels) but not
      // active: no focus hold, no keys, no fits.
      const active = Boolean(selected) && selected?.[1].exiting !== true;
      const foreground = selected?.[1].foreground === true;
      renderSurfaceRoot(
        surface.root,
        renderTerminalSurface({
          sessionId: surface.sessionId,
          cwd: surface.cwd,
          active,
          foreground,
          parked: !selected,
          attachOnly: surface.warm,
          expanded: surface.expanded && foreground,
          onToggleExpanded: () => {
            surface.expanded = !surface.expanded;
            commit(surface);
          },
        })
      );
    },
    [position, renderTerminalSurface]
  );

  const ensure = useCallback((sessionId: string, cwd: string | null) => {
    const existing = surfaces.current.get(sessionId);
    if (existing) {
      existing.cwd = cwd;
      return existing;
    }
    const container = document.createElement('div');
    container.className = 'session-terminal-surface-container';
    container.dataset.terminalSessionId = sessionId;
    const surface: TerminalSurface = {
      sessionId,
      cwd,
      warm: false,
      expanded: false,
      header: null,
      container,
      root: createRoot(container),
      slots: new Map(),
    };
    surfaces.current.set(sessionId, surface);
    return surface;
  }, []);

  const registerSlot = useCallback(
    (
      sessionId: string,
      node: HTMLDivElement,
      active: boolean,
      foreground: boolean,
      cwd: string | null,
      exiting = false
    ) => {
      let surface = surfaces.current.get(sessionId);
      if (!surface && active) surface = ensure(sessionId, cwd);
      if (!surface) return;
      surface.slots.set(node, { active, foreground: foreground && !exiting, exiting, cwd });
      // The real open: from here its panes start or change shells as usual.
      if (active && !exiting) surface.warm = false;
      commit(surface);
    },
    [commit, ensure]
  );

  // A session's terminal root rendered parked before its dock opens (the
  // toggle's prewarm): its panes mount and draw off screen, attach-only, so
  // the opening frame only places the container. A root that already exists
  // is kept.
  const prewarm = useCallback(
    (sessionId: string) => {
      if (surfaces.current.has(sessionId)) return;
      const surface = ensure(sessionId, null);
      surface.warm = true;
      commit(surface);
    },
    [commit, ensure]
  );

  const unregisterSlot = useCallback(
    (sessionId: string, node: HTMLDivElement) => {
      const surface = surfaces.current.get(sessionId);
      if (!surface) return;
      surface.slots.delete(node);
      commit(surface);
    },
    [commit]
  );

  const refresh = useCallback(
    (sessionId: string) => {
      const surface = surfaces.current.get(sessionId);
      if (surface) commit(surface);
    },
    [commit]
  );

  const release = useCallback(
    (sessionId: string) => {
      const surface = surfaces.current.get(sessionId);
      if (!surface) return;
      expandedSurfaceRect(undefined, false, surface);
      unmountSurfaceRoot(surface.root);
      surface.container.remove();
      surfaces.current.delete(sessionId);
      for (const terminalId of releaseSessionTerminalTabs(sessionId)) disposeTerminalSurface(terminalId);
    },
    [disposeTerminalSurface]
  );

  const setParkingHost = useCallback(
    (node: HTMLDivElement | null) => {
      parkingHost.current = node;
      for (const surface of surfaces.current.values()) commit(surface);
    },
    [commit]
  );

  useEffect(
    () => () => {
      for (const surface of surfaces.current.values()) unmountSurfaceRoot(surface.root);
      surfaces.current.clear();
    },
    []
  );

  return useMemo(
    () => ({
      registerSlot,
      unregisterSlot,
      prewarm,
      refresh,
      release,
      setParkingHost,
    }),
    [prewarm, refresh, registerSlot, release, setParkingHost, unregisterSlot]
  );
}

/** After boot, once idle: the shell list (and with it the default shell's
 *  name) is detected before the first terminal opens, so its tab is named
 *  right in the frame it appears. */
const SHELL_PREFETCH_DELAY_MS = 2_000;

export function SessionTerminalParkingHost({ controller }: { controller: SessionTerminalSurfaceController }) {
  useEffect(() => {
    if (cachedShellProfiles() || !window.mixdogDesktop?.termProfiles) return undefined;
    const timer = window.setTimeout(() => void loadShellProfiles(), SHELL_PREFETCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return <div ref={controller.setParkingHost} className="session-terminal-parking-host" />;
}

export function SessionTerminalSlot({
  controller,
  sessionId,
  active,
  foreground,
  cwd,
  exiting = false,
}: {
  controller: SessionTerminalSurfaceController;
  sessionId: string;
  active: boolean;
  foreground: boolean;
  cwd: string | null;
  exiting?: boolean;
}) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = slotRef.current;
    if (!node) return undefined;
    controller.registerSlot(sessionId, node, active, foreground, cwd, exiting);
    return () => controller.unregisterSlot(sessionId, node);
  }, [active, controller, cwd, exiting, foreground, sessionId]);
  useSlotRemeasure(slotRef, active, controller, sessionId);
  return <div ref={slotRef} className="session-terminal-slot" data-terminal-session-id={sessionId} />;
}
