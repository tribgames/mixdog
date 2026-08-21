import type { DesktopBootContext } from "../shared/contract";

export interface BootMetricEntry {
  bootId: string;
  scenario?: string;
  category: "boot" | "surface";
  stage: string;
  totalMs: number;
  surface?: string;
  key?: string;
  durationMs?: number;
  details?: string;
}

export interface BootSurfaceBarrierSnapshot {
  revision: number;
  pending: number;
  pendingKeys: readonly string[];
}

export interface BootSurfaceBarrier {
  subscribe(listener: () => void): () => void;
  getSnapshot(): BootSurfaceBarrierSnapshot;
  seal(): void;
  dispose(): void;
}

declare global {
  interface Window {
    __mixdogBootMetrics?: BootMetricEntry[];
    __mixdogWindowShown?: boolean;
  }
}

const context: DesktopBootContext = typeof window !== "undefined"
  && window.mixdogDesktop?.bootContext
  ? window.mixdogDesktop.bootContext
  : {
    bootId: "browser",
    processStartedAt: typeof performance !== "undefined"
      ? Math.round(performance.timeOrigin)
      : Date.now(),
  };
const globalStages = new Set<string>();
const surfaceMetrics = new Map<string, { startedAt: number; stages: Set<string> }>();
const BOOT_METRIC_ENTRY_LIMIT = 512;
const BOOT_SURFACE_CACHE_LIMIT = 256;
type BootSurfaceBarrierState = {
  pending: Set<string>;
  listeners: Set<() => void>;
  snapshot: BootSurfaceBarrierSnapshot;
  sealed: boolean;
};
const activeSurfaceBarriers = new Set<BootSurfaceBarrierState>();
const queuedBarrierRegistrations = new Set<string>();

function pruneSurfaceMetrics(): void {
  while (surfaceMetrics.size > BOOT_SURFACE_CACHE_LIMIT) {
    let oldestReady = "";
    for (const [id, metric] of surfaceMetrics) {
      if (metric.stages.has("ready")) {
        oldestReady = id;
        break;
      }
    }
    if (!oldestReady) break;
    surfaceMetrics.delete(oldestReady);
  }
}

function publishBarrier(state: BootSurfaceBarrierState): void {
  state.snapshot = {
    revision: state.snapshot.revision + 1,
    pending: state.pending.size,
    pendingKeys: [...state.pending].sort(),
  };
  for (const listener of [...state.listeners]) listener();
}

function registerBarrierSurface(
  state: BootSurfaceBarrierState,
  id: string,
  painted: boolean,
): void {
  if (state.sealed || painted || state.pending.has(id)) return;
  state.pending.add(id);
  publishBarrier(state);
}

function resolveBarrierSurface(state: BootSurfaceBarrierState, id: string): void {
  if (state.sealed || !state.pending.delete(id)) return;
  publishBarrier(state);
}

function queueBarrierRegistration(id: string): void {
  if (queuedBarrierRegistrations.has(id)) return;
  queuedBarrierRegistrations.add(id);
  queueMicrotask(() => {
    queuedBarrierRegistrations.delete(id);
    const painted = surfaceMetrics.get(id)?.stages.has("paint") === true;
    for (const barrier of activeSurfaceBarriers) {
      registerBarrierSurface(barrier, id, painted);
    }
  });
}

export function createBootSurfaceBarrier(): BootSurfaceBarrier {
  const state: BootSurfaceBarrierState = {
    pending: new Set(),
    listeners: new Set(),
    snapshot: { revision: 0, pending: 0, pendingKeys: [] },
    sealed: false,
  };
  activeSurfaceBarriers.add(state);
  const seal = () => {
    if (state.sealed) return;
    state.sealed = true;
    activeSurfaceBarriers.delete(state);
    state.pending.clear();
    publishBarrier(state);
  };
  return {
    subscribe(listener) {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    getSnapshot: () => state.snapshot,
    seal,
    dispose() {
      seal();
      state.listeners.clear();
    },
  };
}

function totalMs(): number {
  return Math.max(0, Date.now() - context.processStartedAt);
}

function cleanToken(value: string, limit = 80): string {
  return String(value || "").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, limit);
}

