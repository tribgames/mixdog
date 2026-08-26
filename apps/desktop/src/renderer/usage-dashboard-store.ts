// Process-wide subscription-usage cache.
//
// The rail flyout mounts SidebarUsage only while it is open, so the component
// cannot own the request, its timers, or the snapshot: every popup open would
// restart the cadence and re-fetch, and no warmup could run before the first
// click. This module keeps ONE snapshot, ONE deduped getUsageDashboard request,
// and ONE refresh cadence for the whole renderer — the desktop twin of the TUI
// statusline usage warmup. localStorage stays a stale seed only: it paints
// instantly and is always revalidated.
//
// Ownership rules (a stale response must never win):
//   * host    — the window the state belongs to; a different document rebinds.
//   * epoch   — retired by a rebind, a reset, a mutation publish, a timeout, or
//               the last cadence release. A response from a retired generation
//               is dropped without publishing, persisting, or retrying.
//   * request id — monotonic per request; only the owning request may release
//               the pending slot, so an old finally cannot clear a newer one.
import type { DesktopApi } from "../shared/contract";

export type UsageApi = Partial<Pick<DesktopApi, "invokeCapability">>;
export type UsageRecord = Record<string, unknown>;

/** Lifecycle of the LIVE result, independent of what currently paints:
 *   idle        — nothing requested yet (a stale seed may already paint)
 *   loading     — a request or its bounded retry is outstanding, no live result
 *   ready       — a valid live dashboard was accepted
 *   unavailable — the request path settled without a usable dashboard */
export type UsageDashboardStatus = "idle" | "loading" | "ready" | "unavailable";

export type UsageDashboardSnapshot = {
  dashboard: UsageRecord;
  /** Time of the last accepted LIVE result; 0 while only the seed is known. */
  refreshedAt: number;
  /** Convenience mirror of `status === "loading"`. */
  loading: boolean;
  status: UsageDashboardStatus;
};

export const USAGE_DASHBOARD_CACHE_KEY = "mixdog.desktop.sidebar-usage.v1";
export const USAGE_DASHBOARD_REFRESH_INTERVAL_MS = 5 * 60_000;
/** A snapshot younger than this satisfies an open/prewarm without a request. */
export const USAGE_DASHBOARD_TTL_MS = USAGE_DASHBOARD_REFRESH_INTERVAL_MS;
export const USAGE_DASHBOARD_RETRY_DELAY_MS = 15_000;
export const USAGE_DASHBOARD_REQUEST_TIMEOUT_MS = 30_000;

// Bounds for anything that reaches the UI or the persisted cache. The usage
// dashboard is a small fixed-shape document; a capability response that does
// not fit it is refused rather than trusted.
const MAX_DASHBOARD_KEYS = 32;
const MAX_ROWS = 24;
const MAX_ROW_KEYS = 32;
const MAX_WINDOWS = 12;
const MAX_WINDOW_KEYS = 16;
const MAX_RESET_CREDITS = 24;
const MAX_CREDIT_KEYS = 12;
const MAX_STRING_LENGTH = 512;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const USAGE_TIMEOUT_CODE = "usage-timeout";

type Listener = (snapshot: UsageDashboardSnapshot) => void;

const EMPTY_SNAPSHOT: UsageDashboardSnapshot = {
  dashboard: {},
  refreshedAt: 0,
  loading: false,
  status: "idle",
};

let host: Window | null = null;
let snapshot: UsageDashboardSnapshot = EMPTY_SNAPSHOT;
let listeners = new Set<Listener>();
let epoch = 0;
let requestSequence = 0;
let pending: Promise<void> | null = null;
let pendingId = 0;
let retryTimer: number | null = null;
let retryUsed = false;
let cadenceHolders = 0;
let cadenceTimer: number | null = null;
let cadenceApi: UsageApi | undefined;
let retirementQueued = false;
const timers = new Set<number>();

function scalarValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.slice(0, MAX_STRING_LENGTH);
  return undefined;
}

/** Scalar-only copy: nested objects, arrays, functions and prototype keys are
 *  dropped, so nothing unbounded can be serialized into localStorage. */
function scalarRecord(value: unknown, maxKeys: number): UsageRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as UsageRecord;
  const out: UsageRecord = {};
  let kept = 0;
  for (const key of Object.keys(source)) {
    if (kept >= maxKeys) break;
    if (UNSAFE_KEYS.has(key)) continue;
    const scalar = scalarValue(source[key]);
    if (scalar === undefined) continue;
    out[key] = scalar;
    kept += 1;
  }
  return out;
}

