import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME = '../runtime/agent/orchestrator';
export const WEB_SEARCH_RUNTIME = '../runtime/web-search/index.mjs';
export const WEB_SEARCH_TOOL_DEFS = '../runtime/web-search/tool-defs.mjs';
export const MEMORY_TOOL_DEFS = '../runtime/memory/tool-defs.mjs';
export const CODE_GRAPH_TOOL_DEFS = '../runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
export const CODE_GRAPH_RUNTIME = '../runtime/agent/orchestrator/tools/code-graph.mjs';
export const STATUSLINE_SESSION_ROUTES = '../vendor/statusline/src/gateway/session-routes.mjs';

const SESSION_RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));
export const STANDALONE_ROOT = dirname(SESSION_RUNTIME_DIR);
const mixdogHome = process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
export const STANDALONE_DATA_DIR = process.env.MIXDOG_DATA_DIR || join(mixdogHome, 'data');

/** The data directory a runtime writes to: its config module's plugin data dir, else the standalone default. */
export function pluginDataDir(cfgMod) {
  return cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
}
