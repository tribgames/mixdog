/**
 * src/session-runtime/internal-tool-executor.mjs - name-dispatched executor
 * for the lead runtime's internal (non-MCP) tools. Handlers live by family in
 * internal-tool-executor/*.mjs (bridges, features, knowledge, workspace); this
 * applies the model-call feature guards, dispatches by name, and falls through
 * to channel tools.
 */
import { clean } from './session-text.mjs';
import { createBridgeToolHandlers } from './internal-tool-executor/bridge-tools.mjs';
import { createFeatureToolHandlers } from './internal-tool-executor/feature-tools.mjs';
import { createKnowledgeToolHandlers } from './internal-tool-executor/knowledge-tools.mjs';
import { createWorkspaceToolHandlers } from './internal-tool-executor/workspace-tools.mjs';

export function createInternalToolExecutor({
  rt,
  channels,
  goalRuntime,
  agentTool,
  setupTool,
  webSearchEnabled,
  memoryToolsEnabled,
  officeToolsEnabled,
  mediaToolEnabled,
  tidyToolEnabled = () => true,
  channelsEnabled,
  getWebSearchModule,
  getMemoryModule,
  getCodeGraphModule,
  notifyFnForSession,
  runNativeWebSearch,
  activeToolSurface,
  mcpStatus,
  applyResolvedCwd,
  skillToolContent,
}) {
  const handlers = {
    ...createBridgeToolHandlers({ rt }),
    ...createFeatureToolHandlers({ rt, setupTool, officeToolsEnabled, mediaToolEnabled, tidyToolEnabled }),
    ...createKnowledgeToolHandlers({
      rt,
      getWebSearchModule,
      getMemoryModule,
      getCodeGraphModule,
      notifyFnForSession,
      runNativeWebSearch,
      activeToolSurface,
      mcpStatus,
      skillToolContent,
    }),
    ...createWorkspaceToolHandlers({ rt, goalRuntime, agentTool, notifyFnForSession, applyResolvedCwd }),
  };

  // Settings-disabled features are refused for model-initiated calls before
  // any handler runs; the tool list is refreshed by a new session.
  const guardModelCall = (name) => {
    if ((name === 'web_search' || name === 'web_fetch') && !webSearchEnabled()) {
      throw new Error('web search is disabled in settings; start a new session to refresh the tool list');
    }
    if ((name === 'memory' || name === 'recall') && !memoryToolsEnabled()) {
      throw new Error(
        'memory tools are disabled in settings; background memory and manual core memory remain available'
      );
    }
  };

  return async (name, args, callerCtx = {}) => {
    const callerCwd = clean(callerCtx?.callerCwd) || rt.currentCwd;
    if (callerCtx?.invocationSource === 'model-tool') guardModelCall(name);
    if (Object.hasOwn(handlers, name)) return handlers[name](args, { name, callerCtx, callerCwd });
    if (channels.isChannelTool(name)) {
      if (!channelsEnabled()) throw new Error('channels are disabled in settings');
      return await channels.execute(name, args || {});
    }
    throw new Error(`unknown standalone internal tool: ${name}`);
  };
}
