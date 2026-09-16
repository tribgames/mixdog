import { isDeepStrictEqual } from 'node:util';
import { flushPendingSessionConfigWrites } from './config-lifecycle.mjs';

// Run only after the lifecycle has established that it needs a NEW session.
// Existing sessions, including a resumed conversation, never enter this path.
export function createNewSessionConfig({
  rt,
  sharedCfgMod,
  reloadFullConfig,
  resolveRoute,
  initialConfig = null,
  initialRouteExplicit = false,
  invalidatePreSessionToolSurface,
  invalidateOutputStyleStatusCache,
  invalidateSkills,
  connectConfiguredMcp,
  configureEmbedding,
}) {
  let firstSession = true;
  return async function prepareNewSessionConfig() {
    await flushPendingSessionConfigWrites();
    await sharedCfgMod.pendingConfigWrites();
    sharedCfgMod.invalidateConfigReadCache();
    const previousMcp = rt.config.mcpServers;
    // Headless callers inject a deliberately isolated config. Never replace
    // their explicit policy with the interactive profile on disk.
    if (!initialConfig || typeof initialConfig !== 'object') {
      reloadFullConfig();
      if (!firstSession || !initialRouteExplicit) {
        rt.route = resolveRoute(rt.config, {});
      }
    }
    invalidateOutputStyleStatusCache();
    invalidatePreSessionToolSurface();
    invalidateSkills();
    await configureEmbedding(sharedCfgMod.readSection('memory')?.embedding || {});
    if (!firstSession || !isDeepStrictEqual(previousMcp, rt.config.mcpServers)) {
      // Reused runtimes may still own old connections. This reset is scoped to
      // the runtime that is constructing the new session, not to its peers.
      await connectConfiguredMcp({ reset: true });
    }
    firstSession = false;
  };
}
