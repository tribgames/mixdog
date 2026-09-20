// provider-models/row-hydration.mjs
// Turning cached catalog rows into picker rows: the user's saved per-model
// settings (alias, effort, fast, parameters, context budget) layered on top,
// then the route-provider-first sort.
import { effortItemsFor } from '../effort.mjs';
import { fastCapableFor, fastPreferenceFor } from '../model-capabilities.mjs';
import { modelSettingsFor } from '../config-helpers.mjs';

export function hydrateProviderModelRow(cfg, row) {
  const saved = modelSettingsFor(cfg, row.provider, row.id);
  // Display-only user alias (modelSettings["provider/model"].alias). It
  // replaces the label everywhere the row's `display` is shown; the id and
  // route selection are untouched.
  const alias = typeof saved.alias === 'string' ? saved.alias.trim() : '';
  return {
    ...row,
    ...(alias ? { display: alias, displayAlias: alias } : {}),
    effortOptions: effortItemsFor(row.provider, row, null),
    fastCapable: fastCapableFor(row.provider, row),
    fastPreferred: Object.hasOwn(saved, 'fast')
      ? saved.fast === true
      : row.defaultFast === true || fastPreferenceFor(cfg, row.provider, row.id),
    savedEffort: saved.effort || null,
    savedFast: Object.hasOwn(saved, 'fast') ? saved.fast === true : undefined,
    savedModelParameters: saved.modelParameters || {},
    savedContextPercent: Number(saved.contextPercent) || undefined,
  };
}

export function createRowHydration({
  config,
  route,
  sortProviderModelsRaw,
  providerModelCacheRowRaw,
  webSearchCapableFor,
}) {
  const sortProviderModels = (models) => sortProviderModelsRaw(models, route().provider);
  const providerModelCacheRow = (name, m) => providerModelCacheRowRaw(name, m, webSearchCapableFor);
  return {
    hydrateProviderModelRow: (row) => hydrateProviderModelRow(config(), row),
    sortProviderModels,
    providerModelCacheRow,
    providerModelsFromCacheRows: (rows) =>
      sortProviderModels((rows || []).map((row) => hydrateProviderModelRow(config(), row))),
  };
}
