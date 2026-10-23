// The provider accounts behind "Expand all accounts": one `getProviderAccounts`
// roster per provider — the same read Settings › Providers renders its account
// usage from — shared by the sidebar usage panel and the pinned rail.
import { useEffect, useSyncExternalStore } from 'react';
import { record } from './record-utils';
import { getUsageDashboardSnapshot, subscribeUsageDashboard, type UsageApi } from './usage-dashboard-store';

export const PROVIDER_ACCOUNTS_CHANGED = 'mixdog:provider-accounts-changed';

export interface UsageAccount {
  id: string;
  label: string;
  email: string;
  blockedUntil: number | null;
  /** Held by a limit (account-wide, or one model family's meter). */
  limited: boolean;
  /** Quota windows last read for this account, as the roster carries them. */
  windows: Record<string, unknown>[];
}

export interface UsageAccountPool {
  accounts: UsageAccount[];
  selectedId: string | null;
}

let pools: ReadonlyMap<string, UsageAccountPool> = new Map();
const signatures = new Map<string, string>();
const listeners = new Set<() => void>();
const EMPTY: ReadonlyMap<string, UsageAccountPool> = new Map();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function parsePool(value: unknown): UsageAccountPool | null {
  const result = record(value);
  if (!Array.isArray(result.accounts)) return null;
  const accounts = result.accounts.map(record).flatMap((row): UsageAccount[] => {
    if (typeof row.id !== 'string' || !row.id) return [];
    const usage = record(row.usage);
    const blockedUntil = Number(row.blockedUntil);
    return [
      {
        id: row.id,
        label: typeof row.label === 'string' ? row.label : '',
        email: typeof row.email === 'string' ? row.email : '',
        blockedUntil: Number.isFinite(blockedUntil) && blockedUntil > 0 ? blockedUntil : null,
        limited: Boolean(row.limit),
        windows: Array.isArray(usage.windows) ? usage.windows.map(record) : [],
      },
    ];
  });
  return { accounts, selectedId: typeof result.selectedId === 'string' ? result.selectedId : null };
}

function publish(provider: string, pool: UsageAccountPool): void {
  const signature = JSON.stringify(pool);
  if (signatures.get(provider) === signature) return;
  signatures.set(provider, signature);
  pools = new Map(pools).set(provider, pool);
  for (const listener of [...listeners]) listener();
}

// One shared watch per active provider, however many components use it: a
// single in-flight read (a change during it earns one follow-up read), and a
// generation per provider so a response from a retired request — one
// superseded or outlived by its watcher — never publishes.
interface Watch {
  count: number;
  inflight: boolean;
  dirty: boolean;
  /** The provider's own dashboard row when its roster was last asked for. */
  row: string;
  /** When its roster was last asked for. */
  readAt: number;
}

/** A publication that leaves a provider's own row alone still rereads its
 *  roster once this long after the last read: the dashboard row shows only the
 *  account in use, while accounts added, removed or measured elsewhere (another
 *  device, a refresh of every account) show up only in the roster. */
export const ACCOUNT_REREAD_WINDOW_MS = 30_000;
const watches = new Map<string, Watch>();
const generations = new Map<string, number>();
let watchApi: UsageApi | undefined;
let detachShared: (() => void) | null = null;

function bumpGeneration(provider: string): number {
  const next = (generations.get(provider) ?? 0) + 1;
  generations.set(provider, next);
  return next;
}

function read(provider: string): void {
  const watch = watches.get(provider);
  const api = watchApi;
  if (!watch || !api?.invokeCapability) return;
  if (watch.inflight) {
    watch.dirty = true;
    return;
  }
  watch.inflight = true;
  watch.readAt = Date.now();
  const generation = bumpGeneration(provider);
  void Promise.resolve(api.invokeCapability({ capability: 'getProviderAccounts', args: [provider] }))
    .then((response) => {
      const pool = parsePool(response?.value);
      if (pool && generations.get(provider) === generation && watches.has(provider)) publish(provider, pool);
    })
    .catch(() => undefined)
    .finally(() => {
      watch.inflight = false;
      if (watch.dirty && watches.get(provider) === watch) {
        watch.dirty = false;
        read(provider);
      }
    });
}

/** The rosters changed or were re-measured outside the dashboard (another
 *  list's refresh of every account): reread every watched provider now. */
export function readAll(): void {
  for (const provider of watches.keys()) read(provider);
}

/** The provider's own row of the usage dashboard, as text. */
function dashboardRow(provider: string): string {
  const rows = getUsageDashboardSnapshot().dashboard.rows;
  return JSON.stringify((Array.isArray(rows) ? rows : []).find((row) => record(row).id === provider) ?? null);
}

function attachShared(): void {
  // Account switches, sign-ins and removals announce themselves. The dashboard
  // notifies on every publication (a phone's boot makes many, each carrying
  // every provider), so a provider rereads when its OWN row changed, else at
  // most once per window.
  const unsubscribe = subscribeUsageDashboard(() => {
    for (const [provider, watch] of watches) {
      const row = dashboardRow(provider);
      if (row === watch.row && Date.now() - watch.readAt < ACCOUNT_REREAD_WINDOW_MS) continue;
      watch.row = row;
      read(provider);
    }
  });
  window.addEventListener(PROVIDER_ACCOUNTS_CHANGED, readAll);
  detachShared = () => {
    unsubscribe();
    window.removeEventListener(PROVIDER_ACCOUNTS_CHANGED, readAll);
  };
}

function watchProviders(api: UsageApi, providers: readonly string[]): () => void {
  watchApi = api;
  if (!detachShared) attachShared();
  // Only a new watch starts a read; later watchers join what is current or in flight.
  const created: string[] = [];
  for (const provider of providers) {
    let watch = watches.get(provider);
    if (!watch) {
      watch = { count: 0, inflight: false, dirty: false, row: dashboardRow(provider), readAt: 0 };
      watches.set(provider, watch);
      created.push(provider);
    }
    watch.count += 1;
  }
  for (const provider of created) read(provider);
  return () => {
    for (const provider of providers) {
      const watch = watches.get(provider);
      if (!watch || --watch.count > 0) continue;
      watches.delete(provider);
      bumpGeneration(provider);
    }
    if (watches.size === 0) {
      detachShared?.();
      detachShared = null;
    }
  };
}

/** Only OAuth subscriptions keep an account roster. */
const supportsAccounts = (provider: string) => provider.endsWith('-oauth');

/** The account rosters of `providers` while `enabled`; reread when the account
 *  list changes or a new quota result lands. */
export function useUsageAccountPools(
  api: UsageApi | undefined,
  providers: readonly string[],
  enabled: boolean
): ReadonlyMap<string, UsageAccountPool> {
  const current = useSyncExternalStore(subscribe, () => pools);
  const key = providers.filter(supportsAccounts).join('|');
  useEffect(() => {
    const wanted = key ? key.split('|') : [];
    if (!enabled || !api?.invokeCapability || wanted.length === 0) return undefined;
    return watchProviders(api, wanted);
  }, [api, enabled, key]);
  return enabled ? current : EMPTY;
}

/** Providers listing every account: only a roster of two or more expands. */
export function expandableAccounts(pool: UsageAccountPool | undefined): UsageAccount[] {
  return pool && pool.accounts.length >= 2 ? pool.accounts : [];
}
