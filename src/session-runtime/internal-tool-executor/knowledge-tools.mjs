// Tools that read rather than act: web search/fetch, memory, the code graph,
// the deferred tool catalog, and skill bodies.
import { refreshDeferredMcpToolCatalog, renderToolSearch } from '../tool-catalog.mjs';
import { dispatchWebSearchRuntimeTool, memoryToolArgsForCaller } from '../runtime-tool-routing.mjs';

export function createKnowledgeToolHandlers({
  rt,
  getWebSearchModule,
  getMemoryModule,
  getCodeGraphModule,
  notifyFnForSession,
  runNativeWebSearch,
  activeToolSurface,
  mcpStatus,
  skillToolContent,
}) {
  const webSearch = (args, { name, callerCtx }) =>
    dispatchWebSearchRuntimeTool(name, args, callerCtx, {
      getWebSearchModule,
      getCurrentCwd: () => rt.currentCwd,
      getSession: () => rt.session,
      notifyFnForSession,
      runNativeWebSearch,
    });

  const memory = async (args, { name, callerCtx, callerCwd }) => {
    const memoryMod = await getMemoryModule();
    if (!memoryMod?.handleToolCall) throw new Error('memory runtime is not available');
    return await memoryMod.handleToolCall(
      name,
      memoryToolArgsForCaller(args, callerCwd),
      callerCtx?.signal || rt.session?.controller?.signal || null
    );
  };

  const toolSearch = (args) => {
    const surface = activeToolSurface();
    refreshDeferredMcpToolCatalog(surface, rt.config);
    return renderToolSearch(args, surface, rt.mode, { mcpStatus });
  };

  return {
    web_search: webSearch,
    web_fetch: webSearch,
    local_fetch: webSearch,
    image_fetch: webSearch,
    recall: memory,
    memory,
    search_memories: memory,
    code_graph: async (args, { name, callerCwd }) => {
      const codeGraphMod = await getCodeGraphModule();
      if (!codeGraphMod?.executeCodeGraphTool) throw new Error('code_graph runtime is not available');
      return await codeGraphMod.executeCodeGraphTool(name, args || {}, args?.cwd || callerCwd);
    },
    tool_search: toolSearch,
    load_tool: toolSearch,
    Skill: (args) => skillToolContent(args?.name, activeToolSurface(), rt.mode),
  };
}
