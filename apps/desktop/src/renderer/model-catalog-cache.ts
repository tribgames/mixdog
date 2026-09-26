import type { DesktopApi, DesktopModelOption } from '../shared/contract';
import { catalogStorageKey, catalogStorageScope } from './catalog-storage-scope';

const MODEL_CATALOG_STORAGE_KEY = 'mixdog.desktop-model-catalog.v2';
const MODEL_CATALOG_LIMIT = 1_000;

interface CachedModelCatalog {
  models: DesktopModelOption[];
  updatedAt: number;
}

function effortOptions(value: unknown): DesktopModelOption['effortOptions'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const option = entry as Record<string, unknown>;
    const optionValue = String(option.value || '').trim();
    const label = String(option.label || '').trim();
    return optionValue && label ? [{ value: optionValue, label }] : [];
  });
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
      const normalizedKey = key.trim();
      const normalizedValue = typeof entry === 'string' ? entry.trim() : '';
      return normalizedKey && normalizedValue ? [[normalizedKey, normalizedValue]] : [];
    })
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function parameterOptionValues(value: unknown): Array<{ value: string; label: string; contextWindow?: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const option = raw as Record<string, unknown>;
    const optionValue = String(option.value || '').trim();
    const optionLabel = String(option.label || optionValue).trim();
    if (!optionValue || !optionLabel) return [];
    const contextWindow = Number(option.contextWindow);
    const entry: { value: string; label: string; contextWindow?: number } = { value: optionValue, label: optionLabel };
    if (Number.isFinite(contextWindow) && contextWindow > 0) entry.contextWindow = contextWindow;
    return [entry];
  });
}

function parameterOptions(value: unknown): DesktopModelOption['modelParameterOptions'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const parameter = entry as Record<string, unknown>;
    const id = String(parameter.id || '').trim();
    const label = String(parameter.label || id).trim();
    let kind: 'boolean' | 'enum' | null = null;
    if (parameter.kind === 'boolean' || parameter.kind === 'enum') kind = parameter.kind;
    const options = parameterOptionValues(parameter.options);
    return id && label && kind && options.length ? [{ id, label, kind, options }] : [];
  });
}

function parameterVariants(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value)) return [];
  return value.map(stringRecord).filter((entry) => Object.keys(entry).length > 0);
}

function modelOption(value: unknown): DesktopModelOption | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const option = value as Record<string, unknown>;
  const provider = String(option.provider || '').trim();
  const model = String(option.model || '').trim();
  if (!provider || !model) return null;
  return {
    provider,
    model,
    display: String(option.display || model).trim() || model,
    ...(typeof option.created === 'number' && Number.isFinite(option.created) ? { created: option.created } : {}),
    ...(typeof option.releaseDate === 'string' ? { releaseDate: option.releaseDate } : {}),
    ...(typeof option.contextWindow === 'number' && Number.isFinite(option.contextWindow)
      ? { contextWindow: option.contextWindow }
      : {}),
    ...(typeof option.maxContextWindow === 'number' && Number.isFinite(option.maxContextWindow)
      ? { maxContextWindow: option.maxContextWindow }
      : {}),
    ...(typeof option.family === 'string' ? { family: option.family } : {}),
    ...(typeof option.latest === 'boolean' ? { latest: option.latest } : {}),
    ...(typeof option.description === 'string' ? { description: option.description } : {}),
    ...(option.supportsVision === true ? { supportsVision: true } : {}),
    effortOptions: effortOptions(option.effortOptions),
    fastCapable: option.fastCapable === true,
    fastEfforts: stringArray(option.fastEfforts),
    fastPreferred: option.fastPreferred === true,
    ...(typeof option.savedEffort === 'string' ? { savedEffort: option.savedEffort } : {}),
    ...(typeof option.savedFast === 'boolean' ? { savedFast: option.savedFast } : {}),
    ...(typeof option.savedContextPercent === 'number' && Number.isFinite(option.savedContextPercent)
      ? { savedContextPercent: option.savedContextPercent }
      : {}),
    ...(typeof option.defaultEffort === 'string' ? { defaultEffort: option.defaultEffort } : {}),
    ...(typeof option.defaultFast === 'boolean' ? { defaultFast: option.defaultFast } : {}),
    modelParameterOptions: parameterOptions(option.modelParameterOptions),
    parameterVariants: parameterVariants(option.parameterVariants),
    defaultModelParameters: stringRecord(option.defaultModelParameters),
    savedModelParameters: stringRecord(option.savedModelParameters),
  };
}

