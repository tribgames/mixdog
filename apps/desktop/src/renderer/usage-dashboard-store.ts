import type { DesktopApi, SessionSnapshot } from '../shared/contract';
import type { DesktopSectionEntry } from '../shared/contract-sections';
import { readGlobalCapabilities } from './global-capability-reads';
import { currentRemoteConnectionState, subscribeRemoteConnectionState } from './remote-connection-state';
import { sectionStoreFor } from './section-store';
import { usageTimestamp } from './usage-window-text';

export type UsageApi = Partial<
  Pick<DesktopApi, 'invokeCapability' | 'readCapabilities' | 'subscribeState' | 'subscribeSessionState' | 'sections'>
>;
export type UsageRecord = Record<string, unknown>;

/** Lifecycle of the LIVE result, independent of what currently paints:
 *   idle        — nothing requested yet (a stale seed may already paint)
 *   loading     — a request or its bounded retry is outstanding, no live result
 *   ready       — a valid live dashboard was accepted
 *   unavailable — the request path settled without a usable dashboard */
type UsageDashboardStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

export type UsageDashboardSnapshot = {
  dashboard: UsageRecord;
  /** Time of the last accepted LIVE result; 0 while only the seed is known. */
  refreshedAt: number;
  /** Convenience mirror of `status === "loading"`. */
  loading: boolean;
  status: UsageDashboardStatus;
};

export const USAGE_DASHBOARD_CACHE_KEY = 'mixdog.desktop.sidebar-usage.v1';
/** A snapshot younger than this satisfies an open/prewarm without a request. */
const USAGE_DASHBOARD_TTL_MS = 5 * 60_000;
export const USAGE_DASHBOARD_RETRY_DELAY_MS = 15_000;
export const USAGE_DASHBOARD_REQUEST_TIMEOUT_MS = 30_000;
export const USAGE_RESET_SETTLE_DELAY_MS = 2_000;
export const USAGE_RESET_FOLLOWUP_DELAYS_MS = [5_000, 15_000, 30_000] as const;
const MAX_RESET_TRANSPORT_RETRIES = 1;
const MAX_RESET_TIMER_DELAY_MS = 24 * 86_400_000;

export type UsageResetVerificationState = {
  failedWindowKeys: ReadonlySet<string>;
  verifyingWindowKeys: ReadonlySet<string>;
};

type DashboardResetWindow = {
  key: string;
  provider: string;
  resetAt: number;
  updatedAt: number | null;
};

type ElapsedResetState = {
  provider: string;
  attempts: number;
  retryAttempts: number;
  nextDueAt: number | null;
  failedAt: number | null;
  status: 'waiting' | 'verifying' | 'transport-failed' | 'exhausted';
};

type DueResetWindow = {
  window: DashboardResetWindow;
  dueAt: number;
  attempts: number;
};

type RefreshOutcome = {
  id: number;
  failed: boolean;
  suppressOrdinaryRetry: boolean;
  chargedTransportKeys: string[];
  adoptedDue: DueResetWindow[];
};

type RetryScopeState = {
  provider: string | null;
  retryUsed: boolean;
  failedAt: number;
  dueAt: number | null;
  baselineUpdatedAt: number | null;
  forAuth: boolean;
};

type ProviderPublication = {
  seq: number;
  committedAt: number;
  unresolvedPreFailure: boolean;
  protectedWindowKeys: Set<string>;
};

const ALL_RETRY_SCOPE = '*';

const EMPTY_RESET_VERIFICATION_STATE: UsageResetVerificationState = {
  failedWindowKeys: new Set(),
  verifyingWindowKeys: new Set(),
};

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
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const USAGE_TIMEOUT_CODE = 'usage-timeout';

type Listener = (snapshot: UsageDashboardSnapshot) => void;

const EMPTY_SNAPSHOT: UsageDashboardSnapshot = {
  dashboard: {},
  refreshedAt: 0,
  loading: false,
  status: 'idle',
};

let host: Window | null = null;
let hostGeneration = 0;
let snapshot: UsageDashboardSnapshot = EMPTY_SNAPSHOT;
let listeners = new Set<Listener>();
let epoch = 0;
let fullRetireGeneration = 0;
let requestSequence = 0;
let pending: Promise<void> | null = null;
let pendingWaiter: Promise<boolean> | null = null;
let releasePendingWaiter: ((retired: boolean) => void) | null = null;
let pendingId = 0;
let pendingStartedAt = 0;
let pendingProviders: ReadonlySet<string> | null = null;
let pendingRawProviders: readonly string[] | undefined;
let pendingIsRetry = false;
let pendingForAuth = false;
let pendingOutcome: RefreshOutcome | null = null;
let retryTimer: number | null = null;
let retryTimerGeneration = 0;
const retryStates = new Map<string, RetryScopeState>();
let resetTimer: number | null = null;
let resetTimerGeneration = 0;
let resetRefreshSequence = 0;
let activeResetRefreshId = 0;
let resetVerificationState: UsageResetVerificationState = EMPTY_RESET_VERIFICATION_STATE;
let resetVerificationListeners = new Set<() => void>();
const elapsedResetState = new Map<string, ElapsedResetState>();
const inFlightResetKeys = new Set<string>();
let publishSeq = 0;
const providerPublished = new Map<string, ProviderPublication>();
let cadenceHolders = 0;
let releaseCadence: (() => void) | null = null;
let releaseReconnectRetry: (() => void) | null = null;
let releaseVisibilitySync: (() => void) | null = null;
let cadenceApi: UsageApi | undefined;
let accountChangesApi: UsageApi | undefined;
let releaseAccountChanges: (() => void) | null = null;
const latestAccountChanges = new Map<string, { accountId: string; at: number }>();
let accountSwitchListeners = new Set<(provider: string) => void>();
let retirementQueued = false;
const timers = new Set<number>();
/** Providers whose shown row is a timed reading this document accepted live. A credential change drops the provider:
 *  another account's reading is not ordered against the one shown. */
const orderedReadings = new Set<string>();

function scalarValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, MAX_STRING_LENGTH);
  return undefined;
}

/** Scalar-only copy: nested objects, arrays, functions and prototype keys are
 *  dropped, so nothing unbounded can be serialized into localStorage. */
function scalarRecord(value: unknown, maxKeys: number): UsageRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
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
  const credits = scalarRecord(source.credits, MAX_CREDIT_KEYS);
  if (credits) row.credits = credits;
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
    return sanitizeUsageDashboard(JSON.parse(win.localStorage.getItem(USAGE_DASHBOARD_CACHE_KEY) || 'null')) || {};
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

