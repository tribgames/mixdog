// The complete model-facing tool catalog as the runtime assembles it, shared
// by the surface-contract and deferred-loading suites.
import './_env.mjs';
import { SKILL_TOOL, TOOL_SEARCH_TOOL, defaultDeferredToolNames } from '../../src/mixdog-session-runtime.mjs';
import { AGENT_TOOL } from '../../src/standalone/agent-tool.mjs';
import { BUILTIN_TOOLS } from '../../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../../src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
import { PATCH_TOOL_DEFS } from '../../src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs';
import { TOOL_DEFS as MEMORY_TOOL_DEFS } from '../../src/runtime/memory/tool-defs.mjs';
import { TOOL_DEFS as WEB_SEARCH_TOOL_DEFS } from '../../src/runtime/web-search/tool-defs.mjs';
import { TOOL_DEFS as CHANNEL_TOOL_DEFS } from '../../src/runtime/channels/tool-defs.mjs';

export const smokeCatalog = [
  ...BUILTIN_TOOLS,
  ...CODE_GRAPH_TOOL_DEFS,
  ...PATCH_TOOL_DEFS,
  ...MEMORY_TOOL_DEFS,
  ...WEB_SEARCH_TOOL_DEFS,
  ...CHANNEL_TOOL_DEFS,
  AGENT_TOOL,
  SKILL_TOOL,
  TOOL_SEARCH_TOOL,
].filter(Boolean);

export const fullDefaults = defaultDeferredToolNames(smokeCatalog, 'full');
