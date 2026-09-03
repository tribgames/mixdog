// builtin-features.mjs — common install-first lifecycle for the first-party
// built-in features (Extensions → Built-in).
//
// `installed` is a persisted activation marker in the config `builtins`
// section. A feature's tools reach the session tool surface only once the
// feature is BOTH installed and enabled; its toggle merely flips `enabled`
// after installation. Voice keeps its on-disk runtime probe, and Browser
// Use / Computer Use keep their bridge-presence gate plus desktop-side
// installed markers — this section covers the runtime-persisted trio.
//
// Fresh profiles start with an explicit empty `builtins` section, so every
// feature presents as "not installed". A config that predates the section is
// an active profile: it is grandfathered as installed so an upgrade never
// removes a working tool surface. The daemon stamps the section at its first
// config adoption, which always happens before onboarding completes, so a
// brand-new profile can never be mistaken for a grandfathered one.
// MIXDOG_FEATURE_* env overrides (headless/bench) bypass the gate entirely.

import {
  featureEnvOverride,
  memoryToolsEnabled,
  moduleEnabled,
} from './config-helpers.mjs';
import { readBridgeDiscovery } from '../runtime/bridge-discovery.mjs';

// Browser Use / Computer Use have no install marker: the desktop app publishes
// a loopback bridge discovery file while the feature is on. The same file
// names gate the session tool surface in the bridge clients.
const BROWSER_BRIDGE_DISCOVERY_FILE = 'browser-bridge.json';
const COMPUTER_BRIDGE_DISCOVERY_FILE = 'computer-bridge.json';

function bridgePresent(file) {
  try {
    return readBridgeDiscovery(file) !== null;
  } catch {
    return false;
  }
}

export const INSTALLABLE_BUILTIN_IDS = Object.freeze(['git', 'memory', 'office']);

/** Model-facing activation for one gated feature: an explicit MIXDOG_FEATURE_*
 *  env override (headless/bench) wins, otherwise the install marker and the
 *  persisted toggle both have to agree. */
export function builtinFeatureActive(configLike, id) {
  if (id === 'webSearch') {
    return featureEnvOverride('MIXDOG_FEATURE_WEB_SEARCH')
      ?? moduleEnabled(configLike, 'webSearch', true);
  }
  if (id === 'memory') {
    return featureEnvOverride('MIXDOG_FEATURE_MEMORY')
      ?? (builtinInstalled(configLike, 'memory') && memoryToolsEnabled(configLike, true));
  }
  if (id === 'git') {
    return featureEnvOverride('MIXDOG_FEATURE_GIT')
      ?? (builtinInstalled(configLike, 'git') && moduleEnabled(configLike, 'git', true));
  }
  if (id === 'office') {
    return featureEnvOverride('MIXDOG_FEATURE_OFFICE')
      ?? (builtinInstalled(configLike, 'office') && moduleEnabled(configLike, 'office', true));
  }
  // Media Studio is a hidden built-in like setup: no Settings card, no install
  // step, always on. The lane catalog ships with the runtime and sign-in happens
  // per provider; only the env override (headless) or a hand-edited module
  // toggle gates it, and a signed-out catalog fails per call with the lanes it
  // does have. The image/video skills follow through `requires: media`.
  if (id === 'media') {
    return featureEnvOverride('MIXDOG_FEATURE_MEDIA') ?? moduleEnabled(configLike, 'media', true);
  }
  // Bridge-gated features (skills that describe the `browser` / `computer`
  // tools use these ids in metadata.requires so they are offered only while
  // the tool itself can reach a live desktop bridge).
  if (id === 'browser') {
    return featureEnvOverride('MIXDOG_FEATURE_BROWSER') ?? bridgePresent(BROWSER_BRIDGE_DISCOVERY_FILE);
  }
  if (id === 'computer') {
    return featureEnvOverride('MIXDOG_FEATURE_COMPUTER') ?? bridgePresent(COMPUTER_BRIDGE_DISCOVERY_FILE);
  }
  return false;
}

/** The session-surface exclusion list. Session build, the empty-session policy
 *  refresh, and the deferred tool catalog all consume THIS list, so an
 *  uninstalled or disabled feature never reaches a session's tool surface.
 *  Browser Use / Computer Use activate on bridge presence (plus their env
 *  overrides), which the caller passes in. */
export function featureDisallowedToolsFor(configLike, {
  browserAvailable = false,
  computerAvailable = false,
} = {}) {
  const browser = featureEnvOverride('MIXDOG_FEATURE_BROWSER') ?? browserAvailable === true;
  const computer = featureEnvOverride('MIXDOG_FEATURE_COMPUTER') ?? computerAvailable === true;
  return [
    ...(builtinFeatureActive(configLike, 'webSearch') ? [] : ['web_search', 'web_fetch']),
    ...(builtinFeatureActive(configLike, 'memory') ? [] : ['memory', 'recall']),
    ...(builtinFeatureActive(configLike, 'git') ? [] : ['git', 'git_stage']),
    ...(browser ? [] : ['browser']),
    ...(computer ? [] : ['computer']),
    ...(builtinFeatureActive(configLike, 'office') ? [] : ['office']),
    ...(builtinFeatureActive(configLike, 'media') ? [] : ['media']),
  ];
}

export function builtinInstalled(configLike, id) {
  return configLike?.builtins?.[id]?.installed === true;
}

export function setBuiltinInstalledInConfig(configLike, id, installed = true) {
  const next = { ...(configLike || {}) };
  next.builtins = { ...(next.builtins || {}) };
  if (installed === true) {
    next.builtins[id] = { ...(next.builtins[id] || {}), installed: true };
  } else {
    const entry = { ...(next.builtins[id] || {}) };
    delete entry.installed;
    next.builtins[id] = entry;
  }
  return next;
}

/** Stamp or grandfather the `builtins` section on config adoption. Returns the
 *  same object when the section already exists, so callers can use identity to
 *  decide whether a persist is needed. */
export function withGrandfatheredBuiltins(configLike) {
  const config = configLike && typeof configLike === 'object' ? configLike : {};
  if (config.builtins && typeof config.builtins === 'object') return config;
  let next = { ...config, builtins: {} };
  // User-mark keys only: a default in-memory config may carry harmless
  // structural keys before onboarding ever writes, and must stay "fresh".
  const existingProfile = ['presets', 'providers', 'modules', 'default', 'memoryTools', 'recap']
    .some((key) => config[key] !== undefined);
  if (existingProfile) {
    for (const id of INSTALLABLE_BUILTIN_IDS) {
      next = setBuiltinInstalledInConfig(next, id, true);
    }
  }
  return next;
}