/** The host can read the usage dashboard through one of its capability paths. */
function canReadUsage(api: UsageApi | undefined): api is UsageApi {
  return typeof api?.invokeCapability === 'function' || typeof api?.readCapabilities === 'function';
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

function clearResetTimer(win: Window | null): void {
  resetTimerGeneration += 1;
  if (resetTimer === null) return;
  clearTracked(win, resetTimer);
  resetTimer = null;
}

function clearRetryTimer(win: Window | null): void {
  retryTimerGeneration += 1;
  if (retryTimer === null) return;
  clearTracked(win, retryTimer);
  retryTimer = null;
}

function clearPendingTimers(win: Window | null): void {
  for (const handle of [...timers]) {
    if (handle !== resetTimer && handle !== retryTimer) clearTracked(win, handle);
  }
}

function clearTimers(): void {
  resetTimerGeneration += 1;
  retryTimerGeneration += 1;
  for (const handle of [...timers]) clearTracked(host, handle);
  timers.clear();
  retryTimer = null;
  resetTimer = null;
}

function stopCadence(): void {
  const release = releaseCadence;
  releaseCadence = null;
  clearResetTimer(host);
  clearRetryTimer(host);
  releaseReconnectRetry?.();
  releaseReconnectRetry = null;
  releaseVisibilitySync?.();
  releaseVisibilitySync = null;
  releaseAccountChanges?.();
  releaseAccountChanges = null;
  accountChangesApi = undefined;
  try {
    release?.();
  } catch {
    // A retired window already dropped its timers.
  }
}

function settlePendingWaiter(retired: boolean): void {
  const settle = releasePendingWaiter;
  pendingWaiter = null;
  releasePendingWaiter = null;
  settle?.(retired);
}

/** Retires only the in-flight request and its timeout timer without wiping
 *  unrelated providers' armed retries or scheduled reset timers. */
function retireInFlight(win: Window | null): void {
  epoch += 1;
  pending = null;
  pendingId = 0;
  pendingStartedAt = 0;
  pendingProviders = null;
  pendingRawProviders = undefined;
  pendingIsRetry = false;
  pendingForAuth = false;
  pendingOutcome = null;
  activeResetRefreshId = 0;
  inFlightResetKeys.clear();
  clearPendingTimers(win);
  settlePendingWaiter(true);
}

/** Retires the current generation: pending ownership, tracked timers and all
 *  bounded retries are dropped, and any late response is ignored. */
function retire(): void {
  epoch += 1;
  fullRetireGeneration += 1;
  pending = null;
  pendingId = 0;
  pendingStartedAt = 0;
  pendingProviders = null;
  pendingRawProviders = undefined;
  pendingIsRetry = false;
  pendingForAuth = false;
  pendingOutcome = null;
  retryStates.clear();
  activeResetRefreshId = 0;
  inFlightResetKeys.clear();
  clearTimers();
  settlePendingWaiter(true);
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function publishResetVerificationState(now = Date.now()): void {
  const nextVerifying = new Set<string>();
  const nextFailed = new Set<string>();
  for (const window of dashboardResetWindows(snapshot.dashboard)) {
    if (window.resetAt > now) continue;
    const entry = elapsedResetState.get(window.key);
    if (inFlightResetKeys.has(window.key) || entry?.status === 'verifying') {
      nextVerifying.add(window.key);
    } else if (entry?.status === 'exhausted' || entry?.status === 'transport-failed') {
      nextFailed.add(window.key);
    }
  }
  if (
    setsEqual(resetVerificationState.failedWindowKeys, nextFailed) &&
    setsEqual(resetVerificationState.verifyingWindowKeys, nextVerifying)
  ) {
    return;
  }
  resetVerificationState = {
    failedWindowKeys: nextFailed,
    verifyingWindowKeys: nextVerifying,
  };
  for (const listener of [...resetVerificationListeners]) listener();
}

function clearResetTracking(): void {
  elapsedResetState.clear();
  inFlightResetKeys.clear();
  publishResetVerificationState();
}

function clearResetTrackingForProviders(providers: ReadonlySet<string>): void {
  for (const [key, entry] of [...elapsedResetState]) {
    if (providerInScope(entry.provider, providers)) elapsedResetState.delete(key);
  }
  publishResetVerificationState();
}

/** Rebinds the store when a different document owns the renderer (reload, or a
 *  fresh test DOM): the retired window's storage, timers and subscribers can
 *  never be adopted by the new one. */
function ensureHost(): Window | null {
  const active = typeof window === 'undefined' ? null : window;
  if (active === host) return active;
  retire();
  stopCadence();
  cadenceHolders = 0;
  cadenceApi = undefined;
  resetRefreshSequence = 0;
  activeResetRefreshId = 0;
  elapsedResetState.clear();
  inFlightResetKeys.clear();
  resetVerificationState = EMPTY_RESET_VERIFICATION_STATE;
  resetVerificationListeners = new Set();
  latestAccountChanges.clear();
  orderedReadings.clear();
  publishSeq = 0;
  providerPublished.clear();
  listeners = new Set();
  accountSwitchListeners = new Set();
  host = active;
  hostGeneration += 1;
  snapshot = active ? { dashboard: readCache(active), refreshedAt: 0, loading: false, status: 'idle' } : EMPTY_SNAPSHOT;
  return active;
}

function publish(next: UsageDashboardSnapshot): void {
  // Identity is the subscription contract (useSyncExternalStore): only a real
  // change may produce a new object.
  if (
    next.dashboard === snapshot.dashboard &&
    next.refreshedAt === snapshot.refreshedAt &&
    next.loading === snapshot.loading &&
    next.status === snapshot.status
  )
    return;
  snapshot = next;
  for (const listener of [...listeners]) listener(snapshot);
}

function publishStatus(status: UsageDashboardStatus): void {
  publish({ ...snapshot, status, loading: status === 'loading' });
}

/** Settled status when no request is outstanding: a live result keeps the
 *  surface ready, otherwise the first paint reaches a FINAL unavailable state
 *  instead of announcing loading forever. */
function settledStatus(): UsageDashboardStatus {
  return snapshot.refreshedAt > 0 ? 'ready' : 'unavailable';
}

export function withUsageTimeout<T>(promise: Promise<T>, delayMs: number, win: Window): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = trackTimeout(
      win,
      () => {
        const error = new Error('Subscription usage refresh timed out.') as Error & { code?: string };
        error.code = USAGE_TIMEOUT_CODE;
        reject(error);
      },
      delayMs
    );
    promise.then(
      (value) => {
        clearTracked(win, timer);
        resolve(value);
      },
      (reason) => {
        clearTracked(win, timer);
        reject(reason);
      }
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

export function getUsageResetVerificationState(): UsageResetVerificationState {
  ensureHost();
  return resetVerificationState;
}

export function subscribeUsageResetVerification(listener: () => void): () => void {
  ensureHost();
  resetVerificationListeners.add(listener);
  const owner = resetVerificationListeners;
  return () => {
    owner.delete(listener);
  };
}

function hasInFlightResetOutsideScope(providerScope: ReadonlySet<string>): boolean {
  for (const window of dashboardResetWindows(snapshot.dashboard)) {
    if (inFlightResetKeys.has(window.key) && !providerInScope(window.provider, providerScope)) return true;
  }
  return false;
}

function publicationReadAt(
  dashboard: UsageRecord,
  readStartedAt: number | undefined,
  providerScope: ReadonlySet<string> | null
): number | null {
  if (readStartedAt !== undefined) return readStartedAt;
  const checkedAt = dashboardCheckedAt(dashboard);
  let newestRowAt: number | null = null;
  for (const row of dashboardRows(dashboard)) {
    const provider = usageResetRowProvider(row, '');
    if (provider && !providerInScope(provider, providerScope)) continue;
    const at = readingTime(row);
    if (at !== null && at > 0 && (newestRowAt === null || at > newestRowAt)) newestRowAt = at;
  }
  if (newestRowAt !== null) return checkedAt !== null ? Math.min(newestRowAt, checkedAt) : newestRowAt;
  return checkedAt;
}

/** Adopts a dashboard produced by a mutation as a live response and retires any
 *  in-flight refresh. Returns false when the payload is not a usable dashboard. */
export function publishUsageDashboard(
  dashboard: unknown,
  options?: {
    readStartedAt?: number;
    providers?: readonly string[];
  }
): boolean {
  const win = ensureHost();
  if (!win) return false;
  const sanitized = sanitizeUsageDashboard(dashboard);
  if (!sanitized || rowCount(sanitized) === 0) return false;
  const providerScope = normalizeProviderScope(options?.providers);
  const pubReadAt = publicationReadAt(sanitized, options?.readStartedAt, providerScope);
  const olderThanPending = pending !== null && pubReadAt !== null && pubReadAt < pendingStartedAt;
  const preservePending =
    olderThanPending ||
    (activeResetRefreshId !== 0 && providerScope !== null && hasInFlightResetOutsideScope(providerScope));
  const now = Date.now();
  if (!preservePending) {
    if (providerScope !== null) preserveUncoveredInFlight(providerScope, now);
    retireInFlight(win);
  }
  const { dashboard: nextDashboard, preservedProviders } =
    preservePending || options?.readStartedAt !== undefined || providerScope !== null
      ? keepNewerReadings(sanitized, {
          source: 'publish',
          providerScope,
          preserveWhenUnmeasured: preservePending,
        })
      : { dashboard: sanitized, preservedProviders: new Set<string>() };
  const publishedAt = options?.readStartedAt !== undefined ? Math.min(options.readStartedAt, now) : now;
  writeCache(win, nextDashboard);
  publish({ dashboard: nextDashboard, refreshedAt: now, loading: false, status: 'ready' });
  noteReadings(nextDashboard);
  reconcileElapsedResetsAfterAccept(
    nextDashboard,
    dashboardResetWindows(nextDashboard),
    options?.readStartedAt,
    now,
    providerScope,
    preservedProviders
  );
  noteCommittedPublications(nextDashboard, now, options?.readStartedAt, providerScope, preservedProviders);
  reconcilePendingRetries(win, nextDashboard, publishedAt, providerScope, preservedProviders);
  publishResetVerificationState(now);
  if (activeResetRefreshId === 0) syncResetRefresh(win);
  return true;
}

/** Hears every switch of a provider's account in use — automatic or picked
 *  by hand — so subscription usage can follow it to the new account. */
export function subscribeAccountSwitches(listener: (provider: string) => void): () => void {
  ensureHost();
  accountSwitchListeners.add(listener);
  const owner = accountSwitchListeners;
  return () => {
    owner.delete(listener);
  };
}

/** Replaces the provider's meters with the newly selected account's last-known
 *  quota windows, or with a check in progress when none are recorded. Reset
 *  credits and other quota fields of the old account are dropped; `refreshedAt`
 *  does not advance. */
export function applyAccountUsageWindows(provider: string, windows: unknown): boolean {
  const win = ensureHost();
  if (!win) return false;
  const id = String(provider || '');
  if (id) {
    orderedReadings.delete(id);
    providerPublished.delete(providerKey(id));
    for (const listener of [...accountSwitchListeners]) listener(id);
  }
  const rows = Array.isArray(snapshot.dashboard.rows) ? (snapshot.dashboard.rows as UsageRecord[]) : [];
  const index = rows.findIndex((row) => String(row?.id || '') === id);
  if (!id || index < 0) return false;
  const accountWindows = scalarRecordList(windows, MAX_WINDOWS, MAX_WINDOW_KEYS);
  const dashboard: UsageRecord = {
    ...snapshot.dashboard,
    rows: rows.map((row, position) =>
      position === index
        ? {
            id: row.id,
            label: row.label,
            group: row.group,
            authenticated: row.authenticated,
            windows: accountWindows,
            status: 'checking',
            updatedAt: null,
          }
        : row
    ),
  };
  writeCache(win, dashboard);
  publish({ ...snapshot, dashboard });
  providerPublished.set(providerKey(id), {
    seq: ++publishSeq,
    committedAt: Date.now(),
    unresolvedPreFailure: false,
    protectedWindowKeys: new Set(),
  });
  return true;
}

/** An unsuccessful check must settle without restoring another account's
 *  quotas or leaving its replacement on an indefinite loading message. */
function finishUsageChecks(win: Window): void {
  const rows = snapshot.dashboard.rows as UsageRecord[] | undefined;
  if (!rows?.some((row) => row.status === 'checking')) return;
  const dashboard: UsageRecord = {
    ...snapshot.dashboard,
    rows: rows.map((row) => {
      if (row.status !== 'checking') return row;
      const status = Array.isArray(row.windows) && row.windows.length > 0 ? 'partial' : 'unavailable';
      return { ...row, status };
    }),
  };
  writeCache(win, dashboard);
  publish({ ...snapshot, dashboard });
}

export function usageResetRowProvider(row: UsageRecord, fallback: string): string {
  return String(row.id || row.label || fallback).trim() || fallback;
}

export function usageResetRowAccount(row: UsageRecord): string {
  return accountOf(row) ?? (typeof row.accountId === 'string' ? row.accountId.trim() : '');
}

export function usageResetWindowKeys(windows: readonly UsageRecord[], provider: string, account = ''): string[] {
  const normalizedProvider = provider.trim();
  const normalizedAccount = account.trim();
  const seenLabels = new Map<string, number>();
  return windows.map((window, winIndex) => {
    const base =
      String(window.id || window.window || window.period || window.label || `window:${winIndex}`)
        .trim()
        .toLowerCase() || `window:${winIndex}`;
    const occ = seenLabels.get(base) ?? 0;
    seenLabels.set(base, occ + 1);
    return `${normalizedProvider}\u001f${normalizedAccount}\u001f${base}\u001f${occ}`;
  });
}

function providerKey(provider: string): string {
  return provider.trim().toLowerCase();
}

function normalizeProviderScope(providers: readonly string[] | undefined): ReadonlySet<string> | null {
  if (!providers?.length) return null;
  const scope = new Set<string>();
  for (const provider of providers) {
    const normalized = providerKey(provider);
    if (normalized) scope.add(normalized);
  }
  return scope.size > 0 ? scope : null;
}

function providerInScope(provider: string, scope: ReadonlySet<string> | null): boolean {
  return scope === null || scope.has(providerKey(provider));
}

function dashboardCheckedAt(dashboard: UsageRecord): number | null {
  return typeof dashboard.checkedAt === 'number' && Number.isFinite(dashboard.checkedAt) && dashboard.checkedAt > 0
    ? dashboard.checkedAt
    : null;
}

function serializeSectionValue(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

function dashboardResetWindows(dashboard: UsageRecord): DashboardResetWindow[] {
  const out: DashboardResetWindow[] = [];
  const rows = dashboardRows(dashboard);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const windows = Array.isArray(row.windows) ? (row.windows as UsageRecord[]) : [];
    const provider = usageResetRowProvider(row, `row:${rowIndex}`);
    const account = usageResetRowAccount(row);
    const updatedAt = readingTime(row);
    const keys = usageResetWindowKeys(windows, provider, account);
    for (let winIndex = 0; winIndex < windows.length; winIndex += 1) {
      const resetAt = usageTimestamp(windows[winIndex]?.resetAt);
      if (resetAt === null) continue;
      out.push({
        key: keys[winIndex],
        provider,
        resetAt,
        updatedAt,
      });
    }
  }
  return out;
}

function pruneResetTracking(windows: readonly DashboardResetWindow[], now: number): void {
  const activeElapsed = new Set(windows.filter((window) => window.resetAt <= now).map((window) => window.key));
  for (const key of [...elapsedResetState.keys()]) {
    if (!activeElapsed.has(key)) elapsedResetState.delete(key);
  }
}

function reconcileElapsedResetsAfterAccept(
  dashboard: UsageRecord,
  windows: readonly DashboardResetWindow[],
  readStartedAt: number | undefined,
  now: number,
  providerScope: ReadonlySet<string> | null = null,
  preservedProviders?: ReadonlySet<string>
): void {
  pruneResetTracking(windows, now);
  const checkedAt = dashboardCheckedAt(dashboard);
  for (const window of windows) {
    if (window.resetAt > now) continue;
    if (!providerInScope(window.provider, providerScope)) continue;
    if (preservedProviders?.has(providerKey(window.provider))) continue;
    const rowUpdatedAt = window.updatedAt !== null && window.updatedAt > 0 ? window.updatedAt : null;
    const windowReadAt =
      readStartedAt !== undefined
        ? Math.min(readStartedAt, now)
        : rowUpdatedAt !== null
          ? Math.min(rowUpdatedAt, checkedAt ?? now, now)
          : checkedAt !== null
            ? Math.min(checkedAt, now)
            : now;
    const entry = elapsedResetState.get(window.key);
    if (!entry) {
      const settleAt = window.resetAt + USAGE_RESET_SETTLE_DELAY_MS;
      if (windowReadAt >= settleAt) {
        elapsedResetState.set(window.key, {
          provider: window.provider,
          attempts: 1,
          retryAttempts: 0,
          nextDueAt: now + USAGE_RESET_FOLLOWUP_DELAYS_MS[0],
          failedAt: null,
          status: 'verifying',
        });
      } else {
        elapsedResetState.set(window.key, {
          provider: window.provider,
          attempts: 0,
          retryAttempts: 0,
          nextDueAt: settleAt,
          failedAt: null,
          status: 'waiting',
        });
      }
      continue;
    }

    if (entry.status === 'exhausted') continue;

    if (entry.status === 'transport-failed') {
      const minReadAt = entry.failedAt ?? window.resetAt + USAGE_RESET_SETTLE_DELAY_MS;
      if (windowReadAt < minReadAt) continue;
      const nextAttempts = entry.attempts + 1;
      entry.failedAt = null;
      entry.retryAttempts = 0;
      if (nextAttempts > USAGE_RESET_FOLLOWUP_DELAYS_MS.length) {
        entry.attempts = nextAttempts;
        entry.nextDueAt = null;
        entry.status = 'exhausted';
      } else {
        entry.attempts = nextAttempts;
        entry.nextDueAt = now + USAGE_RESET_FOLLOWUP_DELAYS_MS[nextAttempts - 1];
        entry.status = 'verifying';
      }
      continue;
    }

    if (entry.nextDueAt !== null && windowReadAt >= entry.nextDueAt) {
      const nextAttempts = entry.attempts + 1;
      if (nextAttempts > USAGE_RESET_FOLLOWUP_DELAYS_MS.length) {
        entry.attempts = nextAttempts;
        entry.nextDueAt = null;
        entry.status = 'exhausted';
      } else {
        entry.attempts = nextAttempts;
        entry.nextDueAt = now + USAGE_RESET_FOLLOWUP_DELAYS_MS[nextAttempts - 1];
        entry.status = 'verifying';
      }
    }
  }
}

function isSchedulableTransportRetry(entry: ElapsedResetState): boolean {
  return (
    entry.status === 'transport-failed' && entry.retryAttempts < MAX_RESET_TRANSPORT_RETRIES && entry.nextDueAt !== null
  );
}

function resetDueAt(window: DashboardResetWindow): number {
  const entry = elapsedResetState.get(window.key);
  return entry?.nextDueAt ?? window.resetAt + USAGE_RESET_SETTLE_DELAY_MS;
}

function isDueForResetRefresh(window: DashboardResetWindow, now: number, hidden: boolean): boolean {
  if (window.resetAt > now) return false;
  const entry = elapsedResetState.get(window.key);
  if (!entry) return now >= window.resetAt + USAGE_RESET_SETTLE_DELAY_MS;
  if (entry.status === 'exhausted') return false;
  if (entry.status === 'transport-failed') {
    return !hidden && isSchedulableTransportRetry(entry) && entry.nextDueAt !== null && now >= entry.nextDueAt;
  }
  return entry.nextDueAt !== null && now >= entry.nextDueAt;
}

function dueResetWindows(now: number, hidden: boolean): DueResetWindow[] {
  const out: DueResetWindow[] = [];
  for (const window of dashboardResetWindows(snapshot.dashboard)) {
    if (!isDueForResetRefresh(window, now, hidden)) continue;
    out.push({
      window,
      dueAt: resetDueAt(window),
      attempts: elapsedResetState.get(window.key)?.attempts ?? 0,
    });
  }
  return out;
}

function chargeDispatchedTransportRetries(
  due: readonly DueResetWindow[],
  requestStartedAt: number,
  requestProviders: ReadonlySet<string> | null
): string[] {
  const charged: string[] = [];
  for (const { window, dueAt } of due) {
    if (dueAt > requestStartedAt || !providerInScope(window.provider, requestProviders)) continue;
    const entry = elapsedResetState.get(window.key);
    if (!entry || !isSchedulableTransportRetry(entry)) continue;
    entry.retryAttempts += 1;
    entry.nextDueAt = null;
    charged.push(window.key);
  }
  return charged;
}

function markTransportFailedWindows(
  due: readonly DueResetWindow[],
  requestStartedAt: number,
  requestProviders: ReadonlySet<string> | null,
  afterNow: number
): void {
  const currentByKey = new Map(dashboardResetWindows(snapshot.dashboard).map((window) => [window.key, window]));
  for (const { window, dueAt, attempts } of due) {
    if (dueAt > requestStartedAt || !providerInScope(window.provider, requestProviders)) continue;
    const current = currentByKey.get(window.key);
    if (!current || current.resetAt > afterNow) {
      elapsedResetState.delete(window.key);
      continue;
    }
    const existing = elapsedResetState.get(window.key);
    if (
      existing !== undefined &&
      (existing.status === 'exhausted' ||
        existing.attempts > attempts ||
        (existing.nextDueAt !== null && existing.nextDueAt > dueAt))
    ) {
      continue;
    }
    const nextRetryAttempts = existing?.status === 'transport-failed' ? existing.retryAttempts : 0;
    const failedAt = Math.max(dueAt, afterNow);
    elapsedResetState.set(window.key, {
      provider: window.provider,
      attempts: existing?.attempts ?? attempts,
      retryAttempts: nextRetryAttempts,
      nextDueAt: nextRetryAttempts < MAX_RESET_TRANSPORT_RETRIES ? failedAt + USAGE_DASHBOARD_RETRY_DELAY_MS : null,
      failedAt,
      status: 'transport-failed',
    });
  }
}

function promoteTransportRetriesNow(now: number): boolean {
  let promoted = false;
  for (const window of dashboardResetWindows(snapshot.dashboard)) {
    if (window.resetAt > now) continue;
    const entry = elapsedResetState.get(window.key);
    if (entry && isSchedulableTransportRetry(entry)) {
      entry.nextDueAt = now;
      promoted = true;
    }
  }
  return promoted;
}

function isProviderRetryHeld(provider: string, now: number): boolean {
  if (isScopeEntryHeld(retryStates.get(ALL_RETRY_SCOPE), now)) return true;
  const key = providerKey(provider);
  return key.length > 0 && isScopeEntryHeld(retryStates.get(key), now);
}

function hasDueElapsedReset(now = Date.now(), providerScope: ReadonlySet<string> | null = null): boolean {
  for (const window of dashboardResetWindows(snapshot.dashboard)) {
    if (window.resetAt > now) continue;
    if (!providerInScope(window.provider, providerScope)) continue;
    if (isProviderRetryHeld(window.provider, now)) continue;
    const entry = elapsedResetState.get(window.key);
    if (!entry) {
      if (cadenceHolders === 0 || window.resetAt + USAGE_RESET_SETTLE_DELAY_MS <= now) return true;
      continue;
    }
    if (entry.status === 'exhausted') continue;
    if (entry.status === 'transport-failed') {
      if (isSchedulableTransportRetry(entry) && entry.nextDueAt !== null && entry.nextDueAt <= now) return true;
      continue;
    }
    if (entry.nextDueAt !== null && entry.nextDueAt <= now) return true;
  }
  return false;
}

function hasElapsedResetHold(now = Date.now()): boolean {
  for (const window of dashboardResetWindows(snapshot.dashboard)) {
    if (window.resetAt > now) continue;
    const entry = elapsedResetState.get(window.key);
    if (!entry) {
      if (cadenceHolders > 0 && window.resetAt + USAGE_RESET_SETTLE_DELAY_MS > now) return true;
      continue;
    }
    if (entry.status === 'exhausted') continue;
    if (entry.status === 'transport-failed') {
      if (!isSchedulableTransportRetry(entry) || (entry.nextDueAt !== null && entry.nextDueAt > now)) return true;
      continue;
    }
    if (entry.nextDueAt !== null && entry.nextDueAt > now) return true;
  }
  return false;
}

function isScopeEntryHeld(entry: RetryScopeState | undefined, now: number): boolean {
  return entry !== undefined && (entry.dueAt === null || entry.dueAt > now);
}

function unheldDashboardProviders(now: number): string[] | null {
  const rows = dashboardRows(snapshot.dashboard);
  if (rows.length === 0) return null;
  let anyHeld = false;
  const unheld: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.authenticated === false) continue;
    const raw = typeof row.id === 'string' && row.id ? row.id : usageResetRowProvider(row, '');
    const key = providerKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (isScopeEntryHeld(retryStates.get(key), now)) {
      anyHeld = true;
    } else {
      unheld.push(raw);
    }
  }
  return anyHeld ? unheld : null;
}

function hasOrdinaryTransportHold(providerScope: ReadonlySet<string> | null, now = Date.now()): boolean {
  if (isScopeEntryHeld(retryStates.get(ALL_RETRY_SCOPE), now)) {
    return true;
  }
  if (providerScope !== null) {
    for (const key of providerScope) {
      if (!isScopeEntryHeld(retryStates.get(key), now)) return false;
    }
    return true;
  }
  const unheld = unheldDashboardProviders(now);
  return unheld !== null && unheld.length === 0;
}

function isFresh(providerScope: ReadonlySet<string> | null = null): boolean {
  const now = Date.now();
  if (
    rowCount(snapshot.dashboard) === 0 ||
    (snapshot.dashboard.rows as UsageRecord[]).some((row) => row.status === 'checking')
  ) {
    return false;
  }
  if (hasOrdinaryTransportHold(providerScope, now)) return true;
  if (hasDueElapsedReset(now, providerScope)) return false;
  if (hasElapsedResetHold(now)) return true;
  if (snapshot.refreshedAt <= 0) return false;
  return now - snapshot.refreshedAt < USAGE_DASHBOARD_TTL_MS;
}

async function runResetRefresh(win: Window, timerGeneration: number): Promise<void> {
  if (host !== win || resetTimerGeneration !== timerGeneration || cadenceHolders === 0 || !canReadUsage(cadenceApi))
    return;
  const now = Date.now();
  const hidden = win.document?.visibilityState === 'hidden';
  let due = dueResetWindows(now, hidden);
  if (due.length === 0) {
    syncResetRefresh(win);
    return;
  }

  const refreshId = ++resetRefreshSequence;
  activeResetRefreshId = refreshId;
  let wasRetired = false;
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      inFlightResetKeys.clear();
      for (const { window } of due) inFlightResetKeys.add(window.key);
      publishResetVerificationState(Date.now());

      let waitedForScoped = false;
      while (pending !== null && !scopeCovers(pendingProviders, null)) {
        waitedForScoped = true;
        const waitFor = pendingWaiter ?? pending.then(() => false);
        await waitFor;
        wasRetired = host !== win || activeResetRefreshId !== refreshId;
        if (wasRetired || cadenceHolders === 0 || !canReadUsage(cadenceApi)) return;
      }
      if (waitedForScoped) {
        const recheckNow = Date.now();
        due = dueResetWindows(recheckNow, win.document?.visibilityState === 'hidden');
        if (due.length === 0) break;
        inFlightResetKeys.clear();
        for (const { window } of due) inFlightResetKeys.add(window.key);
        publishResetVerificationState(recheckNow);
      }

      const adoptedExisting = pending !== null;
      const request = startUsageRefresh(cadenceApi, { force: true, fromReset: true });
      const outcome = pendingOutcome;
      const requestStartedAt = pendingStartedAt || Date.now();
      const requestProviders = pendingProviders;
      if (outcome) {
        const charged = chargeDispatchedTransportRetries(due, requestStartedAt, requestProviders);
        if (charged.length > 0) outcome.chargedTransportKeys.push(...charged);
        if (
          charged.length > 0 ||
          (adoptedExisting && requestProviders === null && due.some(({ dueAt }) => dueAt <= requestStartedAt))
        ) {
          outcome.suppressOrdinaryRetry = true;
        }
      }
      await request;

      wasRetired = host !== win || activeResetRefreshId !== refreshId;
      if (wasRetired) return;

      const afterNow = Date.now();
      if (outcome?.failed) {
        markTransportFailedWindows(due, requestStartedAt, requestProviders, afterNow);
      }

      const hasUncoveredDue =
        adoptedExisting &&
        due.some(
          ({ window, dueAt }) => dueAt > requestStartedAt || !providerInScope(window.provider, requestProviders)
        );
      if (!hasUncoveredDue || cadenceHolders === 0 || !canReadUsage(cadenceApi)) break;

      due = dueResetWindows(afterNow, win.document?.visibilityState === 'hidden');
      if (due.length === 0) break;
    }
  } finally {
    wasRetired = host !== win || activeResetRefreshId !== refreshId;
    if (activeResetRefreshId === refreshId) {
      activeResetRefreshId = 0;
      inFlightResetKeys.clear();
    }
  }
  if (wasRetired) return;

  const afterNow = Date.now();
  pruneResetTracking(dashboardResetWindows(snapshot.dashboard), afterNow);
  publishResetVerificationState(afterNow);
  syncResetRefresh(win);
}

