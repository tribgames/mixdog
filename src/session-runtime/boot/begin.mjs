// Boot stages 1–2: the boot record with the shared runtime state, then the
// runtime modules and feature gates every later stage wires against.
import { randomUUID } from 'node:crypto';
import keychain from '../../lib/keychain-cjs.cjs';
import { bootProfile } from '../boot-profile.mjs';
import { loadRuntimeModules, prepareStandaloneEnvironment } from '../runtime-bootstrap.mjs';
import { createProviderReadiness } from '../provider-readiness.mjs';
import { createRoutePreparationGate } from '../route-preparation.mjs';
import { createRuntimeFeatureGates } from '../runtime-feature-gates.mjs';
import { createLazyRuntimeModules } from '../runtime-modules.mjs';
import { normalizeToolProfile } from '../tool-profile.mjs';

// The boot record: `rt` (shared mutable runtime state, promoted from closure
// `let`s so extracted modules read/write live values through one reference),
// the factory parameters, and every product a stage hands to later stages.
// Late-bound callbacks read through `boot.<name>` so a stage can hand a
// callback to an earlier consumer before its target exists.
export function beginBoot(params) {
  const { provider, model, toolMode, cwd, toolProfile, approvalMode, disallowDelegation } = params;
  const rt = {};
  rt.toolProfile = normalizeToolProfile(toolProfile);
  rt.approvalMode = approvalMode === 'implicit' ? 'implicit' : null;
  rt.disallowDelegation = disallowDelegation === true;
  rt.mcpScopeId = randomUUID();
  rt.desktopSession = params.desktopSession;
  rt.sessionProfile =
    params.sessionProfile && typeof params.sessionProfile === 'object' ? { ...params.sessionProfile } : null;
  bootProfile('session-runtime:start', { provider, model, toolMode, cwd });
  // Last assistant text handed to the transcript writer (via onAssistantText),
  // so the post-turn final-content append can skip an exact duplicate.
  rt._lastAppendedAssistant = '';
  prepareStandaloneEnvironment();
  const boot = { rt, params, sessionTurnApi: null, goalRuntime: null, runtimeFacade: null };
  const {
    awaitKeychainPrewarm,
    invalidateProviderCaches,
    ensureProvidersReady,
    modelMetaByRoute,
    providerModelCaches,
    providerUsageCaches,
  } = createProviderReadiness({
    rt,
    keychain,
    getReg: () => boot.reg,
    getWarmProviderModelCache: () => boot.warmProviderModelCache,
  });
  const routePreparation = createRoutePreparationGate({
    onError: (error) =>
      bootProfile('route-preparation:failed', {
        error: error?.message || String(error),
      }),
  });
  return Object.assign(boot, {
    awaitKeychainPrewarm,
    invalidateProviderCaches,
    ensureProvidersReady,
    modelMetaByRoute,
    providerModelCaches,
    providerUsageCaches,
    routePreparation,
  });
}

export async function loadModules(boot) {
  const { rt } = boot;
  const {
    cfgMod,
    sharedCfgMod,
    reg,
    mcpClient,
    mgr,
    contextMod,
    internalTools,
    statusRoutes,
    webSearchToolDefs,
    memoryToolDefs,
    channelToolDefs,
    codeGraphToolDefs,
  } = await loadRuntimeModules();
  const {
    recapEnabledFn,
    memoryToolsEnabledFn,
    webSearchEnabled,
    gitToolsEnabledFn,
    officeToolsEnabledFn,
    localProviderEnabledFn,
    mediaToolEnabledFn,
    tidyToolEnabledFn,
    channelsEnabled,
    featureDisallowedTools,
  } = createRuntimeFeatureGates({
    getConfig: () => rt.config,
    getToolProfile: () => rt.toolProfile,
  });
  const { getMemoryModule, getWebSearchModule, getCodeGraphModule } = createLazyRuntimeModules({ rt, cfgMod });
  Object.assign(boot, {
    cfgMod,
    sharedCfgMod,
    reg,
    mcpClient,
    mgr,
    contextMod,
    internalTools,
    statusRoutes,
    webSearchToolDefs,
    memoryToolDefs,
    channelToolDefs,
    codeGraphToolDefs,
    recapEnabledFn,
    memoryToolsEnabledFn,
    webSearchEnabled,
    gitToolsEnabledFn,
    officeToolsEnabledFn,
    localProviderEnabledFn,
    mediaToolEnabledFn,
    tidyToolEnabledFn,
    channelsEnabled,
    featureDisallowedTools,
    getMemoryModule,
    getWebSearchModule,
    getCodeGraphModule,
  });
}
