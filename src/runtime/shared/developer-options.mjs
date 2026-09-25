// Developer options: the data-driven registry behind Settings → Developer.
// A new sub-category or toggle is one entry in DEVELOPER_SECTIONS; the
// runtime API, TUI and desktop render every section/option from this data.
// Each option is on when its env var is truthy (a developer machine opt-in
// that settings cannot turn off) OR the stored agent config value
// `developer.<optionId>` is true. Default off.
import { readSection } from './config.mjs';

export const DEVELOPER_SECTIONS = Object.freeze([
  Object.freeze({
    id: 'providers',
    label: 'Providers',
    options: Object.freeze([
      Object.freeze({
        id: 'devProviders',
        label: 'Dev providers',
        description: 'Show Cursor OAuth and Antigravity OAuth in Providers and the model picker.',
        env: 'MIXDOG_DEV_PROVIDERS',
      }),
    ]),
  }),
]);

/** The registry entry for an option id, or null when unknown. */
export function developerOption(id) {
  for (const section of DEVELOPER_SECTIONS) {
    const option = section.options.find((entry) => entry.id === id);
    if (option) return option;
  }
  return null;
}

function envFlagEnabled(name) {
  const raw = String((name && process.env[name]) || '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** Stored `developer` values: booleans only, anything else dropped. */
export function normalizeDeveloperConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === 'boolean'));
}

function storedDeveloperConfig() {
  return normalizeDeveloperConfig(readSection('agent').developer);
}

/** True when the option's env var is truthy or its stored value is true. */
export function developerOptionEnabled(id, stored = storedDeveloperConfig()) {
  const option = developerOption(id);
  if (!option) return false;
  return envFlagEnabled(option.env) || normalizeDeveloperConfig(stored)[id] === true;
}

/** Settings view of every section; `stored` defaults to the on-disk values. */
export function developerSettingsView(stored = storedDeveloperConfig()) {
  const values = normalizeDeveloperConfig(stored);
  return {
    sections: DEVELOPER_SECTIONS.map((section) => ({
      id: section.id,
      label: section.label,
      options: section.options.map((option) => {
        const envForced = envFlagEnabled(option.env);
        return {
          id: option.id,
          label: option.label,
          description: option.description,
          env: option.env,
          enabled: envForced || values[option.id] === true,
          envForced,
        };
      }),
    })),
  };
}