function syncResetRefresh(win: Window): void {
  clearResetTimer(win);
  if (host !== win || cadenceHolders === 0 || !canReadUsage(cadenceApi) || activeResetRefreshId !== 0) return;
  const now = Date.now();
  const hidden = win.document?.visibilityState === 'hidden';
  const windows = dashboardResetWindows(snapshot.dashboard);
  pruneResetTracking(windows, now);
  publishResetVerificationState(now);

  let soonestDelay: number | null = null;
  const consider = (delay: number) => {
    if (soonestDelay === null || delay < soonestDelay) soonestDelay = delay;
  };

  for (const window of windows) {
    if (window.resetAt > now) {
      const targetDelay = window.resetAt - now + USAGE_RESET_SETTLE_DELAY_MS;
      consider(Math.min(targetDelay, MAX_RESET_TIMER_DELAY_MS));
      continue;
    }

    const entry = elapsedResetState.get(window.key);
    if (!entry) {
      consider(Math.min(Math.max(0, window.resetAt + USAGE_RESET_SETTLE_DELAY_MS - now), MAX_RESET_TIMER_DELAY_MS));
    } else if (entry.status === 'exhausted') {
    } else if (entry.status === 'transport-failed') {
      if (!hidden && isSchedulableTransportRetry(entry) && entry.nextDueAt !== null) {
        consider(Math.min(Math.max(0, entry.nextDueAt - now), MAX_RESET_TIMER_DELAY_MS));
      }
    } else if (entry.nextDueAt !== null) {
      consider(Math.min(Math.max(0, entry.nextDueAt - now), MAX_RESET_TIMER_DELAY_MS));
    }
  }

  if (soonestDelay === null) return;
  const timerGeneration = resetTimerGeneration;
  resetTimer = trackTimeout(
    win,
    () => {
      if (resetTimerGeneration !== timerGeneration) return;
      resetTimer = null;
      if (host !== win || cadenceHolders === 0) return;
      void runResetRefresh(win, timerGeneration);
    },
    soonestDelay
  );
}

