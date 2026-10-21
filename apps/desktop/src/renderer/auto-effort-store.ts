import { useEffect, useSyncExternalStore } from 'react';
import type { RecordValue } from './desktop-types';
import { readCachedModelCatalog } from './model-catalog-cache';

// The app-wide Auto reasoning MASTER switch (Settings → Built-in). It is read
// once on demand (only a model that supports it asks), re-read when a sheet
// opens, and published by Settings when it changes. Each route keeps its own
// `autoEffort` flag (absent = on); the master gates whether routes show Auto.
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

function refreshAutoEffort(): Promise<void> {
  reading ??= window.mixdogDesktop
    .invokeCapability<RecordValue>({ capability: 'getToolModuleSettings', args: [] })
    .then((result) => publishAutoEffort(result?.value))
    .catch(() => {
      /* the switch keeps its last known state */
    })
    .finally(() => {
      reading = null;
    });
  return reading;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The route's own Auto flag: only an explicit `false` turns it off. */
export function routeAutoEffortOn(routeAutoEffort: boolean | null | undefined): boolean {
  return routeAutoEffort !== false;
}

function masterAutoEffortOn(master: AutoEffortState | null): boolean {
  return master?.installed === true && master.supported && master.enabled;
}

/** The host accepts per-route Auto reasoning: the `autoEffort` selection field
 *  and `+noauto` automation refs. An older remote host rejects both. */
export function hostRouteAutoEffort(): boolean {
  return window.mixdogDesktop?.routeAutoEffort === true;
}

/** A model whose route may carry its own `autoEffort` on this host. */
export function routeAutoEffortCapable(option: { autoEffortCapable?: boolean } | null | undefined): boolean {
  return option?.autoEffortCapable === true && hostRouteAutoEffort();
}

/** RouteEditor's Auto props for a model: the switch shows only when the model
 *  supports it, the host takes per-route Auto, and the master (Settings →
 *  Built-in) is installed, supported and enabled; its state and changes belong
 *  to the route, never the master. */
export function useAutoEffortRoute(
  capable: boolean,
  routeAutoEffort: boolean | null | undefined,
  onChange: (enabled: boolean) => unknown
) {
  const master = useAutoEffort(capable);
  return {
    autoEffort:
      capable && hostRouteAutoEffort() && masterAutoEffortOn(master)
        ? { enabled: routeAutoEffortOn(routeAutoEffort), pending: false }
        : null,
    onChangeAutoEffort: (enabled: boolean) => {
      void onChange(enabled);
    },
    onOpenSheet: () => {
      if (capable) void refreshAutoEffort();
    },
  };
}

/** The single rule for an effort label: "Auto" when the switch is on and the
 *  model supports it, whatever level is saved (Auto's base is the global
 *  "Auto reasoning base" setting); otherwise null, meaning "show the saved
 *  level". */
export function displayEffortLabel(_savedEffort: string, opts: { autoOn: boolean; capable: boolean }): 'Auto' | null {
  return opts.autoOn && opts.capable ? 'Auto' : null;
}

/** Whether the catalog (localStorage cache the composer fills) marks this
 *  provider/model as supporting Auto reasoning. */
export function cachedAutoEffortCapable(provider: string, model: string): boolean {
  return readCachedModelCatalog().models.some(
    (entry) => entry.provider === provider && entry.model === model && entry.autoEffortCapable === true
  );
}

/** Live `displayEffortLabel` for a route: "Auto" needs the master switch on AND
 *  the route's own `autoEffort` not turned off. */
export function useAutoEffortShown(capable: boolean, savedEffort: string, routeAutoEffort?: boolean | null): boolean {
  const master = useAutoEffort(capable);
  const autoOn = masterAutoEffortOn(master) && routeAutoEffortOn(routeAutoEffort);
  return displayEffortLabel(savedEffort, { autoOn, capable }) !== null;
}

/** The switch state; `wanted` (the model supports it) triggers the first read. */
function useAutoEffort(wanted: boolean): AutoEffortState | null {
  useEffect(() => {
    if (wanted && current === null) void refreshAutoEffort();
  }, [wanted]);
  return useSyncExternalStore(subscribe, () => current);
}
