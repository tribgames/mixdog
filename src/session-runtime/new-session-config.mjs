import { isDeepStrictEqual } from 'node:util';
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
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
  connectConfiguredMcp,
  configureEmbedding,
}) {
  let firstSession = true;
  return async function prepareNewSessionConfig() {
    await flushPendingSessionConfigWrites();
    await sharedCfgMod.pendingConfigWrites();
    sharedCfgMod.invalidateConfigReadCache();
    const mcpSettings = () => [rt.config.mcpServers, rt.config.pluginMcp];
    const previousMcp = mcpSettings();
    // Headless callers inject a deliberately isolated config. Never replace
    // their explicit policy with the interactive profile on disk.
    if (!initialConfig || typeof initialConfig !== 'object') {
      reloadFullConfig();
      if (!firstSession || !initialRouteExplicit) {
        const configured = resolveRoute(rt.config, {});
        // With no Lead model configured the model picked for this runtime's
        // still-empty conversation (a session-only choice never writes the
        // Lead route) stands; the reload must not drop it before the first turn.
        if (clean(configured?.model) || !clean(rt.route?.model)) rt.route = configured;
      }
    }
    invalidateOutputStyleStatusCache();
    invalidatePreSessionToolSurface();
    // The installed-skill list is NOT dropped here: its cache is change-gated
    // (every skill root's mtime signature, kept by change watchers), so a new
    // session already sees any skill edit. Clearing it made every session
    // creation re-read and re-parse every SKILL.md on the event loop.
    await configureEmbedding(sharedCfgMod.readSection('memory')?.embedding || {});
    if (!firstSession || !isDeepStrictEqual(previousMcp, mcpSettings())) {
      // Reused runtimes may still own old connections. This reset is scoped to
      // the runtime that is constructing the new session, not to its peers.
      await connectConfiguredMcp({ reset: true });
    }
    firstSession = false;
  };
}