function hasPendingRetry(): boolean {
  for (const entry of retryStates.values()) {
    if (entry.dueAt !== null) return true;
  }
  return false;
}

function providerUpdatedAt(provider: string): number | null {
  const target = providerKey(provider);
  for (const row of dashboardRows(snapshot.dashboard)) {
    if (providerKey(usageResetRowProvider(row, '')) === target) return readingTime(row);
  }
  return null;
}

function dispatchDueRetries(win: Window, now = Date.now()): boolean {
  if (host !== win || cadenceHolders === 0 || !canReadUsage(cadenceApi)) return false;
  if (win.document?.visibilityState === 'hidden') return false;
  if (pending !== null) return false;
  const dueEntries: [string, RetryScopeState][] = [];
  for (const pair of retryStates) {
    if (pair[1].dueAt !== null && pair[1].dueAt <= now) dueEntries.push(pair);
  }
  if (dueEntries.length === 0) return false;
  const hasGlobal = dueEntries.some(([key]) => key === ALL_RETRY_SCOPE);
  let batch = dueEntries;
  if (!hasGlobal) {
    const authEntries = dueEntries.filter(([, entry]) => entry.forAuth);
    if (authEntries.length > 0 && authEntries.length < dueEntries.length) {
      batch = authEntries;
    }
  }
  const providers = hasGlobal
    ? undefined
    : batch.map(([, entry]) => entry.provider).filter((provider): provider is string => provider !== null);
  const allRetries = hasGlobal
    ? batch.some(([key, entry]) => key === ALL_RETRY_SCOPE && entry.retryUsed)
    : batch.every(([, entry]) => entry.retryUsed);
  const forAuth = hasGlobal
    ? batch.some(([key, entry]) => key === ALL_RETRY_SCOPE && entry.forAuth)
    : batch.every(([, entry]) => entry.forAuth);
  for (const [, entry] of batch) {
    entry.dueAt = null;
  }
  void startUsageRefresh(cadenceApi, { force: true, retry: allRetries, providers, forAuth });
  return true;
}

