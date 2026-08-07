// Lightweight persisted model route for the first renderer snapshot. Importing
// the full agent config/provider graph in Electron main would defeat the cold
// path, so this reads only the selected preset from the small shared JSON file.
import { readFileSync } from 'node:fs';

import type { SessionSnapshot } from '../shared/contract';
import { mixdogConfigPath } from './onboarding-status-file';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function selectedPreset(agent: Record<string, unknown>): Record<string, unknown> | null {
  const presets = Array.isArray(agent.presets)
    ? agent.presets.map(record).filter((preset): preset is Record<string, unknown> => Boolean(preset))
    : [];
  const key = agent.default;
  if (key == null || key === '') return null;
  if (typeof key === 'number' || /^\d+$/.test(String(key))) {
    return presets[Number(key)] || null;
  }
  return presets.find((preset) => String(preset.id || preset.name || '') === String(key)) || null;
}

export function desktopModelBootstrapFromConfig(value: unknown): SessionSnapshot {
  const root = record(value);
  let agent = record(root?.agent);
  if (record(agent?.agent)?.providers) agent = record(agent?.agent);
  if (!agent) return null;
  const preset = selectedPreset(agent);
  const provider = String(preset?.provider || '').trim();
  const model = String(preset?.model || '').trim();
  if (!provider || !model) return null;

  const routeKey = `${provider}/${model}`;
  const setting = record(record(agent.modelSettings)?.[routeKey]);
  const effort = String(setting?.effort || preset?.effort || '').trim();
  let fast: boolean | undefined;
  if (setting && Object.hasOwn(setting, 'fast')) fast = setting.fast === true;
  else if (record(agent.fastModels)?.[routeKey] === true) fast = true;
  else if (preset && Object.hasOwn(preset, 'fast')) fast = preset.fast === true;

  return {
    items: [],
    queued: [],
    busy: false,
    commandBusy: false,
    provider,
    model,
    ...(effort ? { effort } : {}),
    ...(fast === undefined ? {} : { fast }),
  };
}

export function readDesktopModelBootstrapSnapshot(): SessionSnapshot {
  try {
    return desktopModelBootstrapFromConfig(JSON.parse(readFileSync(mixdogConfigPath(), 'utf8')));
  } catch {
    return null;
  }
}
