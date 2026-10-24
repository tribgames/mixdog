/**
 * One persistent BrowserPane root per conversation session. The root's DOM
 * container stays under one host for its whole lifetime. Visible surfaces are
 * positioned over their dock slot; parked surfaces move offscreen without
 * reparenting the Electron webview or destroying the agent's live page.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useDeferredModule } from './deferred-module';
import { browserPaneModule } from './lazy-widgets';
import { useSlotRemeasure } from './surface-slot-remeasure';
import {
  applySurfaceInteractivity,
  expandedSurfaceRect,
  placeFixedSurface,
  preferredSurfaceSlot,
  renderSurfaceRoot,
  unmountSurfaceRoot,
} from './surface-slots';
import './session-browser-surfaces.css';

type BrowserSurfaceSlot = {
  active: boolean;
  foreground: boolean;
  /** Its sheet slides closed: pixels kept, interaction gone (applySurfaceInteractivity). */
  exiting: boolean;
};

type BrowserSurface = {
  sessionId: string;
  expanded: boolean;
  /** Side dock header widened while this surface is expanded. */
  header: HTMLElement | null;
  container: HTMLDivElement;
  root: Root;
  slots: Map<HTMLDivElement, BrowserSurfaceSlot>;
};

type SessionBrowserSurfaceRenderProps = {
  sessionId: string;
  active: boolean;
  foreground: boolean;
  parked: boolean;
  expanded: boolean;
  onToggleExpanded(): void;
};

type SessionBrowserSurfaceRenderer = (props: SessionBrowserSurfaceRenderProps) => ReactNode;

interface SessionBrowserSurfaceController {
  ensure(sessionId: string): void;
  registerSlot(sessionId: string, node: HTMLDivElement, active: boolean, foreground: boolean, exiting?: boolean): void;
  unregisterSlot(sessionId: string, node: HTMLDivElement): void;
  refresh(sessionId: string): void;
  release(sessionId: string): void;
  setParkingHost(node: HTMLDivElement | null): void;
  /** A paired phone is polling this session's frames. A guest parked OFF the
   *  window composes no frames, so its capture hangs; while viewed, the
   *  parked guest stays inside the window beneath the UI instead. */
  setRemoteViewed(sessionId: string, viewed: boolean): void;
}

/** In-window parking box for a remotely viewed guest: the phone's frame is
 *  whatever the guest measures, so a desktop-shaped box keeps pages laid out
 *  the way the agent sees them. */
const REMOTE_VIEWED_PARK = { width: 1280, height: 900 };

/** Rendered synchronously once its chunk is in (lazy-widgets: browserPaneModule). */
function DefaultBrowserSurface(props: SessionBrowserSurfaceRenderProps) {
  const browserModule = useDeferredModule(browserPaneModule);
  return browserModule ? <browserModule.default {...props} focusAddressOnActivate={false} /> : null;
}

const renderDefaultBrowserSurface: SessionBrowserSurfaceRenderer = (props) => <DefaultBrowserSurface {...props} />;