function syncRetryTimer(win: Window): void {
  clearRetryTimer(win);
  if (host !== win || cadenceHolders === 0) return;
  if (win.document?.visibilityState === 'hidden') return;
  const api = cadenceApi;
  if (!canReadUsage(api)) return;
  const now = Date.now();
  if (pending === null && dispatchDueRetries(win, now)) {
    // Dispatched due retry; re-check whether later entries still need a timer.
  }
  let soonestDueAt: number | null = null;
  for (const entry of retryStates.values()) {
    if (entry.dueAt === null) continue;
    if (pending !== null && entry.dueAt <= now) continue;
    if (soonestDueAt === null || entry.dueAt < soonestDueAt) soonestDueAt = entry.dueAt;
  }
  if (soonestDueAt === null) return;
  const timerGeneration = retryTimerGeneration;
  retryTimer = trackTimeout(
    win,
    () => {
      if (retryTimerGeneration !== timerGeneration) return;
      retryTimer = null;
      if (host !== win || cadenceHolders === 0) return;
      dispatchDueRetries(win);
      syncRetryTimer(win);
    },
    Math.max(0, soonestDueAt - now)
  );
}

function reconcilePendingRetries(
  win: Window,
  dashboard: UsageRecord,
  readStartedAt: number | undefined,
  providerScope: ReadonlySet<string> | null,
  preservedProviders?: ReadonlySet<string>,
  forAuth = false
): void {
  const rowByProvider = new Map<string, UsageRecord>();
  for (const row of dashboardRows(dashboard)) {
    const key = providerKey(usageResetRowProvider(row, ''));
    if (key) rowByProvider.set(key, row);
  }
  for (const [key, entry] of [...retryStates]) {
    if (key === ALL_RETRY_SCOPE) {
      if (providerScope !== null) continue;
      if (readStartedAt !== undefined && readStartedAt < entry.failedAt) continue;
      if (entry.forAuth && !forAuth) continue;
      retryStates.delete(key);
      continue;
    }
    if (readStartedAt !== undefined) {
      if (
        readStartedAt >= entry.failedAt &&
        entry.provider !== null &&
        providerInScope(entry.provider, providerScope)
      ) {
        if (entry.forAuth && !forAuth) {
          if (preservedProviders?.has(key)) continue;
          const row = rowByProvider.get(key);
          if (!row || (row.authenticated !== false && readingTime(row) === null)) continue;
        }
        retryStates.delete(key);
      }
      continue;
    }
    if (preservedProviders?.has(key)) continue;
    const row = rowByProvider.get(key);
    const updatedAt = row ? readingTime(row) : undefined;
    if (
      updatedAt !== undefined &&
      updatedAt !== null &&
      updatedAt >= entry.failedAt &&
      (entry.baselineUpdatedAt === null || updatedAt > entry.baselineUpdatedAt)
    ) {
      retryStates.delete(key);
    }
  }
  syncRetryTimer(win);
}

function scheduleScopeRetries(
  win: Window,
  delayMs: number,
  providers?: readonly string[],
  failedAt = Date.now(),
  forAuth = false
): boolean {
  const api = cadenceHolders > 0 ? cadenceApi : undefined;
  if (win.document?.visibilityState === 'hidden' || typeof api?.invokeCapability !== 'function') {
    return false;
  }
  const scopes: { key: string; provider: string | null }[] = providers?.length
    ? providers.map((provider) => ({ key: providerKey(provider), provider })).filter((entry) => entry.key.length > 0)
    : [{ key: ALL_RETRY_SCOPE, provider: null }];
  let armed = false;
  const dueAt = failedAt + Math.max(0, delayMs);
  for (const { key, provider } of scopes) {
    const existing = retryStates.get(key);
    if (existing?.retryUsed) continue;
    retryStates.set(key, {
      provider,
      retryUsed: true,
      failedAt,
      dueAt,
      baselineUpdatedAt: provider !== null ? providerUpdatedAt(provider) : null,
      forAuth: existing?.forAuth || forAuth,
    });
    armed = true;
  }
  if (armed) syncRetryTimer(win);
  return armed;
}

function failRefresh(
  win: Window,
  timedOut: boolean,
  allowGlobalRetry = true,
  providers?: readonly string[],
  forAuth = false
): void {
  if (timedOut) {
    // The underlying host call may still be unresolved. Retiring its generation
    // is what makes the bounded retry safe to start alongside it: a late
    // fulfillment can no longer publish, persist, or clear newer state.
    epoch += 1;
  }
  const retryable =
    allowGlobalRetry && scheduleScopeRetries(win, USAGE_DASHBOARD_RETRY_DELAY_MS, providers, Date.now(), forAuth);
  // Preserve known quotas, but settle account-switch placeholders as unknown.
  finishUsageChecks(win);
  publishStatus((retryable || hasPendingRetry()) && snapshot.refreshedAt === 0 ? 'loading' : settledStatus());
}

function dashboardRows(dashboard: UsageRecord): UsageRecord[] {
  return Array.isArray(dashboard.rows) ? (dashboard.rows as UsageRecord[]) : [];
}

function readingTime(row: UsageRecord): number | null {
  return typeof row.updatedAt === 'number' ? row.updatedAt : null;
}

function noteReadings(dashboard: UsageRecord): void {
  orderedReadings.clear();
  for (const row of dashboardRows(dashboard)) {
    if (row.id && readingTime(row) !== null) orderedReadings.add(String(row.id));
  }
}

function isStalePreFailureForProvider(providerNormalized: string, readAt: number | undefined): boolean {
  if (readAt === undefined) return false;
  for (const entry of elapsedResetState.values()) {
    if (entry.status !== 'transport-failed' || entry.failedAt === null) continue;
    if (providerKey(entry.provider) === providerNormalized && readAt < entry.failedAt) return true;
  }
  return false;
}

function noteCommittedPublications(
  dashboard: UsageRecord,
  committedAt: number,
  readStartedAt: number | undefined,
  providerScope: ReadonlySet<string> | null,
  preservedProviders: ReadonlySet<string> | undefined
): void {
  let commitSeq = 0;
  for (const row of dashboardRows(dashboard)) {
    const key = providerKey(usageResetRowProvider(row, ''));
    if (!key) continue;
    if (!providerInScope(key, providerScope)) continue;
    if (preservedProviders?.has(key)) continue;
    const rowUpdatedAt = readingTime(row);
    const unresolvedPreFailure =
      readStartedAt !== undefined &&
      rowUpdatedAt !== null &&
      isStalePreFailureForProvider(key, readStartedAt) &&
      isStalePreFailureForProvider(key, rowUpdatedAt);
    if (commitSeq === 0) commitSeq = ++publishSeq;
    providerPublished.set(key, {
      seq: commitSeq,
      committedAt,
      unresolvedPreFailure,
      protectedWindowKeys: new Set(rowWindowEntries(row).map((entry) => entry.key)),
    });
  }
}

function isErrorOrEmptyRow(row: UsageRecord, current: UsageRecord): boolean {
  if (row.status === 'error' || row.status === 'unavailable' || row.status === 'checking') {
    return true;
  }
  const currentHasWindows = Array.isArray(current.windows) && current.windows.length > 0;
  const incomingHasWindows = Array.isArray(row.windows) && row.windows.length > 0;
  return currentHasWindows && !incomingHasWindows;
}

type RowWindowEntry = {
  key: string;
  window: UsageRecord;
  resetAt: number | null;
  usedPct: number | null;
};

type RowWindowAnalysis = {
  currentEntries: RowWindowEntry[];
  incomingEntries: RowWindowEntry[];
  regressedKeys: Set<string>;
  rolledKeys: Set<string>;
  regressed: boolean;
  advancesReset: boolean;
};

function rowWindowEntries(row: UsageRecord): RowWindowEntry[] {
  const windows = Array.isArray(row.windows) ? (row.windows as UsageRecord[]) : [];
  const provider = usageResetRowProvider(row, 'row');
  const keys = usageResetWindowKeys(windows, provider, '');
  return windows.map((win, index) => ({
    key: keys[index],
    window: win,
    resetAt: usageTimestamp(win?.resetAt),
    usedPct: typeof win?.usedPct === 'number' && Number.isFinite(win.usedPct) ? win.usedPct : null,
  }));
}

