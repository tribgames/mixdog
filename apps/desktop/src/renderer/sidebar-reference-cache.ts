// Process-wide, IN-MEMORY stale-while-revalidate cache for the slow-changing
// reference data the sidebar rail panels share (Schedules, Webhooks,
// Workflows). Before this, each panel independently refetched the same
// channel setup, model catalogs, projects, workflows and agents on every
// mount and every re-entry, so a warm app still showed a loading cover.
//
// Scope is deliberately narrow: reference/read data only. Live session lanes,
// git status, file trees, running/working state, editor content and webhook
// secrets are NEVER cached here, and nothing is persisted — no localStorage,
// no disk. A reload starts cold on purpose.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  DesktopApi,
  DesktopCapability,
  DesktopModelOption,
  DesktopProjectSummary,
} from '../shared/contract';

type RecordValue = Record<string, unknown>;

export type SidebarReferenceApi =
  Partial<Pick<DesktopApi, 'invokeCapability' | 'listProviderModels' | 'listProjects'>>;

export interface SidebarReferenceValues {
  channelSetup: RecordValue;
  quickProviderModels: DesktopModelOption[];
  projects: DesktopProjectSummary[];
  workflows: RecordValue[];
  agents: RecordValue[];
  providerSetup: unknown;
  searchRoute: RecordValue;
  searchModels: RecordValue[];
}

export type SidebarReferenceKey = keyof SidebarReferenceValues;

export const SIDEBAR_REFERENCE_KEYS: readonly SidebarReferenceKey[] = [
  'channelSetup',
  'quickProviderModels',
  'projects',
  'workflows',
  'agents',
  'providerSetup',
  'searchRoute',
  'searchModels',
];

// TTLs reflect how fast each resource actually moves. Channel setup carries
// the schedule/webhook rows a user edits inside the app, so it revalidates
// quickly; catalogs that only change when a provider or pack changes hold
// much longer. Mutations invalidate explicitly, so the TTL is a backstop for
// out-of-app edits, not the primary freshness mechanism.
const TTL_MS: Record<SidebarReferenceKey, number> = {
  channelSetup: 20_000,
  quickProviderModels: 300_000,
  projects: 60_000,
  workflows: 120_000,
  agents: 120_000,
  providerSetup: 120_000,
  searchRoute: 120_000,
  searchModels: 300_000,
};

// A failed revalidation keeps the last good snapshot on screen; this backoff
// stops a broken host from turning panel re-entry into a request storm.
const FAILURE_BACKOFF_MS = 2_000;

// Frozen singletons, not factories: an absent key must hand every reader the
// SAME empty value so a hook snapshot (and every downstream memo) stays stable
// across renders instead of thrashing on a fresh [] each read.
const EMPTY_RECORD = Object.freeze({}) as RecordValue;
const EMPTY_ROWS = Object.freeze([]) as unknown as RecordValue[];
const EMPTY_MODELS = Object.freeze([]) as unknown as DesktopModelOption[];
const EMPTY_PROJECTS = Object.freeze([]) as unknown as DesktopProjectSummary[];

const DEFAULTS: SidebarReferenceValues = {
  channelSetup: EMPTY_RECORD,
  quickProviderModels: EMPTY_MODELS,
  projects: EMPTY_PROJECTS,
  workflows: EMPTY_ROWS,
  agents: EMPTY_ROWS,
  providerSetup: undefined,
  searchRoute: EMPTY_RECORD,
  searchModels: EMPTY_ROWS,
};

// Provider connect/forget/local-endpoint changes rewrite which models are
// usable at all, so the setup snapshot and BOTH model catalogs go untrue
// together. The stored search route is a user choice and only its own
// mutation invalidates it.
const PROVIDER_KEYS: readonly SidebarReferenceKey[] = [
  'providerSetup',
  'quickProviderModels',
  'searchModels',
];