function hashKey(value: string): string {
  let hash = 2_166_136_261;
  for (const codePoint of String(value || "")) {
    hash ^= codePoint.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function append(entry: BootMetricEntry): void {
  if (typeof window === "undefined") return;
  const metrics = window.__mixdogBootMetrics ||= [];
  metrics.push(entry);
  if (metrics.length > BOOT_METRIC_ENTRY_LIMIT) {
    metrics.splice(0, metrics.length - BOOT_METRIC_ENTRY_LIMIT);
  }
  try {
    window.mixdogDesktop?.perfLog?.(
      `boot id=${cleanToken(entry.bootId)}`
      + `${entry.scenario ? ` scenario=${cleanToken(entry.scenario)}` : ""}`
      + ` category=${entry.category}`
      + `${entry.surface ? ` surface=${cleanToken(entry.surface)}` : ""}`
      + `${entry.key ? ` key=${cleanToken(entry.key)}` : ""}`
      + ` stage=${cleanToken(entry.stage)} total=${entry.totalMs.toFixed(1)}ms`
      + `${entry.durationMs === undefined ? "" : ` duration=${entry.durationMs.toFixed(1)}ms`}`
      + `${entry.details ? ` details=${cleanToken(entry.details, 120)}` : ""}`,
    );
  } catch {
    // Boot diagnostics must never become a launch failure.
  }
  try {
    window.dispatchEvent(new CustomEvent("mixdog:boot-metric", { detail: entry }));
  } catch {
    // Browser shims may not expose CustomEvent during early bootstrap.
  }
}

export function markBootStage(stage: string, details = ""): boolean {
  const cleanStage = cleanToken(stage);
  if (!cleanStage || globalStages.has(cleanStage)) return false;
  globalStages.add(cleanStage);
  append({
    bootId: context.bootId,
    ...(context.scenario ? { scenario: context.scenario } : {}),
    category: "boot",
    stage: cleanStage,
    totalMs: totalMs(),
    ...(details ? { details } : {}),
  });
  return true;
}

export function beginBootSurface(surface: string, rawKey: string): string {
  const cleanSurface = cleanToken(surface);
  const key = hashKey(rawKey || cleanSurface);
  const id = `${cleanSurface}:${key}`;
  const existing = surfaceMetrics.get(id);
  if (existing) {
    surfaceMetrics.delete(id);
    surfaceMetrics.set(id, existing);
    if (!existing.stages.has("ready")) queueBarrierRegistration(id);
    return id;
  }
  const startedAt = totalMs();
  surfaceMetrics.set(id, { startedAt, stages: new Set(["request"]) });
  pruneSurfaceMetrics();
  queueBarrierRegistration(id);
  append({
    bootId: context.bootId,
    ...(context.scenario ? { scenario: context.scenario } : {}),
    category: "surface",
    surface: cleanSurface,
    key,
    stage: "request",
    totalMs: startedAt,
    durationMs: 0,
  });
  return id;
}

export function reportBootSurfaceStage(
  surface: string,
  rawKey: string,
  stage: string,
  details = "",
): boolean {
  const id = beginBootSurface(surface, rawKey);
  const metric = surfaceMetrics.get(id)!;
  const cleanStage = cleanToken(stage);
  if (!cleanStage || metric.stages.has(cleanStage)) return false;
  metric.stages.add(cleanStage);
  // The cold-start cover has its own fade after the first real paint. Releasing
  // its barrier at paint overlaps that fade with the second-frame stability
  // check instead of serializing both delays. Per-surface ready metrics still
  // complete on the following frame for diagnostics and later surface swaps.
  if (cleanStage === "paint") {
    for (const barrier of activeSurfaceBarriers) resolveBarrierSurface(barrier, id);
  }
  if (cleanStage === "ready") {
    pruneSurfaceMetrics();
  }
  const total = totalMs();
  append({
    bootId: context.bootId,
    ...(context.scenario ? { scenario: context.scenario } : {}),
    category: "surface",
    surface: cleanToken(surface),
    key: id.slice(id.indexOf(":") + 1),
    stage: cleanStage,
    totalMs: total,
    durationMs: Math.max(0, total - metric.startedAt),
    ...(details ? { details } : {}),
  });
  return true;
}

export function reportBootSurfaceReady(
  surface: string,
  rawKey: string,
  details = "",
): void {
  // Shell gates may have already recorded DOM readiness. That must not suppress
  // the later data-complete paint/ready handshake.
  reportBootSurfaceStage(surface, rawKey, "dom", details);
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => {
      reportBootSurfaceStage(surface, rawKey, "paint");
      window.requestAnimationFrame(() => reportBootSurfaceStage(surface, rawKey, "ready"));
    });
  } else {
    window.setTimeout(() => {
      reportBootSurfaceStage(surface, rawKey, "paint");
      reportBootSurfaceStage(surface, rawKey, "ready");
    }, 0);
  }
}

export function _bootMetricStatsForTest() {
  return {
    surfaceCount: surfaceMetrics.size,
    entryCount: typeof window === "undefined" ? 0 : (window.__mixdogBootMetrics?.length || 0),
  };
}

export function _resetBootMetricsForTest() {
  surfaceMetrics.clear();
  queuedBarrierRegistrations.clear();
  if (typeof window !== "undefined" && window.__mixdogBootMetrics) {
    window.__mixdogBootMetrics.length = 0;
  }
}

if (typeof window !== "undefined") {
  window.__mixdogBootMetrics ||= [];
  if (window.__mixdogWindowShown) markBootStage("window-visible-frame");
  else window.addEventListener(
    "mixdog:window-shown",
    () => markBootStage("window-visible-frame"),
    { once: true },
  );
}
