import type { DesktopModelOption } from '../shared/contract';

const MODEL_CATALOG_STORAGE_KEY = 'mixdog.desktop-model-catalog.v2';
const MODEL_CATALOG_LIMIT = 1_000;

export interface CachedModelCatalog {
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
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    const normalizedKey = key.trim();
    const normalizedValue = typeof entry === 'string' ? entry.trim() : '';
    return normalizedKey && normalizedValue ? [[normalizedKey, normalizedValue]] : [];
  }));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function parameterOptions(value: unknown): DesktopModelOption['modelParameterOptions'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const parameter = entry as Record<string, unknown>;
    const id = String(parameter.id || '').trim();
    const label = String(parameter.label || id).trim();
    const kind = parameter.kind === 'boolean' ? 'boolean' : parameter.kind === 'enum' ? 'enum' : null;
    const options = Array.isArray(parameter.options)
      ? parameter.options.flatMap((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const option = raw as Record<string, unknown>;
        const optionValue = String(option.value || '').trim();
        const optionLabel = String(option.label || optionValue).trim();
        const contextWindow = Number(option.contextWindow);
        return optionValue && optionLabel ? [{
          value: optionValue,
          label: optionLabel,
          ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
        }] : [];
      })
      : [];
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
    ...(typeof option.created === 'number' && Number.isFinite(option.created)
      ? { created: option.created }
      : {}),
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
    const stored = JSON.parse(window.localStorage.getItem(MODEL_CATALOG_STORAGE_KEY) || 'null');
    const record = stored && typeof stored === 'object' && !Array.isArray(stored)
      ? stored as Record<string, unknown>
      : {};
    const models = Array.isArray(record.models)
      ? record.models.map(modelOption).filter((entry): entry is DesktopModelOption => entry !== null)
        .slice(0, MODEL_CATALOG_LIMIT)
      : [];
    return {
      models,
      updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : 0,
    };
  } catch {
    return { models: [], updatedAt: 0 };
  }
}

export function writeCachedModelCatalog(models: DesktopModelOption[]): CachedModelCatalog {
  const unique = new Map<string, DesktopModelOption>();
  for (const raw of models) {
    const option = modelOption(raw);
    if (option) unique.set(`${option.provider}:${option.model}`, option);
    if (unique.size >= MODEL_CATALOG_LIMIT) break;
  }
  const catalog = { models: [...unique.values()], updatedAt: Date.now() };
  try {
    window.localStorage.setItem(MODEL_CATALOG_STORAGE_KEY, JSON.stringify(catalog));
  } catch {
    // The live catalog remains usable when browser storage is unavailable.
  }
  return catalog;
}