// Which cached keys a mutation makes untrue. Anything not listed falls back to
// the caller's own panel keys, so an unmapped capability still refreshes.
const MUTATION_KEYS: Partial<Record<string, readonly SidebarReferenceKey[]>> = {
  saveSchedule: ['channelSetup'],
  deleteSchedule: ['channelSetup'],
  setScheduleEnabled: ['channelSetup'],
  runScheduleNow: ['channelSetup'],
  saveWebhook: ['channelSetup'],
  deleteWebhook: ['channelSetup'],
  setWebhookEnabled: ['channelSetup'],
  createWorkflow: ['workflows'],
  saveWorkflowPack: ['workflows'],
  deleteWorkflow: ['workflows', 'agents'],
  saveAgentDefinition: ['agents'],
  deleteAgentDefinition: ['agents'],
  setAgentRoute: ['agents'],
  setSearchRoute: ['searchRoute'],
  // Provider/auth mutation owners (settings + onboarding capability runners).
  saveProviderApiKey: PROVIDER_KEYS,
  forgetProviderAuth: PROVIDER_KEYS,
  completeOAuthProviderLogin: PROVIDER_KEYS,
  loginOpenCodeGoUsage: PROVIDER_KEYS,
  setLocalProvider: PROVIDER_KEYS,
  // Onboarding finishes by writing Main, Search, and per-agent routes in one
  // capability call.
  completeOnboarding: ['searchRoute', 'agents', ...PROVIDER_KEYS],
};

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function rows(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function capability<T>(
  api: SidebarReferenceApi,
  name: DesktopCapability,
  args: unknown[] = [],
): Promise<T | undefined> {
  if (!api.invokeCapability) return undefined;
  const result = await api.invokeCapability<T>({ capability: name, args });
  return result?.value;
}

type Loader<K extends SidebarReferenceKey> =
  (api: SidebarReferenceApi) => Promise<SidebarReferenceValues[K]>;

const LOADERS: { [K in SidebarReferenceKey]: Loader<K> } = {
  channelSetup: async (api) => record(await capability(api, 'getChannelSetup')),
  quickProviderModels: async (api) => {
    if (!api.listProviderModels) return [];
    const models = await api.listProviderModels({ quick: true });
    return Array.isArray(models) ? models : [];
  },
  projects: async (api) => {
    if (!api.listProjects) return [];
    const projects = await api.listProjects();
    return Array.isArray(projects) ? projects : [];
  },
  workflows: async (api) => rows(await capability(api, 'listWorkflows')),
  agents: async (api) => rows(await capability(api, 'listAgents')),
  providerSetup: async (api) => await capability(api, 'getProviderSetup'),
  searchRoute: async (api) => record(await capability(api, 'getSearchRoute')),
  searchModels: async (api) => rows(await capability(api, 'listSearchModels', [{ quick: false }])),
};

interface CacheEntry {
  value: unknown;
  updatedAt: number;
  /** Set by an explicit invalidation: the value stays readable (no blanking)
   *  but the next read-through refetches it. */
  invalid: boolean;
}

/** Failures live OUTSIDE the snapshot map so a cold (never-loaded) key can
 *  still carry a backoff: a broken host must not turn every mount/re-entry
 *  into a fresh request storm just because there is nothing cached yet. */
interface CacheFailure {
  failedAt: number;
  error: string;
}

const entries = new Map<SidebarReferenceKey, CacheEntry>();
const inflight = new Map<SidebarReferenceKey, Promise<void>>();
const generations = new Map<SidebarReferenceKey, number>();
const failures = new Map<SidebarReferenceKey, CacheFailure>();
const listeners = new Map<SidebarReferenceKey, Set<() => void>>();
let boundApi: SidebarReferenceApi | undefined;
let hostBound = false;
let clock: () => number = () => Date.now();

function notify(key: SidebarReferenceKey): void {
  const set = listeners.get(key);
  if (!set?.size) return;
  for (const listener of [...set]) {
    try {
      listener();
    } catch {
      // One bad subscriber must not stop the rest of the panels from updating.
    }
  }
}

function bumpGeneration(key: SidebarReferenceKey): void {
  generations.set(key, (generations.get(key) ?? 0) + 1);
  inflight.delete(key);
}

// Invalidation notices are coalesced into one microtask: a settings mutation
// that invalidates three keys must wake each subscribed panel ONCE, and never
// synchronously from inside a React render or event mutation path.
let pendingNotice: Set<SidebarReferenceKey> | null = null;

function scheduleInvalidationNotice(keys: readonly SidebarReferenceKey[]): void {
  if (!keys.length) return;
  if (!pendingNotice) {
    pendingNotice = new Set();
    queueMicrotask(() => {
      const notice = pendingNotice;
      pendingNotice = null;
      if (!notice) return;
      // Coalesce per SUBSCRIBER, not per key: a panel watching three
      // invalidated keys schedules one revalidation, not three.
      const targets = new Set<() => void>();
      for (const key of notice) {
        for (const listener of listeners.get(key) ?? []) targets.add(listener);
      }
      for (const listener of targets) {
        try {
          listener();
        } catch {
          // One bad subscriber must not stop the rest of the panels.
        }
      }
    });
  }
  for (const key of keys) pendingNotice.add(key);
}

/**
 * Bind the cache to a host identity. A different object (including a partial
 * or missing host) is a different runtime: its reference data is not ours, so
 * every snapshot, failure and in-flight generation is dropped SYNCHRONOUSLY.
 * Callers must adopt before any read, so an A→B rebind can never paint A's
 * data — not even for a single commit — and A's late responses are ignored.
 *
 * Subscriber notification is deferred to a microtask because adoption also
 * happens during a render pass; the clearing itself is immediate.
 */
export function adoptSidebarReferenceHost(api: SidebarReferenceApi | undefined): boolean {
  if (hostBound && boundApi === api) return false;
  const rebind = hostBound;
  boundApi = api;
  hostBound = true;
  if (!rebind) return false;
  const affected = [...new Set([...entries.keys(), ...failures.keys(), ...inflight.keys()])];
  entries.clear();
  failures.clear();
  for (const key of SIDEBAR_REFERENCE_KEYS) bumpGeneration(key);
  if (affected.length) queueMicrotask(() => {
    for (const key of affected) notify(key);
  });
  return true;
}

export function hasSidebarReference(key: SidebarReferenceKey): boolean {
  return entries.has(key);
}

/** True while `api` is (or can become) the bound host. A completion callback
 *  created for a previous host answers false, which is what keeps a late
 *  mutation refresh from re-adopting the host the app already left. */
export function isSidebarReferenceHost(api: SidebarReferenceApi | undefined): boolean {
  return !hostBound || boundApi === api;
}

export function sidebarReferenceUpdatedAt(key: SidebarReferenceKey): number {
  return entries.get(key)?.updatedAt ?? 0;
}

export function isSidebarReferenceStale(key: SidebarReferenceKey): boolean {
  const entry = entries.get(key);
  if (!entry) return true;
  if (entry.invalid) return true;
  return clock() - entry.updatedAt >= TTL_MS[key];
}

export function readSidebarReference<K extends SidebarReferenceKey>(key: K): SidebarReferenceValues[K] {
  const entry = entries.get(key);
  return (entry ? entry.value : DEFAULTS[key]) as SidebarReferenceValues[K];
}

export function readSidebarReferenceValues<K extends SidebarReferenceKey>(
  keys: readonly K[],
): Pick<SidebarReferenceValues, K> {
  const values: Partial<SidebarReferenceValues> = {};
  for (const key of keys) values[key] = readSidebarReference(key) as never;
  return values as Pick<SidebarReferenceValues, K>;
}

/** Publish a known-good value without a round trip (post-mutation update). */
export function updateSidebarReference<K extends SidebarReferenceKey>(
  key: K,
  value: SidebarReferenceValues[K],
): void {
  bumpGeneration(key);
  entries.set(key, { value, updatedAt: clock(), invalid: false });
  failures.delete(key);
  notify(key);
}

/** Mark keys untrue after a mutation: rows stay visible, the next read-through
 *  refetches them. */
export function invalidateSidebarReference(...keys: SidebarReferenceKey[]): void {
  for (const key of keys) {
    bumpGeneration(key);
    const entry = entries.get(key);
    if (entry) entry.invalid = true;
    // An explicit truth change outranks the failure backoff: retry at once.
    failures.delete(key);
  }
  // Tell the mounted panels. Settings/onboarding mutate reference data from an
  // overlay ABOVE the sidebar, so without this the panel underneath would keep
  // a stale snapshot until the next re-entry.
  scheduleInvalidationNotice(keys);
}

export function sidebarReferenceKeysForMutation(
  mutation: string,
  fallback: readonly SidebarReferenceKey[] = [],
): SidebarReferenceKey[] {
  const mapped = MUTATION_KEYS[mutation];
  return [...(mapped ?? fallback)];
}

/** Invalidate only what a KNOWN mutation makes untrue. Unmapped capabilities
 *  are left alone on purpose: no broad "something changed" sweep. */
export function invalidateSidebarReferenceForMutation(mutation: string): boolean {
  const keys = MUTATION_KEYS[mutation];
  if (!keys?.length) return false;
  invalidateSidebarReference(...keys);
  return true;
}

function needsRefresh(key: SidebarReferenceKey, force: boolean): boolean {
  const failure = failures.get(key);
  if (!force && failure && clock() - failure.failedAt < FAILURE_BACKOFF_MS) return false;
  const entry = entries.get(key);
  if (!entry) return true;
  return force || isSidebarReferenceStale(key);
}

/** One in-flight request per key: overlapping panels share the same fetch. */
function ensureSidebarReference(api: SidebarReferenceApi, key: SidebarReferenceKey): Promise<void> {
  const pending = inflight.get(key);
  if (pending) return pending;
  const generation = generations.get(key) ?? 0;
  const token: { promise?: Promise<void> } = {};
  const request = (async () => {
    try {
      const loader = LOADERS[key] as Loader<SidebarReferenceKey>;
      const value = await loader(api);
      if ((generations.get(key) ?? 0) !== generation) return;
      entries.set(key, { value, updatedAt: clock(), invalid: false });
      failures.delete(key);
    } catch (reason) {
      if ((generations.get(key) ?? 0) !== generation) return;
      // Failure never clears the snapshot: the panel keeps its rows, and the
      // backoff is recorded even when the key never loaded at all.
      failures.set(key, { failedAt: clock(), error: message(reason) });
    } finally {
      if (inflight.get(key) === token.promise) inflight.delete(key);
      notify(key);
    }
  })();
  token.promise = request;
  inflight.set(key, request);
  return request;
}

export interface SidebarReferenceLoadOutcome {
  error: string;
  /** The cache rebound to another host before this load could run; the caller
   *  must not apply the result. */
  superseded?: boolean;
}

export async function loadSidebarReferences(
  api: SidebarReferenceApi | undefined,
  keys: readonly SidebarReferenceKey[],
  options: { force?: boolean; onlyIfBound?: boolean } = {},
): Promise<SidebarReferenceLoadOutcome> {
  // Provenance gate: a caller that was created for an earlier host (a mutation
  // completion resolving after a host swap) must not re-adopt it.
  if (options.onlyIfBound && !isSidebarReferenceHost(api)) return { error: '', superseded: true };
  // Adoption comes FIRST — before the availability guard — so rebinding to an
  // unavailable or partial host still drops the previous host's snapshots.
  adoptSidebarReferenceHost(api);
  if (!api?.invokeCapability) return { error: '' };
  const force = options.force === true;
  const wanted = keys.filter((key) => needsRefresh(key, force));
  if (wanted.length) await Promise.all(wanted.map((key) => ensureSidebarReference(api, key)));
  for (const key of keys) {
    const failure = failures.get(key);
    if (failure) return { error: failure.error };
  }
  return { error: '' };
}

/** Boot prewarm: fill every sidebar reference key once, best effort. */
export async function prewarmSidebarReferences(api: SidebarReferenceApi | undefined): Promise<void> {
  try {
    await loadSidebarReferences(api, SIDEBAR_REFERENCE_KEYS);
  } catch {
    // Prewarm is an optimization; panels still load on demand.
  }
}

export function subscribeSidebarReferences(
  keys: readonly SidebarReferenceKey[],
  listener: () => void,
): () => void {
  for (const key of keys) {
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(listener);
  }
  return () => {
    for (const key of keys) listeners.get(key)?.delete(listener);
  };
}

/** Test seam only: drops every snapshot and (optionally) installs a clock. */
export function resetSidebarReferenceCache(options: { now?: () => number } = {}): void {
  entries.clear();
  inflight.clear();
  failures.clear();
  pendingNotice = null;
  for (const key of SIDEBAR_REFERENCE_KEYS) generations.set(key, (generations.get(key) ?? 0) + 1);
  boundApi = undefined;
  hostBound = false;
  clock = options.now ?? (() => Date.now());
}

function sameProjects(
  left: readonly DesktopProjectSummary[],
  right: readonly DesktopProjectSummary[],
): boolean {
  return left.length === right.length && left.every((row, index) => {
    const other = right[index];
    return Boolean(other) && row.path === other.path && row.name === other.name
      && row.alias === other.alias;
  });
}

/**
 * Publish the authoritative project catalog the app already holds. Project
 * add/rename/remove complete inside the app shell, which refetches its own
 * list; mirroring THAT result is the completion boundary — a failed mutation
 * leaves the list untouched, so nothing is published and no false refresh
 * happens. Returns true when the cache actually changed.
 */
export function publishSidebarProjects(projects: readonly DesktopProjectSummary[]): boolean {
  const cached = entries.get('projects');
  if (cached && sameProjects(cached.value as DesktopProjectSummary[], projects)) return false;
  updateSidebarReference('projects', [...projects]);
  return true;
}

export interface SidebarReferenceState<K extends SidebarReferenceKey> {
  values: Pick<SidebarReferenceValues, K>;
  /** True only before the first snapshot for the panel's primary key exists —
   *  a warm cache paints rows immediately, with no loading cover. */
  loading: boolean;
  /** False when the bound host cannot serve capabilities at all (missing or
   *  partial bridge): the panel shows its unavailable/empty state, not a
   *  loading cover that would never resolve. */
  available: boolean;
  error: string;
  refresh: (options?: { force?: boolean }) => Promise<void>;
  /** Host-scoped mutation completion: invalidate what the capability made
   *  untrue and read through once. A no-op once the cache left this host. */
  completeMutation: (mutation: string) => Promise<void>;
}

/**
 * Panel-side read API. `keys[0]` is the panel's primary resource (the one its
 * list is built from) and decides the loading cover; the rest ride along.
 * Pass a module-level constant array so the identity stays stable.
 */
export function useSidebarReferences<K extends SidebarReferenceKey>(
  api: SidebarReferenceApi | undefined,
  keys: readonly K[],
  active = true,
): SidebarReferenceState<K> {
  const primary: K | undefined = keys[0];
  const available = Boolean(api?.invokeCapability);
  const [revision, setRevision] = useState(0);
  // Read-through status is HOST-SCOPED: settled and error both belong to the
  // host they came from, so host B's first paint shows neither A's rows nor
  // A's failure, and a dropped cache falls back to the cover (not an empty
  // panel).
  const [status, setStatus] = useState<{
    host: SidebarReferenceApi | undefined;
    settled: boolean;
    error: string;
  }>({ host: api, settled: false, error: '' });
  const current = status.host === api;
  const settled = current && status.settled;
  const error = current ? status.error : '';
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Synchronous seed: whatever the cache already holds paints on first render.
  // Adoption runs INSIDE this memo, before the read, so a host swap clears the
  // previous host's data in the very same render that first observes the swap.
  const values = useMemo(() => {
    adoptSidebarReferenceHost(api);
    return readSidebarReferenceValues(keys);
  }, [api, keys, revision]);

  const refresh = useCallback(async (options?: { force?: boolean }) => {
    // `onlyIfBound` is the provenance gate: a refresh captured for host A (a
    // mutation completing after the app rebound to host B) must not re-adopt A.
    const outcome = await loadSidebarReferences(api, keys, { ...options, onlyIfBound: true });
    if (!mounted.current || outcome.superseded) return;
    // Values re-render through the cache subscription; only the host-scoped
    // status is owned here, and an unchanged status keeps its object so the
    // revalidation effect below cannot feed itself.
    setStatus((previous) => (previous.host === api && previous.settled && previous.error === outcome.error
      ? previous
      : { host: api, settled: true, error: outcome.error }));
  }, [api, keys]);

  const completeMutation = useCallback(async (mutation: string) => {
    if (!isSidebarReferenceHost(api)) return;
    invalidateSidebarReference(...sidebarReferenceKeysForMutation(mutation, keys));
    await refresh();
  }, [api, keys, refresh]);

  useEffect(() => subscribeSidebarReferences(keys, () => {
    if (mounted.current) setRevision((value) => value + 1);
  }), [keys]);
  useEffect(() => {
    // Hidden panels hydrate too: App pre-mounts rail destinations so the first
    // click is a warm, atomic reveal.
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // Re-entry AND external invalidation (settings/onboarding mutating shared
    // reference data from an overlay) revalidate silently while the mounted
    // rows stay on screen. Only stale keys trigger work, so a fresh cache and
    // a failure inside its backoff both settle immediately instead of looping.
    if (!active || !available) return;
    if (!keys.some((key) => isSidebarReferenceStale(key))) return;
    void refresh();
  }, [active, available, keys, refresh, revision]);

  return {
    values,
    loading: available && !settled && (primary === undefined || !hasSidebarReference(primary)),
    available,
    error,
    refresh,
    completeMutation,
  };
}