function scalarRecordList(value: unknown, limit: number, maxKeys: number): UsageRecord[] {
  if (!Array.isArray(value)) return [];
  const out: UsageRecord[] = [];
  for (const entry of value) {
    if (out.length >= limit) break;
    const sanitized = scalarRecord(entry, maxKeys);
    if (sanitized) out.push(sanitized);
  }
  return out;
}

function sanitizeResetCredits(value: unknown): UsageRecord | null {
  const credits = scalarRecord(value, MAX_ROW_KEYS);
  if (!credits) return null;
  const available = (value as UsageRecord).availableCredits;
  if (Array.isArray(available)) {
    credits.availableCredits = scalarRecordList(available, MAX_RESET_CREDITS, MAX_CREDIT_KEYS);
  }
  return credits;
}

function sanitizeRow(value: unknown): UsageRecord | null {
  const row = scalarRecord(value, MAX_ROW_KEYS);
  if (!row) return null;
  const source = value as UsageRecord;
  // Every field the usage surface reads survives: id/label/group/authenticated
  // stay as scalars, quota windows and reset credits keep their own scalars.
  if (Array.isArray(source.windows)) {
    row.windows = scalarRecordList(source.windows, MAX_WINDOWS, MAX_WINDOW_KEYS);
  }
  const resetCredits = sanitizeResetCredits(source.resetCredits);
  if (resetCredits) row.resetCredits = resetCredits;
  return row;
}

/** Returns a bounded copy of a usage dashboard, or null when the payload is
 *  not one (missing/!Array rows, non-object, hostile shape). */
function sanitizeUsageDashboard(value: unknown): UsageRecord | null {
  const dashboard = scalarRecord(value, MAX_DASHBOARD_KEYS);
  if (!dashboard) return null;
  const source = value as UsageRecord;
  if (!Array.isArray(source.rows)) return null;
  const rows: UsageRecord[] = [];
  for (const entry of source.rows) {
    if (rows.length >= MAX_ROWS) break;
    const row = sanitizeRow(entry);
    if (row) rows.push(row);
  }
  dashboard.rows = rows;
  return dashboard;
}

function rowCount(dashboard: UsageRecord): number {
  return Array.isArray(dashboard.rows) ? dashboard.rows.length : 0;
}

function readCache(win: Window): UsageRecord {
  try {
    // The seed is validated exactly like a live response: a poisoned cache key
    // must not be able to inject anything the capability could not return.
    return sanitizeUsageDashboard(
      JSON.parse(win.localStorage.getItem(USAGE_DASHBOARD_CACHE_KEY) || "null"),
    ) || {};
  } catch {
    return {};
  }
}

function writeCache(win: Window, value: UsageRecord): void {
  try {
    win.localStorage.setItem(USAGE_DASHBOARD_CACHE_KEY, JSON.stringify(value));
  } catch {
    // Usage stays available in memory when persistent storage is unavailable.
  }
}

function trackTimeout(win: Window, task: () => void, delayMs: number): number {
  let handle = 0;
  handle = win.setTimeout(() => {
    timers.delete(handle);
    task();
  }, delayMs);
  timers.add(handle);
  return handle;
}

function clearTracked(win: Window | null, handle: number): void {
  if (!timers.delete(handle)) return;
  try {
    win?.clearTimeout(handle);
  } catch {
    // A retired window already dropped its timers.
  }
}

function clearTimers(): void {
  for (const handle of [...timers]) clearTracked(host, handle);
  timers.clear();
  retryTimer = null;
}

function stopCadence(): void {
  if (cadenceTimer === null) return;
  try {
    host?.clearInterval(cadenceTimer);
  } catch {
    // A retired window already dropped its timers.
  }
  cadenceTimer = null;
}

/** Retires the current generation: pending ownership, tracked timers and the
 *  bounded retry are dropped, and any late response is ignored. */
function retire(): void {
  epoch += 1;
  pending = null;
  pendingId = 0;
  retryUsed = false;
  clearTimers();
}

/** Rebinds the store when a different document owns the renderer (reload, or a
 *  fresh test DOM): the retired window's storage, timers and subscribers can
 *  never be adopted by the new one. */
