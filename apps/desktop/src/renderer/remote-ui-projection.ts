import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopRemoteProjectionInput,
  DesktopRemoteProjectionState,
} from "../shared/contract";

export type DesktopRemoteProjectionView = Omit<DesktopRemoteProjectionInput, "sourceId">;

export function isRemoteBrowserRenderer(): boolean {
  return typeof navigator !== "undefined" && !/Electron/i.test(navigator.userAgent);
}

/** The host rejects an out-of-vocabulary panel/tab outright, so the publisher
 *  normalizes instead of letting one unknown id silence the whole channel. */
const PROJECTION_SIDEBAR_PANELS = new Set([
  "utilities", "schedules", "webhooks", "projects", "workflows",
]);
const PROJECTION_DOCK_TABS = new Set([
  "agents", "search", "source-control", "pull-requests",
]);

export function normalizeProjectionView(input: {
  selection: unknown;
  sidebarOpen: boolean;
  sidebarPanel: string | null | undefined;
  dockOpen: boolean;
  dockTab: string | null | undefined;
  bottomPanelOpen: boolean;
  bottomPanelTab: string | null | undefined;
}): DesktopRemoteProjectionView {
  const sidebarPanel = String(input.sidebarPanel ?? "");
  const dockTab = String(input.dockTab ?? "");
  return {
    selection: input.selection ?? null,
    sidebarOpen: Boolean(input.sidebarOpen),
    sidebarPanel: PROJECTION_SIDEBAR_PANELS.has(sidebarPanel) ? sidebarPanel : null,
    dockOpen: Boolean(input.dockOpen),
    dockTab: PROJECTION_DOCK_TABS.has(dockTab) ? dockTab : "agents",
    bottomPanelOpen: Boolean(input.bottomPanelOpen),
    bottomPanelTab: String(input.bottomPanelTab ?? "").slice(0, 64),
  };
}

/** How long after entry an arriving selection still counts as "the work I was
 *  just doing" rather than an interruption. */
export const PROJECTION_COLD_WINDOW_MS = 1_000;

/** Cold open inherits the paired surface's selection; afterwards only live
 *  changes follow, and a surface the user already touched is never overridden
 *  by the first arriving state. */
export function shouldAdoptProjectionSelection({
  first,
  elapsedMs,
  interacted,
  coldWindowMs = PROJECTION_COLD_WINDOW_MS,
}: {
  first: boolean;
  elapsedMs: number;
  interacted: boolean;
  coldWindowMs?: number;
}): boolean {
  if (!first) return true;
  return !interacted && elapsedMs <= coldWindowMs;
}

function projectionSignature(view: DesktopRemoteProjectionView): string {
  return JSON.stringify(view);
}

function validProjection(value: unknown): value is DesktopRemoteProjectionState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<DesktopRemoteProjectionState>;
  return Number.isSafeInteger(state.revision)
    && Number(state.revision) > 0
    && typeof state.sourceId === "string"
    && typeof state.sidebarOpen === "boolean"
    && typeof state.dockOpen === "boolean";
}

function stateView(state: DesktopRemoteProjectionState): DesktopRemoteProjectionView {
  return {
    selection: state.selection,
    sidebarOpen: state.sidebarOpen,
    sidebarPanel: state.sidebarPanel,
    dockOpen: state.dockOpen,
    dockTab: state.dockTab,
    bottomPanelOpen: state.bottomPanelOpen,
    bottomPanelTab: state.bottomPanelTab,
  };
}

export function useRemoteUiProjection({
  view,
  ready,
  apply,
}: {
  view: DesktopRemoteProjectionView;
  ready: boolean;
  apply(state: DesktopRemoteProjectionState): void;
}): boolean {
  const remoteBrowser = isRemoteBrowserRenderer();
  const sourceId = useRef("");
  if (!sourceId.current) {
    const random = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    sourceId.current = `${remoteBrowser ? "web" : "desktop"}:${random}`;
  }
  const viewSignature = useMemo(() => projectionSignature(view), [view]);
  const viewRef = useRef(view);
  const applyRef = useRef(apply);
  viewRef.current = view;
  applyRef.current = apply;
  const projectionReady = useRef(false);
  const latestRevision = useRef(0);
  const lastPublishedSignature = useRef("");
  const applyingSignature = useRef("");
  const releaseTimer = useRef<number | null>(null);
  const [releasePulse, setReleasePulse] = useState(0);

  useEffect(() => {
    const api = window.mixdogDesktop;
    if (!api?.getRemoteProjection || !api.subscribeRemoteProjection) return undefined;
    let live = true;
    const receive = (state: DesktopRemoteProjectionState): void => {
      if (!live || !validProjection(state) || state.revision <= latestRevision.current) return;
      latestRevision.current = state.revision;
      projectionReady.current = true;
      const signature = projectionSignature(stateView(state));
      if (state.sourceId === sourceId.current) {
        lastPublishedSignature.current = signature;
        return;
      }
      applyingSignature.current = signature;
      applyRef.current(state);
      if (releaseTimer.current !== null) window.clearTimeout(releaseTimer.current);
      releaseTimer.current = window.setTimeout(() => {
        releaseTimer.current = null;
        if (applyingSignature.current !== signature) return;
        applyingSignature.current = "";
        // Adopt whatever this surface settled on as the published baseline.
        // A partially-applied remote state (unsupported pane, disabled tab,
        // width-constrained sidebar) must NOT echo back as a new authored
        // revision — that stomps the authoring surface with a degraded copy
        // of its own layout. Only later, genuinely local changes publish.
        lastPublishedSignature.current = projectionSignature(viewRef.current);
        setReleasePulse((value) => value + 1);
      }, 300);
    };
    const unsubscribe = api.subscribeRemoteProjection(receive);
    void api.getRemoteProjection().then((state) => {
      if (state) receive(state);
    }).catch(() => {});
    return () => {
      live = false;
      unsubscribe();
      if (releaseTimer.current !== null) window.clearTimeout(releaseTimer.current);
      releaseTimer.current = null;
    };
  }, []);

  useEffect(() => {
    const api = window.mixdogDesktop;
    const setRemoteProjection = api?.setRemoteProjection;
    if (!ready || !setRemoteProjection) return undefined;
    if (remoteBrowser && !projectionReady.current) return undefined;
    if (applyingSignature.current) {
      if (applyingSignature.current === viewSignature) {
        applyingSignature.current = "";
        lastPublishedSignature.current = viewSignature;
      }
      return undefined;
    }
    if (lastPublishedSignature.current === viewSignature) return undefined;
    const timer = window.setTimeout(() => {
      const current = viewRef.current;
      const signature = projectionSignature(current);
      if (applyingSignature.current || lastPublishedSignature.current === signature) return;
      lastPublishedSignature.current = signature;
      void setRemoteProjection({
        sourceId: sourceId.current,
        ...current,
      }).then((state) => {
        if (validProjection(state)) latestRevision.current = state.revision;
      }).catch(() => {
        if (lastPublishedSignature.current === signature) {
          lastPublishedSignature.current = "";
        }
      });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [ready, remoteBrowser, releasePulse, viewSignature]);

  return remoteBrowser;
}
