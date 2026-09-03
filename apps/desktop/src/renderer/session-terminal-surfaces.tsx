/**
 * One persistent terminal root per conversation session. The root stays under
 * one parking host and is positioned over the preferred visible dock slot, so
 * duplicate session tabs never fight over the same xterm DOM.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";

import { ReadyTerminalPane } from "./app-shell-components";
import { disposeTerminalPane } from "./lazy-widgets";

type TerminalSurfaceSlot = {
  active: boolean;
  foreground: boolean;
  cwd: string | null;
};

type TerminalSurface = {
  sessionId: string;
  cwd: string | null;
  container: HTMLDivElement;
  root: Root;
  slots: Map<HTMLDivElement, TerminalSurfaceSlot>;
};

export type SessionTerminalSurfaceRenderProps = {
  sessionId: string;
  cwd: string | null;
  active: boolean;
  foreground: boolean;
  parked: boolean;
};

export type SessionTerminalSurfaceRenderer = (
  props: SessionTerminalSurfaceRenderProps,
) => ReactNode;

export const sessionTerminalId = (sessionId: string): string =>
  `session-terminal:${sessionId}`;

type SessionTerminalSurfaceDisposer = (terminalId: string) => void;

const disposeDefaultTerminalSurface: SessionTerminalSurfaceDisposer = (terminalId) => {
  void disposeTerminalPane(terminalId);
};

export interface SessionTerminalSurfaceController {
  registerSlot(
    sessionId: string,
    node: HTMLDivElement,
    active: boolean,
    foreground: boolean,
    cwd: string | null,
  ): void;
  unregisterSlot(sessionId: string, node: HTMLDivElement): void;
  refresh(sessionId: string): void;
  release(sessionId: string): void;
  setParkingHost(node: HTMLDivElement | null): void;
}

const renderDefaultTerminalSurface: SessionTerminalSurfaceRenderer = ({
  sessionId,
  cwd,
  active,
}) => <ReadyTerminalPane
  cwd={cwd}
  terminalId={sessionTerminalId(sessionId)}
  active={active}
/>;

function preferredSlot(
  surface: TerminalSurface,
): [HTMLDivElement, TerminalSurfaceSlot] | null {
  const active = [...surface.slots].filter(([, slot]) => slot.active);
  return active.find(([, slot]) => slot.foreground) ?? active[0] ?? null;
}

export function useSessionTerminalSurfaces(
  renderTerminalSurface: SessionTerminalSurfaceRenderer = renderDefaultTerminalSurface,
  disposeTerminalSurface: SessionTerminalSurfaceDisposer = disposeDefaultTerminalSurface,
): SessionTerminalSurfaceController {
  const surfaces = useRef(new Map<string, TerminalSurface>());
  const parkingHost = useRef<HTMLDivElement | null>(null);

  const position = useCallback((
    surface: TerminalSurface,
  ): [HTMLDivElement, TerminalSurfaceSlot] | null => {
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
    surface.container.style.left = "-10000px";
    surface.container.style.top = "0";
    // Preserve the last visible grid while parked. Browser Use intentionally
    // takes a synthetic desktop viewport, but resizing a hidden PTY would send
    // a false SIGWINCH and restore the wrong row count on return.
    surface.container.dataset.parked = "true";
    surface.container.setAttribute("aria-hidden", "true");
    return null;
  }, []);

  const commit = useCallback((surface: TerminalSurface) => {
    const selected = position(surface);
    if (selected) surface.cwd = selected[1].cwd;
    const active = Boolean(selected);
    surface.root.render(renderTerminalSurface({
      sessionId: surface.sessionId,
      cwd: surface.cwd,
      active,
      foreground: selected?.[1].foreground === true,
      parked: !active,
    }));
  }, [position, renderTerminalSurface]);

  const ensure = useCallback((sessionId: string, cwd: string | null) => {
    const existing = surfaces.current.get(sessionId);
    if (existing) {
      existing.cwd = cwd;
      return existing;
    }
    const container = document.createElement("div");
    container.className = "session-terminal-surface-container";
    container.dataset.terminalSessionId = sessionId;
    const surface: TerminalSurface = {
      sessionId,
      cwd,
      container,
      root: createRoot(container),
      slots: new Map(),
    };
    surfaces.current.set(sessionId, surface);
    return surface;
  }, []);

  const registerSlot = useCallback((
    sessionId: string,
    node: HTMLDivElement,
    active: boolean,
    foreground: boolean,
    cwd: string | null,
  ) => {
    let surface = surfaces.current.get(sessionId);
    if (!surface && active) surface = ensure(sessionId, cwd);
    if (!surface) return;
    surface.slots.set(node, { active, foreground, cwd });
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
    disposeTerminalSurface(sessionTerminalId(sessionId));
  }, [disposeTerminalSurface]);

  const setParkingHost = useCallback((node: HTMLDivElement | null) => {
    parkingHost.current = node;
    for (const surface of surfaces.current.values()) commit(surface);
  }, [commit]);

  useEffect(() => () => {
    for (const surface of surfaces.current.values()) surface.root.unmount();
    surfaces.current.clear();
  }, []);

  return useMemo(() => ({
    registerSlot,
    unregisterSlot,
    refresh,
    release,
    setParkingHost,
  }), [refresh, registerSlot, release, setParkingHost, unregisterSlot]);
}

export function SessionTerminalParkingHost({
  controller,
}: {
  controller: SessionTerminalSurfaceController;
}) {
  return <div
    ref={controller.setParkingHost}
    className="session-terminal-parking-host"
  />;
}

export function SessionTerminalSlot({
  controller,
  sessionId,
  active,
  foreground,
  cwd,
}: {
  controller: SessionTerminalSurfaceController;
  sessionId: string;
  active: boolean;
  foreground: boolean;
  cwd: string | null;
}) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = slotRef.current;
    if (!node) return undefined;
    controller.registerSlot(sessionId, node, active, foreground, cwd);
    return () => controller.unregisterSlot(sessionId, node);
  }, [active, controller, cwd, foreground, sessionId]);
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
    // The phone dock SLIDES in: the slot's size never changes during the
    // transform, only its position, so the rect measured mid-slide would pin
    // the surface off-screen. Any finished transition re-measures.
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
    className="session-terminal-slot"
    data-terminal-session-id={sessionId}
  />;
}
