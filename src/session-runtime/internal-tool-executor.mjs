/**
 * src/session-runtime/internal-tool-executor.mjs - name-dispatched executor
 * for the lead runtime's internal (non-MCP) tools: bridges, office/media,
 * setup, web search, memory, code graph, tool search, cwd, skills, goals,
 * agents, and channels. Extracted from runtime-core.mjs.
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { executeBrowserTool } from '../runtime/browser-bridge/client.mjs';
import { executeComputerTool } from '../runtime/computer-bridge/client.mjs';
import { executeOfficeTool } from '../runtime/office/index.mjs';
import { executeMediaTool } from '../runtime/media/tool.mjs';
import { featureEnvOverride } from './config-helpers.mjs';
import { renderToolSearch } from './tool-catalog.mjs';
import { clean } from './session-text.mjs';
import { STANDALONE_DATA_DIR } from './runtime-paths.mjs';
import {
  dispatchWebSearchRuntimeTool,
  memoryToolArgsForCaller,
} from './runtime-tool-routing.mjs';

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
  return async (name, args, callerCtx = {}) => {
    const callerCwd = clean(callerCtx?.callerCwd) || rt.currentCwd;
    if (callerCtx?.invocationSource === 'model-tool') {
      if ((name === 'web_search' || name === 'web_fetch') && !webSearchEnabled()) {
        throw new Error('web search is disabled in settings; start a new session to refresh the tool list');
      }
      if ((name === 'memory' || name === 'recall') && !memoryToolsEnabled()) {
        throw new Error('memory tools are disabled in settings; background memory and manual core memory remain available');
      }
    }
    if (name === 'browser') {
      if (callerCtx?.invocationSource === 'model-tool' && featureEnvOverride('MIXDOG_FEATURE_BROWSER') === false) {
        throw new Error('the browser tool is disabled in this environment');
      }
      return await executeBrowserTool(args, {
        sessionId: callerCtx?.sessionId || callerCtx?.callerSessionId || rt.session?.id,
        turnId: callerCtx?.turnId || rt.session?.usageMetricsTurnId,
        signal: callerCtx?.signal || rt.session?.controller?.signal || null,
      });
    }
    if (name === 'computer') {
      if (callerCtx?.invocationSource === 'model-tool' && featureEnvOverride('MIXDOG_FEATURE_COMPUTER') === false) {
        throw new Error('the computer tool is disabled in this environment');
      }
      return await executeComputerTool(args, {
        sessionId: callerCtx?.sessionId || callerCtx?.callerSessionId || rt.session?.id,
        cwd: callerCwd,
        requestApproval: callerCtx?.toolApprovalHook,
        toolCallId: callerCtx?.toolCallId || null,
        signal: callerCtx?.signal || rt.session?.controller?.signal || null,
      });
    }
    if (name === 'office') {
      if (callerCtx?.invocationSource === 'model-tool' && !officeToolsEnabled()) {
        throw new Error('office is disabled in settings; start a new session to refresh the tool list');
      }
      return await executeOfficeTool(args, {
        cwd: callerCwd,
        dataDir: STANDALONE_DATA_DIR,
        requestApproval: callerCtx?.toolApprovalHook,
        sessionId: callerCtx?.sessionId,
        toolCallId: callerCtx?.toolCallId,
        signal: callerCtx?.signal || rt.session?.controller?.signal || null,
      });
    }
    if (name === 'media') {
      if (callerCtx?.invocationSource === 'model-tool' && !mediaToolEnabled()) {
        throw new Error('media is disabled in settings; start a new session to refresh the tool list');
      }
      return await executeMediaTool(args, {
        cwd: callerCwd,
        signal: callerCtx?.signal || rt.session?.controller?.signal || null,
      });
    }
    if (name === 'setup') {
      return await setupTool.execute(args || {});
    }
    if (name === 'web_search' || name === 'web_fetch' || name === 'local_fetch' || name === 'image_fetch') {
      return dispatchWebSearchRuntimeTool(name, args, callerCtx, {
        getWebSearchModule,
        getCurrentCwd: () => rt.currentCwd,
        getSession: () => rt.session,
        notifyFnForSession,
        runNativeWebSearch,
      });
    }
    if (name === 'recall' || name === 'memory' || name === 'search_memories') {
      const memoryMod = await getMemoryModule();
      if (!memoryMod?.handleToolCall) throw new Error('memory runtime is not available');
      return await memoryMod.handleToolCall(
        name,
        memoryToolArgsForCaller(args, callerCwd),
        callerCtx?.signal || rt.session?.controller?.signal || null,
      );
    }
    if (name === 'code_graph') {
      const codeGraphMod = await getCodeGraphModule();
      if (!codeGraphMod?.executeCodeGraphTool) throw new Error('code_graph runtime is not available');
      return await codeGraphMod.executeCodeGraphTool(name, args || {}, args?.cwd || callerCwd);
    }
    if (name === 'tool_search' || name === 'load_tool') {
      return renderToolSearch(args, activeToolSurface(), rt.mode, { mcpStatus });
    }
    if (name === 'cwd') {
      const action = clean(args?.action || (args?.path ? 'set' : 'get')).toLowerCase();
      let currentCwd = callerCwd;
      if (action === 'set') {
        const rawPath = clean(args?.path);
        if (!rawPath) throw new Error('cwd: path is required for action=set');
        const nextCwd = resolve(callerCwd || process.cwd(), rawPath);
        const stat = statSync(nextCwd);
        if (!stat.isDirectory()) throw new Error(`cwd: not a directory: ${nextCwd}`);
        currentCwd = typeof callerCtx?.setCallerCwd === 'function'
          ? clean(await callerCtx.setCallerCwd(nextCwd)) || nextCwd
          : applyResolvedCwd(nextCwd, { persistProjectSelection: true });
      } else if (action !== 'get') {
        throw new Error(`cwd: unknown action "${action}"`);
      }
      return JSON.stringify({
        cwd: currentCwd,
        sessionId: callerCtx?.callerSessionId || rt.session?.id || null,
      }, null, 2);
    }
    if (name === 'Skill') {
      return skillToolContent(args?.name);
    }
    if (name === 'goal' || name === 'get_goal' || name === 'create_goal' || name === 'set_goal_tasks' || name === 'update_goal') {
      return await goalRuntime.executeTool(name, args || {}, {
        callerSessionId: callerCtx?.callerSessionId || rt.session?.id || rt.reservedSessionId || null,
      });
    }
    if (name === 'agent') {
      const callerSessionId = callerCtx?.callerSessionId || rt.session?.id || null;
      return await agentTool.execute(args, {
        callerCwd,
        invocationSource: 'model-tool',
        callerSessionId,
        clientHostPid: callerCtx?.clientHostPid || rt.session?.clientHostPid || process.pid,
        signal: callerCtx?.signal,
        notifyFn: notifyFnForSession(callerSessionId),
      });
    }
    if (channels.isChannelTool(name)) {
      if (!channelsEnabled()) throw new Error('channels are disabled in settings');
      return await channels.execute(name, args || {});
    }
    throw new Error(`unknown standalone internal tool: ${name}`);
  };
}
