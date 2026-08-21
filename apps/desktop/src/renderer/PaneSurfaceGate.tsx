import { type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { createBootSurfaceBarrier, markBootStage } from "./boot-metrics";
import { DesktopLoadingSurface } from "./RendererRecovery";
import { t } from "./i18n";

type SurfaceId = string | number;
const SURFACE_FONT_WAIT_MAX_MS = 300;
const STARTUP_SURFACE_FALLBACK_MS = 1_200;
const DESKTOP_BOOT_COVER_MAX_MS = 4_000;
const DESKTOP_BOOT_BRAND_FADE_MS = 100;

function useStartupSurfaceReady(startupDelayMs: number | undefined): boolean {
  const host = window as typeof window & { __mixdogWindowShown?: boolean };
  const [ready, setReady] = useState(
    () => startupDelayMs === undefined || host.__mixdogWindowShown === true,
  );
  useLayoutEffect(() => {
    if (ready || startupDelayMs === undefined) return undefined;
    let delayTimer = 0;
    let fallbackTimer = 0;
    let frame = 0;
    const activate = () => {
      window.removeEventListener("mixdog:window-shown", activate);
      window.clearTimeout(fallbackTimer);
      window.clearTimeout(delayTimer);
      // Electron emits mixdog:window-shown only after two visible composed
      // frames. A zero-delay gate is therefore already safe to reveal; adding
      // another RAF here only held the cold-start cover for a redundant frame.
      if ((startupDelayMs ?? 0) <= 0) {
        setReady(true);
        return;
      }
      delayTimer = window.setTimeout(() => {
        delayTimer = 0;
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          setReady(true);
        });
      }, startupDelayMs);
    };
    if (host.__mixdogWindowShown) activate();
    else {
      window.addEventListener("mixdog:window-shown", activate, { once: true });
      // Browser/LAN clients have no Electron main process to emit the event.
      fallbackTimer = window.setTimeout(activate, STARTUP_SURFACE_FALLBACK_MS);
    }
    return () => {
      window.removeEventListener("mixdog:window-shown", activate);
      window.clearTimeout(delayTimer);
      window.clearTimeout(fallbackTimer);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [host, ready, startupDelayMs]);
  return ready;
}

/** Mount a heavy surface only while it is visible. */
export function DeferredPersistentSurface({
  active,
  startupDelayMs,
  fallback = null,
  children,
}: {
  active: boolean;
  startupDelayMs?: number;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const startupReady = useStartupSurfaceReady(startupDelayMs);
  if (!active) return null;
  return startupReady ? <>{children}</> : <>{fallback}</>;
}

export function scheduleStableSurfaceCommit(commit: () => void): () => void {
  let cancelled = false;
  let frame = 0;
  let fontTimer = 0;
  const requestFrame = typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : (callback: FrameRequestCallback) => window.setTimeout(
        () => callback(typeof performance === "undefined" ? Date.now() : performance.now()),
        16,
      );
  const cancelFrame = typeof window.cancelAnimationFrame === "function"
    ? window.cancelAnimationFrame.bind(window)
    : window.clearTimeout.bind(window);
  const nextFrame = () => new Promise<void>((resolve) => {
    frame = requestFrame(() => {
      frame = 0;
      resolve();
    });
  });
  void (async () => {
    // First let the hidden incoming surface run layout and request every font
    // subset it actually uses. FontFaceSet.ready called before that frame only
    // observes the outgoing surface and still permits a late metric swap.
    await nextFrame();
    if (cancelled) return;
    try {
      const fontsReady = document.fonts?.ready;
      if (fontsReady) {
        await Promise.race([
          Promise.resolve(fontsReady).catch(() => undefined),
          new Promise<void>((resolve) => {
            fontTimer = window.setTimeout(resolve, SURFACE_FONT_WAIT_MAX_MS);
          }),
        ]);
      }
    } catch { /* font readiness remains a cosmetic guard */ }
    if (fontTimer) {
      window.clearTimeout(fontTimer);
      fontTimer = 0;
    }
    if (cancelled) return;
    // Two composed frames keep style/layout/paint from leaking into the
    // visible swap. The outgoing surface stays intact until this callback.
    await nextFrame();
    if (cancelled) return;
    await nextFrame();
    if (!cancelled) commit();
  })();
  return () => {
    cancelled = true;
    if (frame) cancelFrame(frame);
    if (fontTimer) window.clearTimeout(fontTimer);
  };
}

function useStableSurfaceReveal(
  ready: boolean,
  transitionKey: string | number = "",
): boolean {
  // Readiness is a cold-start contract, not a background-refresh state. Once
  // this exact surface key has been revealed, transient loading caused by a
  // dropdown, filter, or refresh must preserve its DOM instead of replaying a
  // full-frame cover. A genuinely different key still starts cold.
  const [reveal, setReveal] = useState(() => ({
    key: transitionKey,
    revealed: ready,
  }));
  const sameKey = Object.is(reveal.key, transitionKey);
  const revealed = sameKey ? reveal.revealed : ready;
  useLayoutEffect(() => {
    if (!sameKey) {
      setReveal({ key: transitionKey, revealed: ready });
      return undefined;
    }
    if (!ready || reveal.revealed) return undefined;
    return scheduleStableSurfaceCommit(() => setReveal((current) =>
      Object.is(current.key, transitionKey)
        ? { ...current, revealed: true }
        : current));
  }, [ready, reveal.revealed, sameKey, transitionKey]);
  return revealed;
}

/**
 * Keep the complete workbench mounted at final geometry behind one opaque
 * cover. Visible descendants register their real data/DOM readiness through
 * boot-metrics; the cover leaves once the app prerequisites and every
 * registered surface have survived composed frames.
 */
export function DesktopBootGate({
  ready,
  enabled = true,
  label = t("Starting Mixdog…"),
  children,
}: {
  ready: boolean;
  enabled?: boolean;
  label?: string;
  children: ReactNode;
}) {
  const barrierRef = useRef<ReturnType<typeof createBootSurfaceBarrier> | null>(null);
  barrierRef.current ||= createBootSurfaceBarrier();
  const barrier = barrierRef.current;
  const surfaces = useSyncExternalStore(
    barrier.subscribe,
    barrier.getSnapshot,
    barrier.getSnapshot,
  );
  const windowShown = useStartupSurfaceReady(0);
  const [armed, setArmed] = useState(!enabled);
  const [timedOut, setTimedOut] = useState(false);
  const [handoffComplete, setHandoffComplete] = useState(!enabled);
  const [coverLeaving, setCoverLeaving] = useState(false);
  const revealRequested = !enabled || timedOut
    // Surface barriers resolve after their first real paint. The opaque cover
    // can begin fading immediately; main's later two-visible-frame signal still
    // owns deferred prewarms, but no longer serializes the visual handoff.
    || (armed && ready && surfaces.pending === 0);
  // Generic surface switches wait for fonts plus three composed frames. Every
  // boot surface has already crossed the paint barrier above, and the cover
  // itself still fades out, so repeating that sequence only extends the splash.
  const [revealed, setRevealed] = useState(!enabled);

  useLayoutEffect(() => {
    if (enabled && !armed) setArmed(true);
  }, [armed, enabled]);
  useEffect(() => {
    if (revealRequested && !revealed) setRevealed(true);
  }, [revealRequested, revealed]);
  useEffect(() => {
    if (!enabled || !windowShown || revealed) return undefined;
    const timer = window.setTimeout(() => setTimedOut(true), DESKTOP_BOOT_COVER_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, revealed, windowShown]);
  useEffect(() => {
    if (timedOut) {
      markBootStage("desktop-boot-timeout", surfaces.pendingKeys.join(","));
    }
  }, [surfaces.pendingKeys, timedOut]);
  useEffect(() => {
    if (!revealed || handoffComplete) return undefined;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setHandoffComplete(true);
      return undefined;
    }
    setCoverLeaving(true);
    const timer = window.setTimeout(
      () => setHandoffComplete(true),
      DESKTOP_BOOT_BRAND_FADE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [handoffComplete, revealed]);
  useEffect(() => {
    if (!revealed) return;
    barrier.seal();
    (window as typeof window & { __mixdogDesktopRevealed?: boolean })
      .__mixdogDesktopRevealed = true;
    markBootStage("desktop-revealed", timedOut ? "timeout" : "ready");
  }, [barrier, revealed, timedOut]);
  useEffect(() => () => barrier.dispose(), [barrier]);

  return <div className="desktop-boot-gate"
    data-ready={handoffComplete ? "true" : "false"}
    data-brand-handoff={handoffComplete ? (enabled ? "desktop" : "browser") : undefined}
    data-timeout={timedOut ? "true" : undefined}
    data-pending={enabled && !handoffComplete ? surfaces.pending : undefined}>
    <div className="desktop-boot-gate-content"
      inert={!handoffComplete ? true : undefined}
      aria-hidden={!handoffComplete ? true : undefined}>
      {children}
    </div>
    {!handoffComplete && <div className="desktop-boot-cover"
      data-leaving={coverLeaving ? "true" : undefined}>
      <DesktopLoadingSurface label={label} brand />
    </div>}
  </div>;
}

function sameRequest<T extends SurfaceId>(
  request: { id: T; key: SurfaceId },
  id: T,
  key: SurfaceId,
): boolean {
  return Object.is(request.id, id) && Object.is(request.key, key);
}

/**
 * Present one already-mounted surface while the requested surface settles
 * hidden. Ready cache hits keep the outgoing surface visible; cold requests
 * use the opaque loading cover. Rapid requests cancel stale commits.
 */
export function useStableSurfaceSwitch<T extends SurfaceId>(
  requestedId: T,
  ready: boolean,
  transitionKey: SurfaceId = requestedId,
) {
  const [presented, setPresented] = useState(() => ({
    id: requestedId,
    key: transitionKey,
  }));
  const [coldRequest, setColdRequest] = useState<{ id: T; key: SurfaceId } | null>(
    () => ready ? null : { id: requestedId, key: transitionKey },
  );
  const sequence = useRef(0);
  const settled = sameRequest(presented, requestedId, transitionKey);
  const cold = coldRequest
    ? sameRequest(coldRequest, requestedId, transitionKey)
    : false;

  useLayoutEffect(() => {
    const request = { id: requestedId, key: transitionKey };
    const token = ++sequence.current;
    if (!ready) {
      setColdRequest((current) => current && sameRequest(current, requestedId, transitionKey)
        ? current
        : request);
      return undefined;
    }
    if (sameRequest(presented, requestedId, transitionKey) && !cold) {
      setColdRequest((current) => current
        && !sameRequest(current, requestedId, transitionKey) ? null : current);
      return undefined;
    }
    const commit = () => {
      if (sequence.current !== token) return;
      setPresented(request);
      setColdRequest((current) => current
        && sameRequest(current, requestedId, transitionKey) ? null : current);
    };
    if (cold) return scheduleStableSurfaceCommit(commit);
    // Warm surfaces are already mounted/ready. Commit synchronously from the
    // layout effect so React finishes the replacement before the browser can
    // paint the outgoing destination for another frame.
    commit();
    return undefined;
  }, [
    cold,
    presented.id,
    presented.key,
    ready,
    requestedId,
    transitionKey,
  ]);

  return {
    presentedId: presented.id,
    settled,
    transitioning: !settled,
    covered: !ready || cold,
  };
}

export function StableSurfaceSwitch<T extends SurfaceId>({
  activeId,
  ready,
  label,
  transitionKey = activeId,
  className = "",
  children,
}: {
  activeId: T;
  ready: boolean;
  label: string;
  transitionKey?: SurfaceId;
  className?: string;
  children(state: {
    presentedId: T;
    transitioning: boolean;
    surfaceProps(id: T): {
      "data-surface-active": "true" | "false";
      inert: true | undefined;
      "aria-hidden": true | undefined;
    };
  }): ReactNode;
}) {
  const state = useStableSurfaceSwitch(activeId, ready, transitionKey);
  const surfaceProps = (id: T) => {
    const active = Object.is(state.presentedId, id);
    return {
      "data-surface-active": active ? "true" as const : "false" as const,
      inert: active ? undefined : true as const,
      "aria-hidden": active ? undefined : true as const,
    };
  };
  return <div
    className={`stable-surface-switch${className ? ` ${className}` : ""}`}
    data-ready={ready && Object.is(state.presentedId, activeId) ? "true" : "false"}
    data-transitioning={state.transitioning ? "true" : "false"}>
    {children({
      presentedId: state.presentedId,
      transitioning: state.transitioning,
      surfaceProps,
    })}
    {state.covered && <div className="pane-surface-cover">
      <DesktopLoadingSurface label={label} />
    </div>}
  </div>;
}

/**
 * Stage a cold keyed subtree beside the outgoing one behind an opaque cover.
 * Warm replacements commit before paint and remove the outgoing subtree in the
 * same render, so menu/depth changes never expose an alpha-blended old page.
 */
export function StableContentSwap({
  transitionKey,
  ready = true,
  label = "Preparing…",
  className = "",
  children,
}: {
  transitionKey: SurfaceId;
  ready?: boolean;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  const nodes = useRef(new Map<SurfaceId, ReactNode>()).current;
  const state = useStableSurfaceSwitch(transitionKey, ready, transitionKey);
  nodes.set(transitionKey, children);
  // Retain only the currently presented and requested nodes while a cold
  // request settles. Once presented, the outgoing node disappears atomically.
  for (const key of nodes.keys()) {
    if (!Object.is(key, state.presentedId) && !Object.is(key, transitionKey)) {
      nodes.delete(key);
    }
    if (state.settled && !Object.is(key, transitionKey)) {
      nodes.delete(key);
    }
  }
  return <div
    className={`stable-content-swap${className ? ` ${className}` : ""}`}
    data-ready={state.settled && ready ? "true" : "false"}>
    {[...nodes.entries()].map(([key, node]) => {
      const active = Object.is(key, state.presentedId);
      return <div key={key} className="stable-content-swap-layer"
        data-surface-active={active ? "true" : "false"}
        inert={active ? undefined : true}
        aria-hidden={active ? undefined : true}>
        {node}
      </div>;
    })}
    {state.covered && <div className="pane-surface-cover">
      <DesktopLoadingSurface label={label} />
    </div>}
  </div>;
}

/**
 * Mount a cold surface behind an opaque, geometry-stable cover and reveal it
 * only after data/DOM readiness has survived two composed frames.
 */
export function PaneSurfaceGate({
  ready,
  label,
  transitionKey,
  children,
}: {
  ready: boolean;
  label: string;
  transitionKey?: string | number;
  children: ReactNode;
}) {
  const revealed = useStableSurfaceReveal(ready, transitionKey);
  return <div className="pane-surface-gate" data-ready={revealed ? "true" : "false"}>
    <div className="pane-surface-gate-content" aria-hidden={revealed ? undefined : true}>
      {children}
    </div>
    {!revealed && <DesktopLoadingSurface label={label} />}
  </div>;
}

/** Overlay form for layout-sensitive trees (Conversation/virtualizer) that
 * must remain a direct child of their existing flex container. */
export function PaneSurfaceCover({
  ready,
  label,
  transitionKey,
  showSpinner = true,
}: {
  ready: boolean;
  label: string;
  transitionKey?: string | number;
  showSpinner?: boolean;
}) {
  const revealed = useStableSurfaceReveal(ready, transitionKey);
  return revealed ? null : <div className="pane-surface-cover">
    {showSpinner
      ? <DesktopLoadingSurface label={label} />
      : <span className="sr-only" role="status">{label}</span>}
  </div>;
}

type PersistentSurfaceScroll = { top: number; left: number };

/**
 * Relocate the portal host without losing the scroll/focus state its surfaces
 * depend on. `appendChild` detaches the subtree first, which resets every
 * scroller inside it to 0 and drops DOM focus — a moved pane's virtualized
 * transcript then painted blank, because the viewport snapped to 0 while the
 * virtual core kept rendering rows at its previous offset. `moveBefore` moves
 * the subtree atomically where available; the explicit restore covers the
 * fallback path and anything the atomic move does not carry.
 */
function movePersistentPaneHost(
  host: HTMLElement,
  target: HTMLElement,
  scrollOffsets: Map<Element, PersistentSurfaceScroll>,
): void {
  const focused = document.activeElement;
  const refocus = focused instanceof HTMLElement && host.contains(focused)
    ? focused
    : null;
  const mover = target as HTMLElement & {
    moveBefore?: (node: Node, child: Node | null) => void;
  };
  let moved = false;
  if (host.isConnected && typeof mover.moveBefore === "function") {
    try {
      mover.moveBefore(host, null);
      moved = true;
    } catch {
      // State-preserving moves are a fast path only.
    }
  }
  if (!moved) target.appendChild(host);
  for (const [element, offset] of scrollOffsets) {
    if (!host.contains(element)) {
      scrollOffsets.delete(element);
      continue;
    }
    if (element.scrollTop !== offset.top) element.scrollTop = offset.top;
    if (element.scrollLeft !== offset.left) element.scrollLeft = offset.left;
  }
  if (refocus && document.activeElement !== refocus) {
    refocus.focus({ preventScroll: true });
  }
}

/**
 * A fixed DOM host whose React subtree survives moving between pane slots.
 * Moving the host node keeps the terminal portal live and avoids remounting
 * Studio/xterm/diff state when the binary pane layout is reshaped.
 */
export function PersistentPanePortal({
  targetId,
  className = "",
  onPointerDownCapture,
  children,
}: {
  targetId: string;
  className?: string;
  onPointerDownCapture?: (event: PointerEvent) => void;
  children: ReactNode;
}) {
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = `persistent-pane-surface${className ? ` ${className}` : ""}`;
    return element;
  });
  // Scroll offsets are recorded from the surfaces' own scroll events, so the
  // relocation itself never has to force layout to read them back.
  const [scrollOffsets] = useState(() => new Map<Element, PersistentSurfaceScroll>());
  useLayoutEffect(() => {
    const remember = (event: Event) => {
      const element = event.target;
      if (!(element instanceof Element) || !host.contains(element)) return;
      scrollOffsets.set(element, {
        top: element.scrollTop,
        left: element.scrollLeft,
      });
    };
    // scroll does not bubble; a capture listener on the host still sees every
    // scroller inside the portal subtree.
    host.addEventListener("scroll", remember, true);
    return () => host.removeEventListener("scroll", remember, true);
  }, [host, scrollOffsets]);
  useLayoutEffect(() => {
    const target = document.getElementById(targetId);
    if (target && host.parentElement !== target) {
      movePersistentPaneHost(host, target, scrollOffsets);
    }
  });
  // React portal events follow the owner tree, not this host's physical DOM
  // ancestry. Listen on the host itself so clicking Studio/xterm/diff inside
  // an unfocused pane still routes focus to the pane that visibly contains it.
  useLayoutEffect(() => {
    if (!onPointerDownCapture) return undefined;
    host.addEventListener("pointerdown", onPointerDownCapture, true);
    return () => host.removeEventListener("pointerdown", onPointerDownCapture, true);
  }, [host, onPointerDownCapture]);
  useLayoutEffect(() => () => host.remove(), [host]);
  return createPortal(children, host);
}
