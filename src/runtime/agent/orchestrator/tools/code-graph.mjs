// Facade for the code-graph tool over the modules under ./code-graph/
// (constants, lang-predicates, text-mask, graph-model, source-access,
// symbol-index, span, project-root, graph-binary, disk-cache, memory-cache,
// build, search, dispatch).
//
// Public surface:
//   markCodeGraphDirtyPaths, CODE_GRAPH_TOOL_DEFS,
//   _pruneCodeGraphMemoryCache, _pruneCodeGraphManifestForBudget,
//   drainCodeGraphCache, prewarmCodeGraph, prewarmCodeGraphSymbols,
//   prewarmCodeGraphIfProject, buildCodeGraphAsync, _lookupCandidateNodes,
//   _buildCodeGraph and _postCodeGraphWorkerSuccess (worker-only),
//   executeCodeGraphTool, isCodeGraphTool.
//
// NOTE: code-graph-prewarm-worker.mjs imports { _buildCodeGraph } from THIS
// facade; the facade re-exports it from ./code-graph/build.mjs, and the async
// build path spawns that worker via a path RELATIVE to build.mjs — so no
// module dynamically imports its own path.
export { markCodeGraphDirtyPaths } from './code-graph-state.mjs';
export { CODE_GRAPH_TOOL_DEFS } from './code-graph-tool-defs.mjs';

export { _pruneCodeGraphMemoryCache } from './code-graph/memory-cache.mjs';
export {
  _pruneCodeGraphManifestForBudget,
  drainCodeGraphCache,
} from './code-graph/disk-cache.mjs';
export { _lookupCandidateNodes } from './code-graph/symbol-index.mjs';
export {
  prewarmCodeGraph,
  prewarmCodeGraphSymbols,
  prewarmCodeGraphIfProject,
  buildCodeGraphAsync,
  _buildCodeGraph,
  _postCodeGraphWorkerSuccess,
} from './code-graph/build.mjs';
export {
  executeCodeGraphTool,
  isCodeGraphTool,
} from './code-graph/dispatch.mjs';
