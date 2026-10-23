// The models a Workflows editor dialog offers. The panel's own list comes from
// the sidebar reference cache, which can hold a boot-time partial (or empty)
// catalog for a day, so a picker opened from it could lack a connected
// provider that Settings → Model management lists. Settings reads the catalog
// when it opens; an open editor does the same, and keeps asking while the
// answer is partial until the daemon's refill lands. The cached list only
// stands in while the first read is pending or when it fails.
import { useEffect, useMemo, useState } from 'react';
import type { DesktopApi, DesktopModelOption } from '../shared/contract';
import { requireDesktopProviders } from './desktop-provider-retry';
import { customProviderDisplayNames, filterConfiguredModels } from './model-catalog';
import { fetchProviderModels, partialModelCatalogExpiry } from './model-catalog-cache';
import { normalizeModelOptions } from './provider-display';
import { record } from './record-utils';

type EditorCatalogApi = Partial<Pick<DesktopApi, 'invokeCapability' | 'listProviderModels'>>;

/** How soon a provisional (pendingSecrets) setup is read again. */
const PENDING_SETUP_RETRY_MS = 2_000;

/** A setup that cannot say which providers are connected yet: missing, or the
 *  no-secrets snapshot served while the keychain loads. */
function provisional(setup: unknown): boolean {
  return setup == null || record(setup).pendingSecrets === true;
}

export function useEditorModelCatalog(
  api: EditorCatalogApi | undefined,
  open: boolean,
  cachedModels: DesktopModelOption[],
  cachedSetup: unknown,
  cachedNames: Record<string, string> | undefined
): { models: DesktopModelOption[]; providerNames?: Record<string, string> } {
  const [fresh, setFresh] = useState<{ models: DesktopModelOption[]; setup: unknown } | null>(null);
  useEffect(() => {
    if (!open || !api?.listProviderModels) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const [models, setup] = await Promise.all([
          fetchProviderModels(api, { quick: false }),
          // A failed setup read keeps the cached setup's connected-provider filter.
          Promise.resolve(api.invokeCapability?.<unknown>({ capability: 'getProviderSetup', args: [] }))
            .then((result) => requireDesktopProviders(result?.value))
            .catch(() => undefined),
        ]);
        if (!live) return;
        setFresh({ models, setup });
        const retryAt = partialModelCatalogExpiry(models);
        const delays = [
          ...(retryAt === null ? [] : [Math.max(0, retryAt - Date.now())]),
          ...(provisional(setup) ? [PENDING_SETUP_RETRY_MS] : []),
        ];
        if (delays.length) timer = setTimeout(() => void load(), Math.min(...delays));
      } catch {
        // The cached list stays.
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
      setFresh(null);
    };
  }, [api, open]);
  return useMemo(() => {
    if (!open || !fresh?.models.length) return { models: cachedModels, providerNames: cachedNames };
    const providerSetup = fresh.setup ?? cachedSetup;
    // A provisional setup (secrets still loading) reads providers as not
    // connected: like Settings, keep the usable list until the real one comes.
    if (provisional(providerSetup)) {
      return {
        models: cachedModels.length ? cachedModels : normalizeModelOptions(fresh.models),
        providerNames: cachedNames,
      };
    }
    return {
      models: filterConfiguredModels(normalizeModelOptions(fresh.models), providerSetup),
      providerNames: customProviderDisplayNames(providerSetup),
    };
  }, [open, fresh, cachedModels, cachedSetup, cachedNames]);
}