function ensureHost(): Window | null {
  const active = typeof window === "undefined" ? null : window;
  if (active === host) return active;
  retire();
  stopCadence();
  cadenceHolders = 0;
  cadenceApi = undefined;
  listeners = new Set();
  host = active;
  snapshot = active
    ? { dashboard: readCache(active), refreshedAt: 0, loading: false, status: "idle" }
    : EMPTY_SNAPSHOT;
  return active;
}

function publish(next: UsageDashboardSnapshot): void {
  // Identity is the subscription contract (useSyncExternalStore): only a real
  // change may produce a new object.
  if (next.dashboard === snapshot.dashboard
    && next.refreshedAt === snapshot.refreshedAt
    && next.loading === snapshot.loading
    && next.status === snapshot.status) return;
  snapshot = next;
  for (const listener of [...listeners]) listener(snapshot);
}

function publishStatus(status: UsageDashboardStatus): void {
  publish({ ...snapshot, status, loading: status === "loading" });
}

/** Settled status when no request is outstanding: a live result keeps the
 *  surface ready, otherwise the first paint reaches a FINAL unavailable state
 *  instead of announcing loading forever. */
function settledStatus(): UsageDashboardStatus {
  return snapshot.refreshedAt > 0 ? "ready" : "unavailable";
}

export function withUsageTimeout<T>(promise: Promise<T>, delayMs: number, win: Window): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = trackTimeout(win, () => {
      const error = new Error("Subscription usage refresh timed out.") as Error & { code?: string };
      error.code = USAGE_TIMEOUT_CODE;
      reject(error);
    }, delayMs);
    promise.then(
      (value) => {
        clearTracked(win, timer);
        resolve(value);
      },
      (reason) => {
        clearTracked(win, timer);
        reject(reason);
      },
    );
  });
}

export function getUsageDashboardSnapshot(): UsageDashboardSnapshot {
  ensureHost();
  return snapshot;
}

export function subscribeUsageDashboard(listener: Listener): () => void {
  ensureHost();
  listeners.add(listener);
  const owner = listeners;
  return () => {
    owner.delete(listener);
  };
}

/** Adopts a dashboard produced by a mutation (reset-credit consume). It counts
 *  as a live response — same validation, same cache write, same freshness
 *  stamp — and it RETIRES any in-flight refresh so a response that predates the
 *  mutation can never overwrite its result. Returns false when the payload is
 *  not a usable dashboard, which is what the caller reports as "not confirmed".
 */
export function publishUsageDashboard(dashboard: unknown): boolean {
  const win = ensureHost();
  if (!win) return false;
  const sanitized = sanitizeUsageDashboard(dashboard);
  if (!sanitized || rowCount(sanitized) === 0) return false;
  retire();
  writeCache(win, sanitized);
  publish({ dashboard: sanitized, refreshedAt: Date.now(), loading: false, status: "ready" });
  return true;
}

function isFresh(): boolean {
  return snapshot.refreshedAt > 0
    && rowCount(snapshot.dashboard) > 0
    && Date.now() - snapshot.refreshedAt < USAGE_DASHBOARD_TTL_MS;
}

function failRefresh(win: Window, timedOut: boolean): void {
  if (timedOut) {
    // The underlying host call may still be unresolved. Retiring its generation
    // is what makes the bounded retry safe to start alongside it: a late
    // fulfillment can no longer publish, persist, or clear newer state.
    epoch += 1;
  }
  // The retry belongs to the CURRENT store lifecycle, never to a captured API:
  // with no cadence holder left there is nothing to refresh for.
  const api = cadenceHolders > 0 ? cadenceApi : undefined;
  const retryable = !retryUsed && retryTimer === null
    && typeof api?.invokeCapability === "function";
  if (retryable) {
    retryUsed = true;
    const generation = epoch;
    retryTimer = trackTimeout(win, () => {
      retryTimer = null;
      if (host !== win || epoch !== generation || cadenceHolders === 0) return;
      // cadenceApi is read at FIRE time so a same-window API swap is honoured.
      void refreshUsageDashboard(cadenceApi, { force: true, retry: true });
    }, USAGE_DASHBOARD_RETRY_DELAY_MS);
  }
  // A failed refresh never replaces valid rows: the stale snapshot stands.
  publishStatus(retryable && snapshot.refreshedAt === 0 ? "loading" : settledStatus());
}