function analyzeRowWindows(current: UsageRecord, incoming: UsageRecord, now: number): RowWindowAnalysis {
  const currentEntries = rowWindowEntries(current);
  const incomingEntries = rowWindowEntries(incoming);
  const regressedKeys = new Set<string>();
  const rolledKeys = new Set<string>();
  if (currentEntries.length === 0) {
    return {
      currentEntries,
      incomingEntries,
      regressedKeys,
      rolledKeys,
      regressed: false,
      advancesReset: false,
    };
  }
  const incomingByKey = new Map(incomingEntries.map((entry) => [entry.key, entry]));
  for (const curr of currentEntries) {
    const inc = incomingByKey.get(curr.key);
    if (!inc) {
      regressedKeys.add(curr.key);
      continue;
    }
    if (curr.resetAt !== null) {
      if (inc.resetAt !== null && inc.resetAt < curr.resetAt) {
        regressedKeys.add(curr.key);
      } else if (curr.resetAt > now && inc.resetAt === null) {
        regressedKeys.add(curr.key);
      } else if (curr.resetAt <= now && inc.resetAt !== null && inc.resetAt > now && inc.resetAt > curr.resetAt) {
        rolledKeys.add(curr.key);
      } else if (
        curr.resetAt <= now &&
        (inc.resetAt === null || inc.resetAt > now) &&
        curr.usedPct !== null &&
        inc.usedPct !== null &&
        inc.usedPct < curr.usedPct
      ) {
        rolledKeys.add(curr.key);
      }
    }
  }
  return {
    currentEntries,
    incomingEntries,
    regressedKeys,
    rolledKeys,
    regressed: regressedKeys.size > 0,
    advancesReset: regressedKeys.size === 0 && rolledKeys.size > 0,
  };
}

function mergeProtectedWindows(
  current: UsageRecord,
  incoming: UsageRecord,
  analysis: RowWindowAnalysis,
  keepKeys: ReadonlySet<string>,
  preserveCredits: boolean
): UsageRecord {
  const currentByKey = new Map(analysis.currentEntries.map((entry) => [entry.key, entry.window]));
  const seen = new Set<string>();
  const mergedWindows: UsageRecord[] = analysis.incomingEntries.map((entry) => {
    seen.add(entry.key);
    if (keepKeys.has(entry.key)) {
      return currentByKey.get(entry.key) ?? entry.window;
    }
    return entry.window;
  });
  for (const entry of analysis.currentEntries) {
    if (keepKeys.has(entry.key) && !seen.has(entry.key)) {
      mergedWindows.push(entry.window);
    }
  }
  const merged: UsageRecord = { ...incoming, windows: mergedWindows };
  if (preserveCredits && current.resetCredits !== undefined && incoming.resetCredits === undefined) {
    merged.resetCredits = current.resetCredits;
  }
  return merged;
}

function accountOf(row: UsageRecord): string | null {
  return typeof row.credentialStamp === 'string' && row.credentialStamp ? row.credentialStamp : null;
}

/** Two readings are ordered only when they belong to one account: by the stamp both rows carry (so a restart compares
 *  the stored row correctly and another account's row is never ordered against the shown one), else, for a core that
 *  sends none, when the shown row is a reading this document accepted live since the last credential change. */
function sameAccountReadings(current: UsageRecord, incoming: UsageRecord, id: string): boolean {
  const shown = accountOf(current);
  const sent = accountOf(incoming);
  return shown && sent ? shown === sent : orderedReadings.has(id);
}

type KeepNewerOptions = {
  source: 'refresh' | 'section' | 'publish';
  incomingStartedAtSeq?: number;
  providerScope?: ReadonlySet<string> | null;
  forAuth?: boolean;
  preserveWhenUnmeasured?: boolean;
};

/** A provider's reading taken before the one it shows was overtaken on its way (a refresh answered from the read
 *  already running, a section snapshot older than a push): the shown row stays. An unmeasured/empty row cannot
 *  overwrite a measured row for the same account outside an explicit auth refresh. */
function keepNewerReadings(
  incoming: UsageRecord,
  {
    source,
    incomingStartedAtSeq,
    providerScope = null,
    forAuth = false,
    preserveWhenUnmeasured = false,
  }: KeepNewerOptions
): { dashboard: UsageRecord; preservedProviders: Set<string> } {
  const shown = new Map(dashboardRows(snapshot.dashboard).map((row) => [String(row.id || ''), row]));
  const preservedProviders = new Set<string>();
  const now = Date.now();
  let kept = false;
  const incomingIds = new Set<string>();
  const rows = dashboardRows(incoming).map((row) => {
    const id = String(row.id || '');
    incomingIds.add(id);
    const key = providerKey(usageResetRowProvider(row, ''));
    const current = shown.get(id);
    if (!current) return row;

    const outOfScope = providerScope !== null && key.length > 0 && !providerInScope(key, providerScope);
    if (outOfScope) {
      kept = true;
      preservedProviders.add(key);
      return current;
    }

    const shownAccount = accountOf(current);
    const sentAccount = accountOf(row);
    if (row.authenticated === false) {
      if (key) providerPublished.delete(key);
      return row;
    }
    if (shownAccount && sentAccount && shownAccount !== sentAccount) {
      if (key) providerPublished.delete(key);
      return row;
    }

    const at = readingTime(row);
    const currentAt = readingTime(current);
    const published = key ? providerPublished.get(key) : undefined;

    if (source === 'refresh' && forAuth) {
      if (published !== undefined && incomingStartedAtSeq !== undefined && incomingStartedAtSeq < published.seq) {
        kept = true;
        if (key) preservedProviders.add(key);
        return current;
      }
      const sameStamp = Boolean(shownAccount && sentAccount && shownAccount === sentAccount);
      if (sameStamp && at === null && currentAt !== null) {
        kept = true;
        if (key) preservedProviders.add(key);
        return current;
      }
      const newerForAuth = sameAccountReadings(current, row, id) ? currentAt : null;
      if (at !== null && newerForAuth !== null && at < newerForAuth) {
        kept = true;
        if (key) preservedProviders.add(key);
        return current;
      }
      if (key) providerPublished.delete(key);
      if (
        sameStamp &&
        row.status === 'partial' &&
        current.resetCredits !== undefined &&
        row.resetCredits === undefined
      ) {
        kept = true;
        return { ...row, resetCredits: current.resetCredits };
      }
      return row;
    }

    if (current.status === 'checking') {
      if (published !== undefined && incomingStartedAtSeq !== undefined && incomingStartedAtSeq < published.seq) {
        kept = true;
        if (key) preservedProviders.add(key);
        return current;
      }
      if (key) providerPublished.delete(key);
      return row;
    }

    const newer = sameAccountReadings(current, row, id) ? currentAt : null;
    if (at !== null && newer !== null && at < newer) {
      kept = true;
      if (key) preservedProviders.add(key);
      return current;
    }

    if (source === 'publish') {
      if (preserveWhenUnmeasured && at === null && currentAt !== null) {
        kept = true;
        if (key) preservedProviders.add(key);
        return current;
      }
      return row;
    }

    const incomplete = isErrorOrEmptyRow(row, current);
    if (at === null && currentAt !== null) {
      kept = true;
      if (key) preservedProviders.add(key);
      return current;
    }
    if (incomplete && (currentAt !== null || published !== undefined || current.resetCredits !== undefined)) {
      kept = true;
      if (key) preservedProviders.add(key);
      return current;
    }

    const analysis = analyzeRowWindows(current, row, now);
    const dropsResetCredits = current.resetCredits !== undefined && row.resetCredits === undefined;

    if (
      source === 'refresh' &&
      published !== undefined &&
      incomingStartedAtSeq !== undefined &&
      incomingStartedAtSeq < published.seq
    ) {
      if (
        !published.unresolvedPreFailure ||
        incomplete ||
        analysis.regressed ||
        (row.status === 'partial' && !analysis.advancesReset)
      ) {
        kept = true;
        if (key) preservedProviders.add(key);
        return current;
      }
    }

    const keepKeys = new Set<string>();
    if (row.status === 'partial') {
      if (published !== undefined) {
        for (const wKey of published.protectedWindowKeys) {
          if (!analysis.rolledKeys.has(wKey)) keepKeys.add(wKey);
        }
        for (const wKey of analysis.regressedKeys) keepKeys.add(wKey);
      } else if (dropsResetCredits) {
        for (const entry of analysis.currentEntries) {
          if (!analysis.rolledKeys.has(entry.key)) keepKeys.add(entry.key);
        }
        for (const wKey of analysis.regressedKeys) keepKeys.add(wKey);
      }
    } else if (source === 'section' && published !== undefined && !published.unresolvedPreFailure) {
      if (analysis.regressed || dropsResetCredits) {
        for (const wKey of published.protectedWindowKeys) {
          if (!analysis.rolledKeys.has(wKey)) keepKeys.add(wKey);
        }
        for (const wKey of analysis.regressedKeys) keepKeys.add(wKey);
      }
    }

    if (keepKeys.size > 0) {
      const hasAddedWindows = analysis.incomingEntries.some((entry) => !keepKeys.has(entry.key));
      const allCurrentKept =
        !hasAddedWindows &&
        analysis.currentEntries.length > 0 &&
        analysis.currentEntries.every((entry) => keepKeys.has(entry.key));
      if (allCurrentKept) {
        kept = true;
        if (key) preservedProviders.add(key);
        return current;
      }
      if (published !== undefined) {
        for (const wKey of analysis.rolledKeys) published.protectedWindowKeys.delete(wKey);
      }
      kept = true;
      return mergeProtectedWindows(current, row, analysis, keepKeys, true);
    }

    if (published !== undefined) {
      if (
        (source === 'refresh' && row.status !== 'partial') ||
        published.unresolvedPreFailure ||
        (published.protectedWindowKeys.size === 0 && analysis.advancesReset)
      ) {
        if (key) providerPublished.delete(key);
      } else {
        for (const wKey of analysis.rolledKeys) published.protectedWindowKeys.delete(wKey);
        if (published.protectedWindowKeys.size === 0 && analysis.rolledKeys.size > 0) {
          if (key) providerPublished.delete(key);
        }
      }
    }

    if (row.status === 'partial' && dropsResetCredits) {
      kept = true;
      return { ...row, resetCredits: current.resetCredits };
    }

    return row;
  });
  if (providerScope !== null) {
    for (const [id, current] of shown) {
      if (incomingIds.has(id)) continue;
      const key = providerKey(usageResetRowProvider(current, ''));
      if (key && !providerInScope(key, providerScope)) {
        kept = true;
        preservedProviders.add(key);
        rows.push(current);
      }
    }
  }
  return { dashboard: kept ? { ...incoming, rows } : incoming, preservedProviders };
}

