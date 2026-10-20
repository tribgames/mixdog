// Tools that read rather than act: web search/fetch, memory, the code graph,
// the deferred tool catalog, and skill bodies.
import {
  deferredCatalogUnion,
  refreshDeferredMcpToolCatalog,
  renderToolSearch,
} from '../../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';
import { parseToolSelection } from '../../runtime/agent/orchestrator/runtime-core/tool-catalog-schema.mjs';
import { resolveDeferredSelectMode } from '../../runtime/agent/orchestrator/session/loop/deferred-call-through.mjs';
import { dispatchWebSearchRuntimeTool, memoryToolArgsForCaller } from '../runtime-tool-routing.mjs';
import { createCallerContextResolvers } from './caller-context.mjs';
import { memoryCallerScope } from '../services/memory-access.mjs';

export function createKnowledgeToolHandlers({
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
}) {
  const { signalFor } = createCallerContextResolvers(rt);
  const webSearch = (args, { name, callerCtx }) =>
    dispatchWebSearchRuntimeTool(name, args, callerCtx, {
      getWebSearchModule,
      getCurrentCwd: () => rt.currentCwd,
      getSession: () => rt.session,
      notifyFnForSession,
      runNativeWebSearch,
    });

  // The calling session's memory scope always replaces any model-supplied
  // one: the memory runtime authorizes every pool read and write by it. A
  // caller named but not resolvable here counts as an unattended run.
  const memoryCallerSession = (callerCtx) => {
    if (callerCtx?.callerSession) return callerCtx.callerSession;
    const id = callerCtx?.callerSessionId;
    return !id || id === rt.session?.id ? rt.session || null : null;
  };
  const memory = async (args, { name, callerCtx, callerCwd }) => {
    const memoryMod = await getMemoryModule();
    if (!memoryMod?.handleToolCall) throw new Error('memory runtime is not available');
    const memoryCaller = memoryCallerScope(memoryCallerSession(callerCtx));
    return await memoryMod.handleToolCall(
      name,
      { ...memoryToolArgsForCaller(args, callerCwd), memory_caller: memoryCaller },
      signalFor(callerCtx)
    );
  };

  // Catalog tools answer for the calling session's own scope, bridge or
  // native: a worker sees its own catalog (its own allow/deny), never the
  // lead's. Only a call that names no session uses the active surface.
  const scopeSession = (callerCtx) => callerCtx?.callerSession || activeToolSurface();
  const scopeMode = (session) => session?.deferredSurfaceMode || resolveDeferredSelectMode(session) || rt.mode;

  const catalogLacks = (session, names) => {
    const known = new Set(deferredCatalogUnion(session).map((tool) => String(tool?.name || '').toLowerCase()));
    return parseToolSelection(names).some((name) => !known.has(String(name).toLowerCase()));
  };
  // A name the catalog does not hold yet may belong to a server still in its
  // handshake (a fresh session's first turn, or the reconnect after a
  // sign-in): wait for that connect before reporting it missing. Returns at
  // once when no connect is in flight.
  const toolSearch = async (args, { callerCtx } = {}) => {
    const session = scopeSession(callerCtx);
    refreshDeferredMcpToolCatalog(session, rt.config);
    if (awaitMcpConnect && catalogLacks(session, args?.names)) {
      await awaitMcpConnect();
      refreshDeferredMcpToolCatalog(session, rt.config);
    }
    return renderToolSearch(args, session, scopeMode(session), { mcpStatus });
  };

  return {
    web_search: webSearch,
    web_fetch: webSearch,
    local_fetch: webSearch,
    image_fetch: webSearch,
    recall: memory,
    memory,
    code_graph: async (args, { name, callerCwd }) => {
      const codeGraphMod = await getCodeGraphModule();
      if (!codeGraphMod?.executeCodeGraphTool) throw new Error('code_graph runtime is not available');
      return await codeGraphMod.executeCodeGraphTool(name, args || {}, args?.cwd || callerCwd);
    },
    load_tool: toolSearch,
    Skill: (args) => skillToolContent(args?.name, activeToolSurface(), rt.mode),
  };
}
