// Session-runtime boot sequence: prepare the standalone environment, then load
// the runtime module graph. createMixdogSessionRuntime keeps wiring only; the
// two steps stay separate exports because the runtime creates
// provider-readiness state between them.
import { performance } from 'node:perf_hooks';
import { ensureStandaloneEnvironment } from '../standalone/seeds.mjs';
import { listOfficeJournals } from '../runtime/office/core/journal.mjs';
import { bootProfile, profiledImport } from './boot-profile.mjs';
import {
  RUNTIME,
  WEB_SEARCH_TOOL_DEFS,
  MEMORY_TOOL_DEFS,
  CHANNEL_TOOL_DEFS,
  CODE_GRAPH_TOOL_DEFS,
  STATUSLINE_SESSION_ROUTES,
  STANDALONE_ROOT,
  STANDALONE_DATA_DIR,
} from './runtime-paths.mjs';

export function prepareStandaloneEnvironment() {
  process.env.MIXDOG_QUIET_SESSION_LOG ??= '1';
  const startedAt = performance.now();
  ensureStandaloneEnvironment({
    rootDir: STANDALONE_ROOT,
    dataDir: STANDALONE_DATA_DIR,
  });
  // Office journals exist only for cross-process crash recovery, so startup just
  // prunes expired ones in the background. Surfacing them as session context made
  // every new session (agents included) re-announce unrelated leftovers for the
  // full 30-day retention window; recovery stays reachable on demand through
  // office action=transactions / action=recover.
  listOfficeJournals(STANDALONE_DATA_DIR).catch(() => {});
  bootProfile('standalone-env:ready', { ms: (performance.now() - startedAt).toFixed(1) });
}

// Every module the runtime needs before it can wire anything, loaded in one
// parallel batch. Tool-def modules are optional: a build without them resolves
// to null and the corresponding tools simply never reach the surface.
export async function loadRuntimeModules() {
  const startedAt = performance.now();
  const [
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
  ] = await Promise.all([
    profiledImport('config', `${RUNTIME}/config.mjs`),
    profiledImport('shared-config', `${RUNTIME}/../../shared/config.mjs`),
    profiledImport('providers-registry', `${RUNTIME}/providers/registry.mjs`),
    profiledImport('mcp-client', `${RUNTIME}/mcp/client.mjs`),
    profiledImport('session-manager', `${RUNTIME}/session/manager.mjs`),
    profiledImport('context-collect', `${RUNTIME}/context/collect.mjs`),
    profiledImport('internal-tools', `${RUNTIME}/internal-tools.mjs`),
    profiledImport('status-routes', STATUSLINE_SESSION_ROUTES, { optional: true }),
    profiledImport('web-search-tool-defs', WEB_SEARCH_TOOL_DEFS, { optional: true }),
    profiledImport('memory-tool-defs', MEMORY_TOOL_DEFS, { optional: true }),
    profiledImport('channel-tool-defs', CHANNEL_TOOL_DEFS, { optional: true }),
    profiledImport('code-graph-tool-defs', CODE_GRAPH_TOOL_DEFS, { optional: true }),
  ]);
  bootProfile('imports:ready', { ms: (performance.now() - startedAt).toFixed(1) });
  // Re-wire the idle/tombstone sweep. startIdleCleanup() lost its caller in a
  // refactor, so closed-session tombstones were never deleted after their 24h
  // grace — the store grew unbounded (observed: 1.8k files / 114MB), which
  // made summary-index rebuilds and per-save index rewrites stall boot for
  // seconds. Timer is unref'd and first fires after CLEANUP_INITIAL_DELAY_MS
  // (5min), so this adds zero boot-path cost.
  try {
    mgr.startIdleCleanup?.();
  } catch {
    /* cleanup is best-effort */
  }
  return {
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
  };
}