export function useSessionBrowserSurfaces(
  renderBrowserSurface: SessionBrowserSurfaceRenderer = renderDefaultBrowserSurface
): SessionBrowserSurfaceController {
  const surfaces = useRef(new Map<string, BrowserSurface>());
  const parkingHost = useRef<HTMLDivElement | null>(null);
  const remoteViewers = useRef(new Set<string>());

  const position = useCallback((surface: BrowserSurface): [HTMLDivElement, BrowserSurfaceSlot] | null => {
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
    const remoteViewed = remoteViewers.current.has(surface.sessionId);
    surface.container.style.left = remoteViewed ? '0' : '-10000px';
    surface.container.style.top = '0';
    surface.container.style.width = `${
      remoteViewed ? Math.min(REMOTE_VIEWED_PARK.width, window.innerWidth) : REMOTE_VIEWED_PARK.width
    }px`;
    surface.container.style.height = `${
      remoteViewed ? Math.min(REMOTE_VIEWED_PARK.height, window.innerHeight) : REMOTE_VIEWED_PARK.height
    }px`;
    surface.container.dataset.parked = 'true';
    surface.container.dataset.remoteViewed = remoteViewed ? 'true' : 'false';
    return null;
  }, []);

  const commit = useCallback(
    (surface: BrowserSurface): void => {
      const selected = position(surface);
      // A closing sheet's slot keeps the page placed (its pixels) but not
      // active, as the terminal: not the shown guest, no zoom sync, no keys.
      const active = Boolean(selected) && selected?.[1].exiting !== true;
      const foreground = selected?.[1].foreground === true;
      renderSurfaceRoot(
        surface.root,
        renderBrowserSurface({
          sessionId: surface.sessionId,
          active,
          foreground,
          // Every inactive page keeps its guest laid out at full size (an
          // Electron guest stops repainting otherwise), the exiting one too.
          parked: !active,
          expanded: surface.expanded && foreground,
          onToggleExpanded: () => {
            surface.expanded = !surface.expanded;
            commit(surface);
          },
        })
      );
    },
    [position, renderBrowserSurface]
  );

  const ensure = useCallback(
    (sessionId: string) => {
      if (surfaces.current.has(sessionId)) return;
      const container = document.createElement('div');
      container.className = 'session-browser-surface-container';
      container.dataset.browserSessionId = sessionId;
      const surface: BrowserSurface = {
        sessionId,
        expanded: false,
        header: null,
        container,
        root: createRoot(container),
        slots: new Map(),
      };
      surfaces.current.set(sessionId, surface);
      commit(surface);
    },
    [commit]
  );

  const registerSlot = useCallback(
    (sessionId: string, node: HTMLDivElement, active: boolean, foreground: boolean, exiting = false) => {
      let surface = surfaces.current.get(sessionId);
      if (!surface && active) {
        ensure(sessionId);
        surface = surfaces.current.get(sessionId);
      }
      if (!surface) return;
      surface.slots.set(node, { active, foreground: foreground && !exiting, exiting });
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

  const release = useCallback((sessionId: string) => {
    const surface = surfaces.current.get(sessionId);
    if (!surface) return;
    expandedSurfaceRect(undefined, false, surface);
    queueMicrotask(() => unmountSurfaceRoot(surface.root));
    surface.container.remove();
    surfaces.current.delete(sessionId);
  }, []);

  const setRemoteViewed = useCallback(
    (sessionId: string, viewed: boolean) => {
      const changed = viewed ? !remoteViewers.current.has(sessionId) : remoteViewers.current.delete(sessionId);
      if (viewed) remoteViewers.current.add(sessionId);
      if (!changed) return;
      const surface = surfaces.current.get(sessionId);
      if (surface) commit(surface);
    },
    [commit]
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
      for (const surface of surfaces.current.values()) {
        surface.container.remove();
        queueMicrotask(() => unmountSurfaceRoot(surface.root));
      }
      surfaces.current.clear();
    },
    []
  );

  return useMemo(
    () => ({
      ensure,
      registerSlot,
      unregisterSlot,
      refresh,
      release,
      setParkingHost,
      setRemoteViewed,
    }),
    [ensure, refresh, registerSlot, release, setParkingHost, setRemoteViewed, unregisterSlot]
  );
}

export function SessionBrowserParkingHost({ controller }: { controller: SessionBrowserSurfaceController }) {
  return <div ref={controller.setParkingHost} className="session-browser-parking-host" />;
}

export function SessionBrowserSlot({
  controller,
  sessionId,
  active,
  foreground,
  exiting = false,
}: {
  controller: SessionBrowserSurfaceController;
  sessionId: string;
  active: boolean;
  foreground: boolean;
  exiting?: boolean;
}) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = slotRef.current;
    if (!node) return undefined;
    controller.registerSlot(sessionId, node, active, foreground, exiting);
    return () => controller.unregisterSlot(sessionId, node);
  }, [active, controller, exiting, foreground, sessionId]);
  useSlotRemeasure(slotRef, active, controller, sessionId, true);
  return <div ref={slotRef} className="session-browser-slot" data-browser-session-id={sessionId} />;
}
