import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePluginData } from '../runtime/shared/plugin-paths.mjs';

export const RUNTIME = '../runtime/agent/orchestrator';
export const WEB_SEARCH_RUNTIME = '../runtime/web-search/index.mjs';
export const WEB_SEARCH_TOOL_DEFS = '../runtime/web-search/tool-defs.mjs';
export const MEMORY_TOOL_DEFS = '../runtime/memory/tool-defs.mjs';
export const CODE_GRAPH_TOOL_DEFS = '../runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
export const CODE_GRAPH_RUNTIME = '../runtime/agent/orchestrator/tools/code-graph.mjs';
export const STATUSLINE_SESSION_ROUTES = '../vendor/statusline/src/gateway/session-routes.mjs';

const SESSION_RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));
export const STANDALONE_ROOT = dirname(SESSION_RUNTIME_DIR);

/**
 * The standalone data directory, resolved from the environment on every call.
 * A runtime start (a pristine boundary, a second page session) retargets
 * MIXDOG_DATA_DIR, so a load-time constant would point every later start back
 * at the first run's folder.
 */
export const standaloneDataDir = resolvePluginData;

/** The data directory a runtime writes to: its config module's plugin data dir, else the standalone default. */
export function pluginDataDir(cfgMod) {
  return cfgMod.getPluginData?.() || standaloneDataDir();
}
