// Model-facing feature activation for one session runtime. Every gate reads the
// LIVE config (a settings toggle must take effect without rebuilding the tool
// surface), so the factory takes getters rather than values.
//
// Key names mirror the dependency names of settings-api.mjs / the session-build
// deps, so the runtime can hand them straight through.
import { builtinFeatureActive, featureDisallowedToolsFor, localGitToolsActive } from './builtin-features.mjs';
import { moduleEnabled, recapEnabled } from './config-helpers.mjs';
import { browserBridgeAvailableSync } from '../runtime/browser-bridge/client.mjs';
import { computerBridgeAvailableSync } from '../runtime/computer-bridge/client.mjs';

export function createRuntimeFeatureGates({ getConfig, getToolProfile }) {
  return {
    // Memory ingest is always-on. `recap` gates only the background cycles;
    // `memoryTools` gates the model-facing memory/recall tool surface. Headless
    // runs override any toggle per process via MIXDOG_FEATURE_* env values.
    recapEnabledFn: () => recapEnabled(getConfig(), true),
    memoryToolsEnabledFn: () => builtinFeatureActive(getConfig(), 'memory'),
    webSearchEnabled: () => builtinFeatureActive(getConfig(), 'webSearch'),
    gitToolsEnabledFn: () => localGitToolsActive(getConfig(), getToolProfile()),
    officeToolsEnabledFn: () => builtinFeatureActive(getConfig(), 'office'),
    localProviderEnabledFn: () => builtinFeatureActive(getConfig(), 'localProvider'),
    mediaToolEnabledFn: () => builtinFeatureActive(getConfig(), 'media'),
    tidyToolEnabledFn: () => builtinFeatureActive(getConfig(), 'tidy'),
    channelsEnabled: () => moduleEnabled(getConfig(), 'channels', true),
    // Browser/Computer activate on live desktop-bridge presence, so the probe
    // runs per call instead of being captured at boot.
    featureDisallowedTools: () =>
      featureDisallowedToolsFor(getConfig(), {
        browserAvailable: browserBridgeAvailableSync(),
        computerAvailable: computerBridgeAvailableSync(),
        toolProfile: getToolProfile(),
      }),
  };
}
