/**
 * One persistent BrowserPane root per conversation session. The root's DOM
 * container stays under one host for its whole lifetime. Visible surfaces are
 * positioned over their dock slot; parked surfaces move offscreen without
 * reparenting the Electron webview or destroying the agent's live page.
 */
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";

import { BrowserPane } from "./lazy-widgets";

type BrowserSurfaceSlot = {
  active: boolean;
  foreground: boolean;
};

type BrowserSurface = {
  sessionId: string;
  container: HTMLDivElement;
  root: Root;
  slots: Map<HTMLDivElement, BrowserSurfaceSlot>;
};

export type SessionBrowserSurfaceRenderProps = {
  sessionId: string;
  active: boolean;
  foreground: boolean;
  parked: boolean;
};

export type SessionBrowserSurfaceRenderer = (
  props: SessionBrowserSurfaceRenderProps,
) => ReactNode;

export interface SessionBrowserSurfaceController {
  ensure(sessionId: string): void;
  registerSlot(
    sessionId: string,
    node: HTMLDivElement,
    active: boolean,
    foreground: boolean,
  ): void;
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

function preferredSlot(surface: BrowserSurface): [HTMLDivElement, BrowserSurfaceSlot] | null {
  const active = [...surface.slots].filter(([, slot]) => slot.active);
  return active.find(([, slot]) => slot.foreground) ?? active[0] ?? null;
}

const renderDefaultBrowserSurface: SessionBrowserSurfaceRenderer = (props) =>
  <Suspense fallback={null}>
    <BrowserPane
      {...props}
      focusAddressOnActivate={false}
    />
  </Suspense>;

export function useSessionBrowserSurfaces(
  renderBrowserSurface: SessionBrowserSurfaceRenderer = renderDefaultBrowserSurface,
): SessionBrowserSurfaceController {
  const surfaces = useRef(new Map<string, BrowserSurface>());
  const parkingHost = useRef<HTMLDivElement | null>(null);
  const remoteViewers = useRef(new Set<string>());

  const position = useCallback((
    surface: BrowserSurface,
  ): [HTMLDivElement, BrowserSurfaceSlot] | null => {
    const host = parkingHost.current;
    if (host && surface.container.parentElement !== host) {
      host.appendChild(surface.container);
    }
    const selected = preferredSlot(surface);
    const rect = selected?.[0].getBoundingClientRect();
    const visible = Boolean(selected && rect && rect.width >= 1 && rect.height >= 1);
    if (visible && rect) {
      surface.container.style.left = `${rect.left}px`;
      surface.container.style.top = `${rect.top}px`;
      surface.container.style.width = `${rect.width}px`;
      surface.container.style.height = `${rect.height}px`;
      surface.container.dataset.parked = "false";
      surface.container.removeAttribute("aria-hidden");
      return selected;
    }
    const remoteViewed = remoteViewers.current.has(surface.sessionId);
    surface.container.style.left = remoteViewed ? "0" : "-10000px";
    surface.container.style.top = "0";
    surface.container.style.width = `${remoteViewed
      ? Math.min(REMOTE_VIEWED_PARK.width, window.innerWidth)
      : REMOTE_VIEWED_PARK.width}px`;
    surface.container.style.height = `${remoteViewed
      ? Math.min(REMOTE_VIEWED_PARK.height, window.innerHeight)
      : REMOTE_VIEWED_PARK.height}px`;
    surface.container.dataset.parked = "true";
    surface.container.dataset.remoteViewed = remoteViewed ? "true" : "false";
    surface.container.setAttribute("aria-hidden", "true");
    return null;
  }, []);

  const commit = useCallback((surface: BrowserSurface) => {
    const selected = position(surface);
    const active = Boolean(selected);
    const foreground = selected?.[1].foreground === true;
    surface.root.render(renderBrowserSurface({
      sessionId: surface.sessionId,
      active,
      foreground,
      parked: !active,
    }));
  }, [position, renderBrowserSurface]);

  const ensure = useCallback((sessionId: string) => {
    if (surfaces.current.has(sessionId)) return;
    const container = document.createElement("div");
    container.className = "session-browser-surface-container";
    container.dataset.browserSessionId = sessionId;
    const surface: BrowserSurface = {
      sessionId,
      container,
      root: createRoot(container),
      slots: new Map(),
    };
    surfaces.current.set(sessionId, surface);
    commit(surface);
  }, [commit]);

  const registerSlot = useCallback((
    sessionId: string,
    node: HTMLDivElement,
    active: boolean,
    foreground: boolean,
  ) => {
    let surface = surfaces.current.get(sessionId);
    if (!surface && active) {
      ensure(sessionId);
      surface = surfaces.current.get(sessionId);
    }
    if (!surface) return;
    surface.slots.set(node, { active, foreground });
    commit(surface);
  }, [commit, ensure]);

  const unregisterSlot = useCallback((sessionId: string, node: HTMLDivElement) => {
    const surface = surfaces.current.get(sessionId);
    if (!surface) return;
    surface.slots.delete(node);
    commit(surface);
  }, [commit]);

  const refresh = useCallback((sessionId: string) => {
    const surface = surfaces.current.get(sessionId);
    if (surface) commit(surface);
  }, [commit]);

  const release = useCallback((sessionId: string) => {
    const surface = surfaces.current.get(sessionId);
    if (!surface) return;
    surface.root.unmount();
    surface.container.remove();
    surfaces.current.delete(sessionId);
  }, []);

  const setRemoteViewed = useCallback((sessionId: string, viewed: boolean) => {
    const changed = viewed
      ? !remoteViewers.current.has(sessionId)
      : remoteViewers.current.delete(sessionId);
    if (viewed) remoteViewers.current.add(sessionId);
    if (!changed) return;
    const surface = surfaces.current.get(sessionId);
    if (surface) commit(surface);
  }, [commit]);

  const setParkingHost = useCallback((node: HTMLDivElement | null) => {
    parkingHost.current = node;
    for (const surface of surfaces.current.values()) commit(surface);
  }, [commit]);

  useEffect(() => () => {
    for (const surface of surfaces.current.values()) surface.root.unmount();
    surfaces.current.clear();
  }, []);

  return useMemo(() => ({
    ensure,
    registerSlot,
    unregisterSlot,
    refresh,
    release,
    setParkingHost,
    setRemoteViewed,
  }), [ensure, refresh, registerSlot, release, setParkingHost, setRemoteViewed, unregisterSlot]);
}

export function SessionBrowserParkingHost({
  controller,
}: {
  controller: SessionBrowserSurfaceController;
}) {
  return <div
    ref={controller.setParkingHost}
    className="session-browser-parking-host"
  />;
}

export function SessionBrowserSlot({
  controller,
  sessionId,
  active,
  foreground,
}: {
  controller: SessionBrowserSurfaceController;
  sessionId: string;
  active: boolean;
  foreground: boolean;
}) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = slotRef.current;
    if (!node) return undefined;
    controller.registerSlot(sessionId, node, active, foreground);
    return () => controller.unregisterSlot(sessionId, node);
  }, [active, controller, foreground, sessionId]);
  useLayoutEffect(() => {
    const node = slotRef.current;
    if (!node || !active) return undefined;
    let frame = 0;
    const refresh = () => controller.refresh(sessionId);
    const schedule = () => {
      if (typeof window.requestAnimationFrame !== "function") {
        refresh();
        return;
      }
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        refresh();
      });
    };
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(schedule)
      : null;
    observer?.observe(node);
    window.addEventListener("resize", schedule);
    // The phone dock SLIDES in: only the slot's position changes during the
    // transform, so a mid-slide rect would pin the guest off-screen. Any
    // finished transition re-measures.
    window.addEventListener("transitionend", schedule, true);
    schedule();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("transitionend", schedule, true);
    };
  }, [active, controller, sessionId]);
  return <div
    ref={slotRef}
    className="session-browser-slot"
    data-browser-session-id={sessionId}
  />;
}
