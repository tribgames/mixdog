// Facade for the code-graph tool over the modules under ./code-graph/
// (constants, lang-predicates, text-mask, graph-model, source-access,
// symbol-index, span, project-root, graph-binary, disk-cache, memory-cache,
// build, search, dispatch).
//
// Public surface:
//   _buildCodeGraph and _postCodeGraphWorkerSuccess (worker-only),
//   executeCodeGraphTool.
//
// NOTE: code-graph-prewarm-worker.mjs imports { _buildCodeGraph } from THIS
// facade; the facade re-exports it from ./code-graph/build.mjs, and the async
// build path spawns that worker via a path RELATIVE to build.mjs — so no
// module dynamically imports its own path.
export {
  _buildCodeGraph,
  _postCodeGraphWorkerSuccess,
} from './code-graph/build.mjs';
export { executeCodeGraphTool } from './code-graph/dispatch.mjs';