export function readCachedModelCatalog(): CachedModelCatalog {
  try {
    const stored = JSON.parse(window.localStorage.getItem(catalogStorageKey(MODEL_CATALOG_STORAGE_KEY)) || 'null');
    const record =
      stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
    const models = Array.isArray(record.models)
      ? record.models
          .map(modelOption)
          .filter((entry): entry is DesktopModelOption => entry !== null)
          .slice(0, MODEL_CATALOG_LIMIT)
      : [];
    return {
      models,
      updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
    };
  } catch {
    return { models: [], updatedAt: 0 };
  }
}

export function writeCachedModelCatalog(
  models: DesktopModelOption[],
  scope = catalogStorageScope()
): CachedModelCatalog {
  const catalog = { models: normalizeModelCatalog(models), updatedAt: Date.now() };
  try {
    window.localStorage.setItem(catalogStorageKey(MODEL_CATALOG_STORAGE_KEY, scope), JSON.stringify(catalog));
  } catch {
    // The live catalog remains usable when browser storage is unavailable.
  }
  return catalog;
}

function normalizeModelCatalog(models: unknown): DesktopModelOption[] {
  if (!Array.isArray(models)) return [];
  const unique = new Map<string, DesktopModelOption>();
  for (const raw of models) {
    const option = modelOption(raw);
    if (option) unique.set(`${option.provider}:${option.model}`, option);
    if (unique.size >= MODEL_CATALOG_LIMIT) break;
  }
  return [...unique.values()];
}

// ---------------------------------------------------------------------------
// One catalog fetch for every caller
// ---------------------------------------------------------------------------
// The route picker, the sidebar panels and settings each read the catalog on
// their own, and at boot a phone paid the whole ~140 KB list once per caller
// within a few seconds. Every caller goes through here instead: identical
// requests join the one in flight, a completed full catalog answers quick and
// full reads for a short window, and an explicit refresh always goes out and
// then becomes the answer everyone shares.

export const PROVIDER_MODELS_FRESH_MS = 30_000;

type ProviderModelsApi = Partial<Pick<DesktopApi, 'listProviderModels'>>;

interface ProviderModelsFetchState {
  scope: string;
  generation: number;
  quick?: Promise<DesktopModelOption[]>;
  full?: Promise<DesktopModelOption[]>;
  complete?: { models: DesktopModelOption[]; at: number };
}

const PROVIDER_MODEL_FETCHES = new WeakMap<object, ProviderModelsFetchState>();
let providerModelsGeneration = 0;

function providerModelsFetchState(api: object): ProviderModelsFetchState {
  const scope = catalogStorageScope();
  const current = PROVIDER_MODEL_FETCHES.get(api);
  if (current && current.scope === scope && current.generation === providerModelsGeneration) return current;
  // Another device route or a provider change: nothing held answers for it.
  const created: ProviderModelsFetchState = { scope, generation: providerModelsGeneration };
  PROVIDER_MODEL_FETCHES.set(api, created);
  return created;
}

/** A quick answer is the full catalog only when the daemon says so on every
 *  row; an older daemon never does, and its caller keeps the full follow-up. */
function completeQuickAnswer(models: readonly unknown[]): boolean {
  return (
    models.length > 0 &&
    models.every((row) => Boolean(row) && (row as { catalogComplete?: unknown }).catalogComplete === true)
  );
}