function acceptRefresh(win: Window, value: unknown): void {
  const sanitized = sanitizeUsageDashboard(value);
  const stale = rowCount(snapshot.dashboard) > 0;
  if (!sanitized || (rowCount(sanitized) === 0 && stale)) {
    // Malformed, or empty while valid rows are known: keep the stale snapshot
    // and the stored cache untouched, and treat it as a failed refresh.
    failRefresh(win, false);
    return;
  }
  if (retryTimer !== null) clearTracked(win, retryTimer);
  retryTimer = null;
  retryUsed = false;
  writeCache(win, sanitized);
  publish({
    dashboard: sanitized,
    refreshedAt: Date.now(),
    loading: false,
    // A well-formed but empty dashboard is a FINAL answer, not a load state.
    status: rowCount(sanitized) > 0 ? "ready" : "unavailable",
  });
}

function owns(win: Window, id: number, generation: number): boolean {
  return host === win && epoch === generation && pendingId === id;
}

async function runRefresh(
  win: Window,
  api: UsageApi,
  id: number,
  generation: number,
): Promise<void> {
  let result: unknown;
  try {
    result = await withUsageTimeout(
      api.invokeCapability!<unknown>({
        capability: "getUsageDashboard",
        // Refresh provider quotas without repeating the slower keychain/local
        // setup scan on every cadence tick.
        args: [{ refresh: true, refreshSetup: false }],
      }),
      USAGE_DASHBOARD_REQUEST_TIMEOUT_MS,
      win,
    );
  } catch (cause) {
    // A retired generation has no owner: no publish, no cache write, no retry.
    if (!owns(win, id, generation)) return;
    failRefresh(win, (cause as { code?: string } | null)?.code === USAGE_TIMEOUT_CODE);
    return;
  }
  if (!owns(win, id, generation)) return;
  acceptRefresh(win, (result as { value?: unknown } | undefined)?.value);
}

/** One in-flight request for the whole renderer. `force` skips the TTL check
 *  (cadence ticks and retries); everything else is stale-while-revalidate. */
export function refreshUsageDashboard(
  api: UsageApi | undefined,
  { force = false, retry = false }: { force?: boolean; retry?: boolean } = {},
): Promise<void> {
  const win = ensureHost();
  if (pending) return pending;
  if (!win) return Promise.resolve();
  if (typeof api?.invokeCapability !== "function") {
    // This host cannot serve usage at all. Settle the first paint instead of
    // leaving the surface on an indefinite Loading.
    publishStatus(settledStatus());
    return Promise.resolve();
  }
  if (!force && isFresh()) return Promise.resolve();
  if (!retry) retryUsed = false;
  const id = ++requestSequence;
  const generation = epoch;
  pendingId = id;
  const request = runRefresh(win, api, id, generation).finally(() => {
    // Ownership is per REQUEST id: an old finally can never release the pending
    // slot of a newer request, nor one a retirement already cleared.
    if (pendingId !== id) return;
    pendingId = 0;
    pending = null;
    // A pending bounded retry keeps the first paint in loading; nothing else
    // may leave the surface waiting forever.
    if (snapshot.status === "loading" && retryTimer === null) publishStatus(settledStatus());
  });
  pending = request;
  publishStatus(snapshot.refreshedAt > 0 ? "ready" : "loading");
  return request;
}

function scheduleRetirement(): void {
  if (retirementQueued) return;
  retirementQueued = true;
  queueMicrotask(() => {
    retirementQueued = false;
    // A synchronous re-hold (StrictMode's effect replay, a popup toggle) keeps
    // the in-flight request adoptable instead of restarting it. A real teardown
    // drops the cadence, the bounded retry and pending ownership.
    if (cadenceHolders > 0) return;
    stopCadence();
    cadenceApi = undefined;
    retire();
    if (snapshot.status === "loading") publishStatus(settledStatus());
  });
}

/** Keeps the single refresh cadence alive while at least one holder (the always
 *  mounted rail, plus the popup when open) needs it. */
export function holdUsageDashboardCadence(api: UsageApi | undefined): () => void {
  const win = ensureHost();
  cadenceHolders += 1;
  // A same-window API swap (host bridge replaced) becomes the cadence API, so
  // neither the cadence nor the retry can keep a retired bridge alive.
  if (typeof api?.invokeCapability === "function") cadenceApi = api;
  if (win && cadenceTimer === null && typeof cadenceApi?.invokeCapability === "function") {
    cadenceTimer = win.setInterval(
      () => void refreshUsageDashboard(cadenceApi, { force: true }),
      USAGE_DASHBOARD_REFRESH_INTERVAL_MS,
    );
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    cadenceHolders = Math.max(0, cadenceHolders - 1);
    if (cadenceHolders === 0) scheduleRetirement();
  };
}