function acceptRefresh(
  win: Window,
  value: unknown,
  readStartedAt?: number,
  providerScope: ReadonlySet<string> | null = null,
  allowGlobalRetry = true,
  providers?: readonly string[],
  startedAtSeq?: number,
  forAuth = false
): boolean {
  const sanitized = sanitizeUsageDashboard(value);
  const stale = rowCount(snapshot.dashboard) > 0;
  if (!sanitized || (rowCount(sanitized) === 0 && stale)) {
    // Malformed, or empty while valid rows are known: keep the stale snapshot
    // and the stored cache untouched, and treat it as a failed refresh.
    failRefresh(win, false, allowGlobalRetry, providers, forAuth);
    return false;
  }
  const { dashboard, preservedProviders } = keepNewerReadings(sanitized, {
    source: readStartedAt === undefined ? 'section' : 'refresh',
    incomingStartedAtSeq: startedAtSeq,
    providerScope,
    forAuth,
  });
  reconcilePendingRetries(win, dashboard, readStartedAt, providerScope, preservedProviders, forAuth);
  writeCache(win, dashboard);
  const now = Date.now();
  publish({
    dashboard,
    refreshedAt: now,
    loading: false,
    // A well-formed but empty dashboard is a FINAL answer, not a load state.
    status: rowCount(dashboard) > 0 ? 'ready' : 'unavailable',
  });
  noteReadings(dashboard);
  reconcileElapsedResetsAfterAccept(
    dashboard,
    dashboardResetWindows(dashboard),
    readStartedAt,
    now,
    providerScope,
    readStartedAt === undefined ? preservedProviders : undefined
  );
  publishResetVerificationState(now);
  if (activeResetRefreshId === 0) syncResetRefresh(win);
  return true;
}

/** Takes the pushed `usage/dashboard` aggregate as a live result. Returns the unfollow. */
function followUsageSection(win: Window, api: UsageApi | undefined): () => void {
  const sections = sectionStoreFor(api);
  if (!sections) return () => undefined;
  let released = false;
  let lastEntry: DesktopSectionEntry | undefined;
  let lastEntryKey: string | null = null;
  // A pushed entry is a live result of the core, not an answer to a request of one epoch: retiring requests (a credential
  // change, a mutation) must not silence the section for the rest of this holder's life.
  const take = (): void => {
    if (released || host !== win) return;
    const entry = sections.get('usage', 'dashboard');
    if (!entry) {
      lastEntry = undefined;
      lastEntryKey = null;
      return;
    }
    if (entry === lastEntry) return;
    const entryKey = serializeSectionValue(entry.value);
    if (
      lastEntry !== undefined &&
      entry.revision === lastEntry.revision &&
      entryKey !== null &&
      entryKey === lastEntryKey
    ) {
      lastEntry = entry;
      return;
    }
    lastEntry = entry;
    lastEntryKey = entryKey;
    acceptRefresh(win, entry.value);
  };
  const unsubscribe = sections.subscribe('usage', take);
  void sections.ready().then(take);
  return () => {
    released = true;
    unsubscribe();
  };
}

function owns(win: Window, id: number, generation: number): boolean {
  return host === win && epoch === generation && pendingId === id;
}

function scopeCovers(inFlight: ReadonlySet<string> | null, requested: ReadonlySet<string> | null): boolean {
  if (inFlight === null) return true;
  if (requested === null) return false;
  for (const provider of requested) {
    if (!inFlight.has(provider)) return false;
  }
  return true;
}

function preserveUncoveredInFlight(scope: ReadonlySet<string>, now: number): void {
  if (pending === null) return;
  if (pendingRawProviders?.length) {
    for (const provider of pendingRawProviders) {
      const key = providerKey(provider);
      if (!key || scope.has(key)) continue;
      const existing = retryStates.get(key);
      retryStates.set(key, {
        provider,
        retryUsed: existing?.retryUsed ?? pendingIsRetry,
        failedAt: existing?.failedAt ?? (pendingStartedAt || now),
        dueAt: now,
        baselineUpdatedAt: existing?.baselineUpdatedAt ?? providerUpdatedAt(provider),
        forAuth: existing?.forAuth || pendingForAuth,
      });
    }
  } else if (pendingProviders === null && (pendingIsRetry || pendingForAuth)) {
    const existing = retryStates.get(ALL_RETRY_SCOPE);
    retryStates.set(ALL_RETRY_SCOPE, {
      provider: null,
      retryUsed: existing?.retryUsed ?? pendingIsRetry,
      failedAt: existing?.failedAt ?? (pendingStartedAt || now),
      dueAt: now,
      baselineUpdatedAt: null,
      forAuth: existing?.forAuth || pendingForAuth,
    });
  }
  if (pendingOutcome?.chargedTransportKeys.length) {
    for (const key of pendingOutcome.chargedTransportKeys) {
      const entry = elapsedResetState.get(key);
      if (entry?.status === 'transport-failed' && !providerInScope(entry.provider, scope)) {
        entry.retryAttempts = Math.max(0, entry.retryAttempts - 1);
        entry.nextDueAt = now;
      }
    }
  }
}

async function runRefresh(
  win: Window,
  api: UsageApi,
  id: number,
  generation: number,
  providers: readonly string[] | undefined,
  readStartedAt: number,
  startedAtSeq: number,
  providerScope: ReadonlySet<string> | null,
  outcome: RefreshOutcome,
  allowGlobalRetry: boolean,
  forAuth: boolean
): Promise<void> {
  let result: unknown;
  try {
    result = await withUsageTimeout(
      readGlobalCapabilities(api, [
        {
          capability: 'getUsageDashboard',
          args: [
            {
              refresh: true,
              refreshSetup: false,
              ...(providers?.length ? { refreshProviders: [...providers] } : {}),
            },
          ],
        },
      ]),
      USAGE_DASHBOARD_REQUEST_TIMEOUT_MS,
      win
    );
  } catch (cause) {
    // A retired generation has no owner: no publish, no cache write, no retry.
    if (!owns(win, id, generation)) return;
    outcome.failed = true;
    const now = Date.now();
    if (outcome.adoptedDue.length > 0) {
      markTransportFailedWindows(outcome.adoptedDue, readStartedAt, providerScope, now);
    } else {
      for (const key of outcome.chargedTransportKeys) {
        const entry = elapsedResetState.get(key);
        if (entry?.status === 'transport-failed') {
          entry.failedAt = Math.max(entry.failedAt ?? 0, now);
        }
      }
    }
    failRefresh(
      win,
      (cause as { code?: string } | null)?.code === USAGE_TIMEOUT_CODE,
      allowGlobalRetry && !outcome.suppressOrdinaryRetry,
      providers,
      forAuth
    );
    return;
  }
  if (!owns(win, id, generation)) return;
  if (
    !acceptRefresh(
      win,
      (result as unknown[])[0],
      readStartedAt,
      providerScope,
      allowGlobalRetry && !outcome.suppressOrdinaryRetry,
      providers,
      startedAtSeq,
      forAuth
    )
  ) {
    outcome.failed = true;
    if (outcome.adoptedDue.length > 0) {
      markTransportFailedWindows(outcome.adoptedDue, readStartedAt, providerScope, Date.now());
    }
  }
}

/** Credentials changed: refreshes without adopting a request the previous
 *  account started. `providers` scopes the live sweep to the changed provider. */
export function refreshUsageDashboardAfterAuth(
  api: UsageApi | undefined,
  providers?: readonly string[]
): Promise<void> {
  const win = ensureHost();
  const scope = normalizeProviderScope(providers);
  if (scope) {
    preserveUncoveredInFlight(scope, Date.now());
    retireInFlight(win);
    for (const key of scope) retryStates.delete(key);
    clearResetTrackingForProviders(scope);
    for (const provider of providers ?? []) {
      orderedReadings.delete(provider);
      providerPublished.delete(providerKey(provider));
    }
  } else {
    retire();
    clearResetTracking();
    orderedReadings.clear();
    providerPublished.clear();
  }
  const request = startUsageRefresh(api, { force: true, providers, forAuth: true });
  if (win && scope) syncRetryTimer(win);
  return request.finally(() => {
    if (win && host === win && cadenceHolders > 0) {
      if (activeResetRefreshId === 0 && resetTimer === null) syncResetRefresh(win);
      if (pending === null) syncRetryTimer(win);
    }
  });
}

