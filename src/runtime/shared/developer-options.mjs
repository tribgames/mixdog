// Developer options: the data-driven registry behind Settings → Developer.
// A new sub-category or toggle is one entry in DEVELOPER_SECTIONS; the
// runtime API, TUI and desktop render every section/option from this data.
// Each option is on only while the stored agent config value
// `developer.<optionId>` is true. Default off. An option with a `warning`
// turns on only after the user confirms that warning; an option with a
// `provider` gates that dev-only OAuth provider.
import { readSection, readSectionStrict } from './config.mjs';

const OAUTH_RISK_WARNING =
  'Using this provider through OAuth carries a high risk of penalties such as account restrictions.';

export const DEVELOPER_SECTIONS = Object.freeze([
  Object.freeze({
    id: 'approvals',
    label: 'Approvals',
    options: Object.freeze([
      Object.freeze({
        id: 'allowAllActions',
        label: 'Allow all actions',
        description: 'Skips the approval cards for every action except payments and permanent deletes.',
        warning:
          'Turning this on lets agents act without asking you first, except for payments and permanent deletes. Use it only if you accept that risk.',
      }),
    ]),
  }),
  Object.freeze({
    id: 'providers',
    label: 'Providers',
    description: OAUTH_RISK_WARNING,
    options: Object.freeze([
      Object.freeze({
        id: 'antigravityOAuth',
        label: 'Gemini (Antigravity)',
        description: 'Show Antigravity (Gemini) OAuth in Providers and the model picker.',
        warning: OAUTH_RISK_WARNING,
        provider: 'antigravity-oauth',
      }),
      Object.freeze({
        id: 'cursorOAuth',
        label: 'Cursor',
        description: 'Show Cursor OAuth in Providers and the model picker.',
        warning: OAUTH_RISK_WARNING,
        provider: 'cursor-oauth',
      }),
      Object.freeze({
        id: 'devinOAuth',
        label: 'Devin',
        description: 'Show Devin OAuth in Providers and the model picker.',
        warning: OAUTH_RISK_WARNING,
        provider: 'devin-oauth',
      }),
      Object.freeze({
        id: 'mimoOAuth',
        label: 'MiMo',
        description: 'Show Xiaomi MiMo OAuth in Providers and the model picker.',
        warning: OAUTH_RISK_WARNING,
        provider: 'mimo-oauth',
      }),
    ]),
  }),
  Object.freeze({
    id: 'remote',
    label: 'Remote',
    options: Object.freeze([
      // Read once at desktop start-up (apps/desktop/src/main/remote-transport/switch.ts):
      // docs/remote-transport.md §6.
      Object.freeze({
        id: 'directPhoneConnection',
        label: 'Direct phone connection (test)',
        description:
          'Lets a paired phone talk to this PC directly instead of through the relay. Takes effect after you restart Mixdog.',
        warning:
          'Experimental: the direct phone connection is still being tested and may make the phone connection less reliable. Restart Mixdog after changing it.',
      }),
    ]),
  }),
]);

function findOption(matches) {
  for (const section of DEVELOPER_SECTIONS) {
    const option = section.options.find(matches);
    if (option) return option;
  }
  return null;
}

/** The registry entry for an option id, or null when unknown. */
export function developerOption(id) {
  return findOption((entry) => entry.id === id);
}

/** The option gating a dev-only provider, or null when the provider is not gated. */
export function developerOptionForProvider(provider) {
  return findOption((entry) => entry.provider === provider);
}

/** Stored `developer` values: booleans only, anything else dropped. */
export function normalizeDeveloperConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === 'boolean'));
}

function storedDeveloperConfig() {
  return normalizeDeveloperConfig(readSection('agent').developer);
}

/** True when the option exists and its stored value is true. */
export function developerOptionEnabled(id, stored = storedDeveloperConfig()) {
  return developerOption(id) !== null && normalizeDeveloperConfig(stored)[id] === true;
}

/** `developerOptionEnabled` for a safety bypass: fail-closed. Read straight
 *  from the config file, so a missing or malformed config is never restored
 *  from a backup (which may hold a stale `true`); any error means off. */
export function developerOptionEnabledStrict(id) {
  try {
    return developerOption(id) !== null && normalizeDeveloperConfig(readSectionStrict('agent').developer)[id] === true;
  } catch {
    return false;
  }
}

/** Settings view of every section; `stored` defaults to the on-disk values. */
export function developerSettingsView(stored = storedDeveloperConfig()) {
  const values = normalizeDeveloperConfig(stored);
  return {
    sections: DEVELOPER_SECTIONS.map((section) => ({
      id: section.id,
      label: section.label,
      ...(section.description ? { description: section.description } : {}),
      options: section.options.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
        ...(option.warning ? { warning: option.warning } : {}),
        ...(option.provider ? { provider: option.provider } : {}),
        enabled: values[option.id] === true,
      })),
    })),
  };
}
