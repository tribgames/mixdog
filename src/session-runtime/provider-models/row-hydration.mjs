// provider-models/row-hydration.mjs
// Turning cached catalog rows into picker rows: the user's saved per-model
// settings (alias, effort, fast, parameters, context budget) layered on top,
// then the route-provider-first sort.
import { effortItemsFor } from '../../runtime/agent/orchestrator/runtime-core/effort.mjs';
import {
  fastCapableFor,
  fastPreferenceFor,
  ultrafastCapableFor,
} from '../../runtime/agent/orchestrator/runtime-core/model-capabilities.mjs';
import { modelSettingsFor } from '../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import {
  customAutoEffortCapable,
  effortConfigurationMode,
} from '../../runtime/agent/orchestrator/providers/effort-configuration.mjs';
import { getProvider } from '../../runtime/agent/orchestrator/providers/registry.mjs';
import {
  DAYBREAK_PARAMETER_OPTION,
  DAYBREAK_PROVIDER,
  daybreakBlueSupported,
} from '../../runtime/shared/llm/openai-daybreak.mjs';

const ULTRAFAST_SPEED_OPTION = Object.freeze({
  id: 'serviceTier',
  label: 'Speed',
  kind: 'enum',
  options: [
    { value: 'priority', label: 'Fast' },
    { value: 'ultrafast', label: 'Ultrafast' },
  ],
});

export function hydrateProviderModelRow(cfg, row) {
  const saved = modelSettingsFor(cfg, row.provider, row.id);
  // Display-only user alias (modelSettings["provider/model"].alias). It
  // replaces the label everywhere the row's `display` is shown; the id and
  // route selection are untouched.
  const alias = typeof saved.alias === 'string' ? saved.alias.trim() : '';
  const fastCapable = fastCapableFor(row.provider, row);
  const existingOptions = Array.isArray(row.modelParameterOptions) ? row.modelParameterOptions : [];
  const addedOptions = [
    ...(row.provider === DAYBREAK_PROVIDER && daybreakBlueSupported(row) ? [DAYBREAK_PARAMETER_OPTION] : []),
    ...(fastCapable && ultrafastCapableFor(row.provider, row) ? [ULTRAFAST_SPEED_OPTION] : []),
  ];
  const modelParameterOptions = addedOptions.length
    ? [...existingOptions.filter((option) => !addedOptions.some((added) => added.id === option?.id)), ...addedOptions]
    : row.modelParameterOptions;
  const isCustom = row.provider?.startsWith?.('custom-');
  const customName = isCustom ? String(cfg?.providers?.[row.provider]?.name || '').trim() : '';
  // A custom provider's name always comes from the current configuration; a
  // row's own (possibly renamed or removed) name is dropped.
  const base = { ...row };
  if (isCustom) delete base.providerName;
  return {
    ...base,
    ...(customName ? { providerName: customName } : {}),
    ...(alias ? { display: alias, displayAlias: alias } : {}),
    ...(modelParameterOptions ? { modelParameterOptions } : {}),
    effortOptions: effortItemsFor(row.provider, row, null),
    fastCapable,
    fastPreferred: Object.hasOwn(saved, 'fast')
      ? saved.fast === true
      : row.defaultFast === true || fastPreferenceFor(cfg, row.provider, row.id),
    // Auto effort only changes effort where that keeps the prompt cache, or
    // per request on a custom Chat/Responses model that declares levels.
    autoEffortCapable:
      Boolean(
        effortConfigurationMode(row.provider, row.id, {
          ...(getProvider(row.provider)?.config || {}),
          modelParameters: saved.modelParameters || {},
        })
      ) || customAutoEffortCapable(row.provider, cfg?.providers?.[row.provider]?.protocol, row),
    savedEffort: saved.effort || null,
    savedFast: Object.hasOwn(saved, 'fast') ? saved.fast === true : undefined,
    savedAutoEffort: Object.hasOwn(saved, 'autoEffort') ? saved.autoEffort !== false : undefined,
    savedModelParameters: saved.modelParameters || {},
    savedContextPercent: Number(saved.contextPercent) || undefined,
    savedContextTokens: Number(saved.contextTokens) || undefined,
    // Model management: an explicit /model visibility choice and the favorite
    // mark (absent = the picker's default listing, not a favorite).
    ...(typeof saved.hidden === 'boolean' ? { savedHidden: saved.hidden } : {}),
    ...(saved.favorite === true ? { favorite: true } : {}),
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
