import type { DesktopModelOption } from '../shared/contract';
import { record, rows, type UnknownRecord } from './record-utils';

export type ParsedModelRef = {
  route: string;
  effort: string;
  fast: boolean;
  modelParameters: Record<string, string>;
};

export function parseModelRef(ref: string): ParsedModelRef {
  const raw = String(ref || '');
  const queryAt = raw.indexOf('?');
  let route = queryAt >= 0 ? raw.slice(0, queryAt) : raw;
  const modelParameters = queryAt >= 0
    ? Object.fromEntries(new URLSearchParams(raw.slice(queryAt + 1)))
    : {};
  let fast = false;
  if (route.endsWith('+fast')) {
    fast = true;
    route = route.slice(0, -5);
  }
  let effort = '';
  const slash = route.indexOf('/');
  if (slash > 0) {
    const at = route.lastIndexOf('@');
    if (at > slash) {
      effort = route.slice(at + 1);
      route = route.slice(0, at);
    }
  }
  return { route, effort, fast, modelParameters };
}

export function preferredModelEffort(
  model: DesktopModelOption | undefined,
): string | undefined {
  if (!model?.effortOptions.length) return undefined;
  if (model.savedEffort
    && model.effortOptions.some((entry) => entry.value === model.savedEffort)) {
    return model.savedEffort;
  }
  if (model.defaultEffort
    && model.effortOptions.some((entry) => entry.value === model.defaultEffort)) {
    return model.defaultEffort;
  }
  for (const value of ['high', 'medium', 'low', 'none', 'xhigh', 'max', 'ultra']) {
    if (model.effortOptions.some((entry) => entry.value === value)) return value;
  }
  return model.effortOptions[0]?.value;
}

export function preferredModelParameters(
  model: DesktopModelOption | undefined,
  current: Record<string, string> = {},
): Record<string, string> {
  if (!model) return {};
  const defaults = {
    ...(model.defaultModelParameters || {}),
    ...(model.savedModelParameters || {}),
    ...current,
  };
  return Object.fromEntries((model.modelParameterOptions || []).flatMap((definition) => {
    const value = defaults[definition.id];
    if (value && definition.options.some((option) => option.value === value)) {
      return [[definition.id, value]];
    }
    const fallback = definition.options[0]?.value;
    return fallback ? [[definition.id, fallback]] : [];
  }));
}

export function routeOption(value: UnknownRecord): DesktopModelOption {
  const model = String(value.id || value.model || '');
  const effortOptions = rows(value.effortOptions).flatMap((entry) => {
    const optionValue = String(entry.value || '');
    if (!optionValue) return [];
    return [{ value: optionValue, label: String(entry.label || optionValue) }];
  });
  const savedEffort = String(value.savedEffort || '');
  const savedFast = typeof value.savedFast === 'boolean' ? value.savedFast : undefined;
  const fastCapable = value.fastCapable === true;
  const fastEfforts = Array.isArray(value.fastEfforts)
    ? value.fastEfforts.map((entry) => String(entry || '').trim().toLowerCase())
    : undefined;
  const modelParameterOptions = Array.isArray(value.modelParameterOptions)
    ? value.modelParameterOptions as DesktopModelOption['modelParameterOptions']
    : [];
  return {
    provider: String(value.provider || ''),
    model,
    display: String(value.display || value.name || model),
    effortOptions,
    fastCapable,
    ...(fastEfforts ? { fastEfforts } : {}),
    fastPreferred: fastCapable && (value.fastPreferred === true || savedFast === true),
    ...(savedEffort ? { savedEffort } : {}),
    ...(savedFast === undefined ? {} : { savedFast }),
    ...(value.supportsVision === true ? { supportsVision: true } : {}),
    ...(value.defaultEffort ? { defaultEffort: String(value.defaultEffort) } : {}),
    ...(value.defaultFast === true ? { defaultFast: true } : {}),
    modelParameterOptions,
    parameterVariants: Array.isArray(value.parameterVariants)
      ? value.parameterVariants as Array<Record<string, string>>
      : [],
    defaultModelParameters: record(value.defaultModelParameters) as Record<string, string>,
    savedModelParameters: record(value.savedModelParameters) as Record<string, string>,
  };
}
