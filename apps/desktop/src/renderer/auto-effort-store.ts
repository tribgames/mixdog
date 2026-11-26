import { useEffect, useSyncExternalStore } from 'react';
import type { RecordValue } from './desktop-types';
import { cachedModelCatalogRevision, readCachedModelCatalog, subscribeCachedModelCatalog } from './model-catalog-cache';
import { readEffortAuto } from './route-auto-effort';
import { subscribeSetupChanges } from './setup-change-refresh';

export {
  convertLegacyAutoEffort,
  effortAutoField,
  effortAutoKey,
  mergeEffortAuto,
  needsLegacyAutoEffortConversion,
  pickEffortAuto,
  readEffortAuto,
  resolveEffortAuto,
  type EffortAutoState,
} from './route-auto-effort';

export type AutoEffortState = { installed: boolean; enabled: boolean; supported: boolean };

let current: AutoEffortState | null = null;
let reading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Publish the `autoEffort` entry of a tool-module settings answer. */
export function publishAutoEffort(settings: unknown): void {
  const entry = (settings as RecordValue | undefined)?.autoEffort as RecordValue | undefined;
  if (!entry) return;
  current = {
    installed: entry.installed === true,
    enabled: entry.enabled === true,
    supported: entry.supported !== false,
  };
  for (const listener of listeners) listener();
}

// A change announced while a read is out may postdate what that read answers:
// one more read follows it.
let rereadQueued = false;

function refreshAutoEffort(): Promise<void> {
  reading ??= window.mixdogDesktop
    .invokeCapability<RecordValue>({ capability: 'getToolModuleSettings', args: [] })
    .then((result) => publishAutoEffort(result?.value))
    .catch(() => {
      /* the switch keeps its last known state */
    })
    .finally(() => {
      reading = null;
      if (rereadQueued) {
        rereadQueued = false;
        void refreshAutoEffort();
      }
    });
  return reading;
}

/** The setting may have changed: re-read what is known or being read. */
function invalidateAutoEffort(): void {
  if (reading) rereadQueued = true;
  else if (current !== null) void refreshAutoEffort();
}

// While anything shows the switch, a setting changed elsewhere (another
// window, the phone, the setup tool, a hand edit) is re-read.
let stopSetupSync: (() => void) | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  stopSetupSync ??= subscribeSetupChanges(invalidateAutoEffort);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopSetupSync?.();
      stopSetupSync = null;
    }
  };
}

/** Ensure the host's Auto effort tool-module state has been read at least once
 *  (used by one-time legacy localStorage conversion on load). */
export async function ensureAutoEffortLoaded(): Promise<AutoEffortState | null> {
  if (current !== null) return current;
  await refreshAutoEffort();
  return current;
}

function judgeAvailable(master: AutoEffortState | null): boolean {
  return master?.installed === true && master.supported;
}

/** Whether Auto reasoning is active for a route: ONLY explicit `effortAuto === true`
 *  with the judge runtime installed & supported. Never reads the legacy feature switch. */
export function routeAutoEffortActive(
  effortAuto: boolean | null | undefined,
  master: AutoEffortState | null
): boolean {
  return judgeAvailable(master) && readEffortAuto(effortAuto) === true;
}

export function compactEffortName(effort: string | null | undefined): string {
  const raw = String(effort || '').trim();
  if (!raw) return '';
  if (/^(?:extra[\s-]*high|xhigh)$/i.test(raw)) return 'XHigh';
  return `${raw.slice(0, 1).toLocaleUpperCase()}${raw.slice(1).toLowerCase()}`;
}

export function formatAutoEffortLabel(resolvedEffort?: string | null): string {
  const resolved = compactEffortName(resolvedEffort);
  return resolved ? `Auto (${resolved})` : 'Auto';
}

/** The host accepts per-route Auto reasoning: the `effortAuto` selection field
 *  and `+noauto` automation refs. An older remote host rejects both. */
export function hostRouteAutoEffort(): boolean {
  return window.mixdogDesktop?.routeAutoEffort === true;
}

/** A model whose route may carry its own `effortAuto` on this host. */
export function routeAutoEffortCapable(option: { autoEffortCapable?: boolean } | null | undefined): boolean {
  return option?.autoEffortCapable === true && hostRouteAutoEffort();
}

/** RouteEditor's Auto props for a model: Auto is offered as an effort choice
 *  whenever the model supports it, the host takes per-route Auto, and the judge
 *  runtime is installed and supported. */
export function useAutoEffortRoute(
  capable: boolean,
  effortAuto: boolean | null | undefined,
  onChange: (enabled: boolean) => unknown,
  modelKnown = false
) {
  const hostSupportsRouteAuto = hostRouteAutoEffort();
  const wantsMaster = hostSupportsRouteAuto && (capable || modelKnown);
  const master = useAutoEffort(wantsMaster);
  const available = hostSupportsRouteAuto && judgeAvailable(master);
  let autoEffort: { enabled: boolean; pending: boolean; unavailable?: boolean } | null = null;
  if (capable && available) autoEffort = { enabled: routeAutoEffortActive(effortAuto, master), pending: false };
  // The core says Auto cannot apply to this model: the sheet says so instead of
  // offering a setting that would do nothing, and the level in force stays shown.
  else if (modelKnown && !capable && available) autoEffort = { enabled: false, pending: false, unavailable: true };
  return {
    autoEffort,
    onChangeAutoEffort: (enabled: boolean) => {
      void onChange(enabled);
    },
    onOpenSheet: () => {
      if (wantsMaster) void refreshAutoEffort();
    },
  };
}

/** The single rule for an effort label: "Auto" when Auto is active and the
 *  model supports it, whatever level is saved; otherwise null, meaning "show
 *  the saved level". */
export function displayEffortLabel(_savedEffort: string, opts: { autoOn: boolean; capable: boolean }): 'Auto' | null {
  return opts.autoOn && opts.capable ? 'Auto' : null;
}

/** The cached catalog's revision: a reader that keeps what `cachedAutoEffortCapable`
 *  told it reads again when this changes. */
export function useModelCatalogRevision(): number {
  return useSyncExternalStore(subscribeCachedModelCatalog, cachedModelCatalogRevision);
}

/** Whether the catalog (localStorage cache the composer fills) marks this
 *  provider/model as supporting Auto reasoning. */
export function cachedAutoEffortCapable(provider: string, model: string): boolean {
  return readCachedModelCatalog().models.some(
    (entry) => entry.provider === provider && entry.model === model && entry.autoEffortCapable === true
  );
}

/** Live `displayEffortLabel` for a route. */
export function useAutoEffortShown(capable: boolean, savedEffort: string, effortAuto?: boolean | null): boolean {
  const master = useAutoEffort(capable);
  const autoOn = routeAutoEffortActive(effortAuto, master);
  return displayEffortLabel(savedEffort, { autoOn, capable }) !== null;
}

/** The Auto reasoning state (judge availability + legacy default); `wanted` triggers the first read. */
export function useAutoEffortState(wanted: boolean): AutoEffortState | null {
  return useAutoEffort(wanted);
}

/** The legacy feature switch is installed, supported and on; `wanted` triggers the first read. */
export function useAutoEffortMasterOn(wanted: boolean): boolean {
  const master = useAutoEffort(wanted);
  return judgeAvailable(master) && master?.enabled === true;
}

/** The switch state; `wanted` (the model supports it) triggers the first read. */
function useAutoEffort(wanted: boolean): AutoEffortState | null {
  useEffect(() => {
    if (wanted && current === null) void refreshAutoEffort();
  }, [wanted]);
  return useSyncExternalStore(subscribe, () => current);
}