function startUsageRefresh(
  api: UsageApi | undefined,
  {
    force = false,
    retry = false,
    providers,
    fromReset = false,
    forAuth = false,
  }: {
    force?: boolean;
    retry?: boolean;
    providers?: readonly string[];
    fromReset?: boolean;
    forAuth?: boolean;
  } = {}
): Promise<void> {
  const win = ensureHost();
  let effectiveProviders = providers;
  if (!force && !retry && !fromReset && win) {
    const now = Date.now();
    if (providers?.length) {
      const unheld = providers.filter((provider) => !isScopeEntryHeld(retryStates.get(providerKey(provider)), now));
      if (unheld.length > 0 && unheld.length < providers.length) {
        effectiveProviders = unheld;
      }
    } else {
      const unheld = unheldDashboardProviders(now);
      if (unheld !== null && unheld.length > 0) {
        effectiveProviders = unheld;
      }
    }
  }
  const providerScope = normalizeProviderScope(effectiveProviders);
  if (pending) {
    const waitFor = pendingWaiter ?? pending.then(() => false);
    const startHostGen = hostGeneration;
    const startRetireGen = fullRetireGeneration;
    if (scopeCovers(pendingProviders, providerScope)) {
      if (fromReset) return waitFor.then(() => undefined);
      return waitFor.then((retired) => {
        if (!retired || hostGeneration !== startHostGen || fullRetireGeneration !== startRetireGen) return;
        if (pending) return startUsageRefresh(api, { force, retry, providers, fromReset, forAuth });
      });
    }
    return waitFor.then(() => {
      if (hostGeneration !== startHostGen || fullRetireGeneration !== startRetireGen) return;
      return startUsageRefresh(api, { force, retry, providers, fromReset, forAuth });
    });
  }
  if (!win) return Promise.resolve();
  if (!canReadUsage(api)) {
    // This host cannot serve usage at all. Settle the first paint instead of
    // leaving the surface on an indefinite Loading.
    finishUsageChecks(win);
    publishStatus(settledStatus());
    return Promise.resolve();
  }
  if (!force && isFresh(providerScope)) return Promise.resolve();
  if (force && !retry && !fromReset) {
    if (effectiveProviders?.length) {
      for (const provider of effectiveProviders) {
        const key = providerKey(provider);
        const existing = key ? retryStates.get(key) : undefined;
        if (existing && existing.dueAt === null) retryStates.delete(key);
      }
    } else {
      for (const [key, existing] of [...retryStates]) {
        if (existing.dueAt === null) retryStates.delete(key);
      }
    }
  }
  const id = ++requestSequence;
  const generation = epoch;
  const readStartedAt = Date.now();
  const startedAtSeq = publishSeq;
  let effectiveForAuth = forAuth;
  if (fromReset && providerScope === null) {
    const globalRetry = retryStates.get(ALL_RETRY_SCOPE);
    if (globalRetry?.forAuth) {
      effectiveForAuth = true;
      globalRetry.dueAt = null;
    }
  }
  const adoptedDue =
    !fromReset && !retry && providerScope === null && activeResetRefreshId === 0
      ? dueResetWindows(readStartedAt, false)
      : [];
  let adoptedResetRefreshId = 0;
  let chargedTransportKeys: string[] = [];
  if (adoptedDue.length > 0) {
    clearResetTimer(win);
    chargedTransportKeys = chargeDispatchedTransportRetries(adoptedDue, readStartedAt, providerScope);
    adoptedResetRefreshId = ++resetRefreshSequence;
    activeResetRefreshId = adoptedResetRefreshId;
    inFlightResetKeys.clear();
    for (const { window } of adoptedDue) inFlightResetKeys.add(window.key);
    publishResetVerificationState(readStartedAt);
  }
  const outcome: RefreshOutcome = {
    id,
    failed: false,
    suppressOrdinaryRetry: adoptedDue.length > 0 && !effectiveForAuth,
    chargedTransportKeys,
    adoptedDue,
  };
  let settleWaiter!: (retired: boolean) => void;
  const waiter = new Promise<boolean>((resolve) => {
    settleWaiter = resolve;
  });
  pendingId = id;
  pendingStartedAt = readStartedAt;
  pendingProviders = providerScope;
  pendingRawProviders = effectiveProviders?.length ? [...effectiveProviders] : undefined;
  pendingIsRetry = retry;
  pendingForAuth = effectiveForAuth;
  pendingOutcome = outcome;
  pendingWaiter = waiter;
  releasePendingWaiter = settleWaiter;
  const request = runRefresh(
    win,
    api,
    id,
    generation,
    effectiveProviders,
    readStartedAt,
    startedAtSeq,
    providerScope,
    outcome,
    !fromReset && !retry,
    effectiveForAuth
  ).finally(() => {
    // Ownership is per REQUEST id: an old finally can never release the pending
    // slot of a newer request, nor one a retirement already cleared.
    if (adoptedResetRefreshId !== 0 && activeResetRefreshId === adoptedResetRefreshId) {
      activeResetRefreshId = 0;
      inFlightResetKeys.clear();
    }
    if (pendingId !== id) {
      settleWaiter(true);
      return;
    }
    pendingId = 0;
    pending = null;
    pendingStartedAt = 0;
    pendingProviders = null;
    pendingRawProviders = undefined;
    pendingIsRetry = false;
    pendingForAuth = false;
    pendingOutcome = null;
    if (pendingWaiter === waiter) {
      pendingWaiter = null;
      releasePendingWaiter = null;
    }
    settleWaiter(false);
    if (adoptedResetRefreshId !== 0 && host === win) {
      const afterNow = Date.now();
      pruneResetTracking(dashboardResetWindows(snapshot.dashboard), afterNow);
      publishResetVerificationState(afterNow);
      syncResetRefresh(win);
    }
    if (host === win && cadenceHolders > 0) {
      queueMicrotask(() => {
        if (host === win && cadenceHolders > 0) syncRetryTimer(win);
      });
    }
    // A pending bounded retry keeps the first paint in loading; nothing else
    // may leave the surface waiting forever.
    if (snapshot.status === 'loading' && !hasPendingRetry() && pending === null) publishStatus(settledStatus());
  });
  pending = request;
  publishStatus(snapshot.refreshedAt > 0 ? 'ready' : 'loading');
  return waiter.then(() => undefined);
}

/** One in-flight request for the whole renderer. `force` skips the TTL check
 *  (credential changes and retries); everything else is stale-while-revalidate. */
export function refreshUsageDashboard(
  api: UsageApi | undefined,
  options: {
    force?: boolean;
    retry?: boolean;
    providers?: readonly string[];
  } = {}
): Promise<void> {
  return startUsageRefresh(api, options);
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
    if (snapshot.status === 'loading') publishStatus(settledStatus());
  });
}

function bindAccountChanges(win: Window, api: UsageApi): void {
  if (accountChangesApi === api) return;
  releaseAccountChanges?.();
  accountChangesApi = api;
  let released = false;
  const receive = (state: SessionSnapshot) => {
    if (released || host !== win || cadenceHolders === 0) return;
    const change = state?.providerAccountChange;
    if (!change?.provider || !change.accountId || !Number.isFinite(change.at)) return;
    const previous = latestAccountChanges.get(change.provider);
    if (
      previous &&
      (change.at < previous.at || (change.at === previous.at && change.accountId === previous.accountId))
    ) {
      return;
    }
    latestAccountChanges.set(change.provider, { accountId: change.accountId, at: change.at });
    // Read the CURRENT selection, not meters embedded in a possibly replayed
    // session frame. Retire old requests before the confirming account read.
    applyAccountUsageWindows(change.provider, undefined);
    void refreshUsageDashboardAfterAuth(api, [change.provider]);
  };
  const releaseState = api.subscribeState?.(receive);
  const releaseSessions = api.subscribeSessionState?.(({ snapshot: state }) => receive(state));
  releaseAccountChanges = () => {
    released = true;
    releaseState?.();
    releaseSessions?.();
  };
}

/** Keeps the single refresh cadence alive while at least one holder (the always
 *  mounted rail, plus the popup when open) needs it. */
export function holdUsageDashboardCadence(api: UsageApi | undefined): () => void {
  const win = ensureHost();
  const generation = hostGeneration;
  const previousApi = cadenceApi;
  cadenceHolders += 1;
  // A same-window API swap (host bridge replaced) becomes the cadence API, so
  // neither the cadence nor the retry can keep a retired bridge alive.
  if (canReadUsage(api)) cadenceApi = api;
  if (win && cadenceApi) bindAccountChanges(win, cadenceApi);
  if (win && releaseCadence === null && canReadUsage(cadenceApi)) {
    // The aggregate is pushed (section `usage`, key `dashboard`; desktop-services.md §15 P7): there is no
    // refresh cadence. A read happens only for a credential change (refreshUsageDashboardAfterAuth).
    releaseCadence = followUsageSection(win, cadenceApi);
    const onVisibility = () => {
      if (host !== win || cadenceHolders === 0) return;
      if (activeResetRefreshId === 0) syncResetRefresh(win);
      syncRetryTimer(win);
    };
    win.document?.addEventListener?.('visibilitychange', onVisibility);
    releaseVisibilitySync = () => {
      win.document?.removeEventListener?.('visibilitychange', onVisibility);
    };
    releaseReconnectRetry = subscribeRemoteConnectionState(() => {
      if (host !== win || cadenceHolders === 0) return;
      if (currentRemoteConnectionState() !== 'connected' || win.document?.visibilityState === 'hidden') return;
      if (hasPendingRetry()) {
        const now = Date.now();
        let hasGlobal = false;
        for (const [key, entry] of retryStates) {
          if (entry.dueAt !== null) {
            entry.dueAt = now;
            if (key === ALL_RETRY_SCOPE) hasGlobal = true;
          }
        }
        syncRetryTimer(win);
        if (hasGlobal) return;
      }
      if (activeResetRefreshId === 0 && promoteTransportRetriesNow(Date.now())) {
        syncResetRefresh(win);
      }
    });
  }
  if (
    win &&
    canReadUsage(cadenceApi) &&
    activeResetRefreshId === 0 &&
    (resetTimer === null || cadenceApi !== previousApi)
  ) {
    syncResetRefresh(win);
  }
  if (win && canReadUsage(cadenceApi) && (retryTimer === null || cadenceApi !== previousApi) && hasPendingRetry()) {
    syncRetryTimer(win);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (generation !== hostGeneration) return;
    cadenceHolders = Math.max(0, cadenceHolders - 1);
    if (cadenceHolders === 0) scheduleRetirement();
  };
}
