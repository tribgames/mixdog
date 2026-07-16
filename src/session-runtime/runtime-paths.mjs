import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME = '../runtime/agent/orchestrator';
export const SEARCH_RUNTIME = '../runtime/search/index.mjs';
export const SEARCH_TOOL_DEFS = '../runtime/search/tool-defs.mjs';
export const MEMORY_TOOL_DEFS = '../runtime/memory/tool-defs.mjs';
export const MEMORY_RUNTIME = '../runtime/memory/index.mjs';
export const CHANNEL_TOOL_DEFS = '../runtime/channels/tool-defs.mjs';
export const CHANNEL_WORKER_ENTRY = '../runtime/channels/index.mjs';
export const CODE_GRAPH_TOOL_DEFS = '../runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
export const CODE_GRAPH_RUNTIME = '../runtime/agent/orchestrator/tools/code-graph.mjs';
export const STATUSLINE_SESSION_ROUTES = '../vendor/statusline/src/gateway/session-routes.mjs';

export const SESSION_RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));
export const STANDALONE_SOURCE_ROOT = dirname(SESSION_RUNTIME_DIR);
export const STANDALONE_ROOT = STANDALONE_SOURCE_ROOT;
const mixdogHome = process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
export const STANDALONE_DATA_DIR = process.env.MIXDOG_DATA_DIR || join(mixdogHome, 'data');