export function fetchProviderModels(
  api: ProviderModelsApi,
  { quick = false, force = false }: { quick?: boolean; force?: boolean } = {}
): Promise<DesktopModelOption[]> {
  if (typeof api.listProviderModels !== 'function') return Promise.resolve([]);
  const state = providerModelsFetchState(api);
  if (!force) {
    const complete = state.complete;
    if (complete && Date.now() - complete.at < PROVIDER_MODELS_FRESH_MS) return Promise.resolve(complete.models);
    const joined = quick ? state.quick : state.full;
    if (joined) return joined;
  }
  // Issued now, so the slot below is visible to the very next caller.
  const issued = new Promise<unknown>((resolve) => resolve(api.listProviderModels!({ quick })));
  const request = issued.then((value) => {
    const models: DesktopModelOption[] = Array.isArray(value) ? value : [];
    if (PROVIDER_MODEL_FETCHES.get(api) === state && (!quick || completeQuickAnswer(models))) {
      state.complete = { models, at: Date.now() };
    }
    return models;
  });
  const slot = quick ? 'quick' : 'full';
  state[slot] = request;
  const release = () => {
    if (state[slot] === request) state[slot] = undefined;
  };
  void request.then(release, release);
  return request;
}

// ---------------------------------------------------------------------------
// Shared live request
// ---------------------------------------------------------------------------
// Every mounted route control reads the SAME catalog fetch: panes, sessions
// and remounts must not each hit the daemon for a list that changes daily.
// The share therefore lives a full day — which is exactly why a FAILED
// request may never join it. A stored rejection replays the same error to
// every later caller, so one transient daemon hiccup would pin "Model
// catalog unavailable" onto a surface that never reloads (the mobile PWA)
// long after the daemon recovered.

type SharedModelCatalogRequest = {
  api: DesktopApi;
  scope: string;
  isCurrent(): boolean;
  startedAt: number;
  quick: Promise<DesktopModelOption[]>;
  full: Promise<DesktopModelOption[]>;
  setup: Promise<unknown>;
};

export const SHARED_MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60_000;
let sharedModelCatalogRequest: SharedModelCatalogRequest | null = null;
let catalogGeneration = 0;
const invalidationListeners = new Set<() => void>();

/** Forgets the shared request, so the next caller fetches again. Guarded by
 *  identity: a newer request must survive an older one's late failure. */
function dropSharedModelCatalogRequest(request: SharedModelCatalogRequest): void {
  if (sharedModelCatalogRequest === request) sharedModelCatalogRequest = null;
}

export function subscribeModelCatalogInvalidation(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

/** Drops the shared request and wakes mounted pickers after provider changes. */
export function invalidateSharedModelCatalogRequest(): void {
  catalogGeneration += 1;
  providerModelsGeneration += 1;
  sharedModelCatalogRequest = null;
  for (const listener of [...invalidationListeners]) {
    queueMicrotask(() => {
      if (invalidationListeners.has(listener)) listener();
    });
  }
}

export function requestModelCatalog(api: DesktopApi): SharedModelCatalogRequest {
  const scope = catalogStorageScope();
  const current = sharedModelCatalogRequest;
  if (
    current &&
    current.api === api &&
    current.scope === scope &&
    Date.now() - current.startedAt < SHARED_MODEL_CATALOG_MAX_AGE_MS
  ) {
    return current;
  }
  const generation = ++catalogGeneration;
  const isCurrent = () => generation === catalogGeneration && scope === catalogStorageScope();
  const quick = fetchProviderModels(api, { quick: true }).then(normalizeModelCatalog);
  const quickSettled = quick.catch(() => []);
  // A quick answer that was already the full catalog leaves this read to the
  // shared result instead of the wire.
  const full = quickSettled
    .then(() => fetchProviderModels(api, { quick: false }))
    .then((models) => {
      if (!isCurrent()) return normalizeModelCatalog(models);
      return writeCachedModelCatalog(Array.isArray(models) ? models : [], scope).models;
    });
  const setup = api.invokeCapability
    ? quickSettled
        .then(() =>
          api.invokeCapability<unknown>({
            capability: 'getProviderSetup',
            args: [],
          })
        )
        .then((result) => result.value)
    : Promise.resolve(null);
  const request: SharedModelCatalogRequest = {
    api,
    scope,
    isCurrent,
    startedAt: Date.now(),
    quick,
    full,
    setup,
  };
  sharedModelCatalogRequest = request;
  // Eviction rides a DERIVED promise: the caller still receives the original
  // rejection, and the derived one is handled so nothing reports unhandled.
  void full.catch(() => dropSharedModelCatalogRequest(request));
  void setup.catch(() => dropSharedModelCatalogRequest(request));
  return request;
}
