/**
 * src/session-runtime/internal-tool-executor.mjs - name-dispatched executor
 * for the lead runtime's internal (non-MCP) tools. Handlers live by family in
 * internal-tool-executor/*.mjs (bridges, features, knowledge, workspace); this
 * applies the model-call feature guards, dispatches by name, and falls through
 * to channel tools.
 */
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { settingDisabledIn } from '../runtime/agent/orchestrator/runtime-core/tool-availability.mjs';
import { createAskUserToolHandlers } from './internal-tool-executor/ask-user-tool.mjs';
import { createBridgeToolHandlers } from './internal-tool-executor/bridge-tools.mjs';
import { createFeatureToolHandlers } from './internal-tool-executor/feature-tools.mjs';
import { createKnowledgeToolHandlers } from './internal-tool-executor/knowledge-tools.mjs';
import { createReactionToolHandlers } from './internal-tool-executor/reaction-tool.mjs';
import { createWorkspaceToolHandlers } from './internal-tool-executor/workspace-tools.mjs';

export function createInternalToolExecutor({
  rt,
  channels,
  goalRuntime,
  agentTool,
  setupTool,
  featureDisallowedTools = () => [],
  getWebSearchModule,
  getMemoryModule,
  getCodeGraphModule,
  notifyFnForSession,
  runNativeWebSearch,
  activeToolSurface,
  mcpStatus,
  awaitMcpConnect,
  skillToolContent,
  getWorkspaceApi,
  getSessionManager,
  getLifecycleApi,
  executeSessionControl,
}) {
  const handlers = {
    ...createBridgeToolHandlers({ rt }),
    ...createAskUserToolHandlers({ rt }),
    ...createReactionToolHandlers({ rt }),
    ...createFeatureToolHandlers({ rt, setupTool }),
    ...createKnowledgeToolHandlers({
      rt,
      getWebSearchModule,
      getMemoryModule,
      getCodeGraphModule,
      notifyFnForSession,
      runNativeWebSearch,
      activeToolSurface,
      mcpStatus,
      awaitMcpConnect,
      skillToolContent,
    }),
    ...createWorkspaceToolHandlers({
      rt,
      goalRuntime,
      agentTool,
      notifyFnForSession,
      getWorkspaceApi,
      getSessionManager,
      getLifecycleApi,
      executeSessionControl,
    }),
  };

  // A model call of a tool a setting turned off is refused at dispatch
  // (tool-exec/dispatch.mjs settingDisabledTool, built-ins such as git
  // included); a model-tool call reaching this executor directly takes the
  // same check against this runtime's live gate list.

  return async (name, args, callerCtx = {}) => {
    const callerCwd = clean(callerCtx?.callerCwd) || rt.currentCwd;
    // The Reactions setting gates the tool whoever calls it, not only the model.
    if (name === 'react' && rt.config?.reactions === false) throw new Error('reactions are turned off in settings');
    const disabled =
      callerCtx?.invocationSource === 'model-tool' ? settingDisabledIn(name, featureDisallowedTools()) : null;
    if (disabled) {
      throw new Error(`${disabled} is disabled in settings by the user; do not retry unless the user turns it back on`);
    }
    if (Object.hasOwn(handlers, name)) return handlers[name](args, { name, callerCtx, callerCwd });
    if (channels.isChannelTool(name)) {
      return await channels.execute(name, args || {});
    }
    throw new Error(`unknown standalone internal tool: ${name}`);
  };
}
