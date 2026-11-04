// manager/runtime-loaders.mjs
// Lazy runtime import bridges. Dynamic import()
// keeps the heavy code_graph tool / agent loop runtimes out of
// the session-creation path and avoids a circular import through loop.mjs.
import { importInStages } from '../../../../shared/staged-import.mjs';

// The agent loop's graph (~140 modules) loads one agent-loop.mjs import per
// loop turn: no module in it imports loop.mjs or agent-loop.mjs back.
const AGENT_LOOP = new URL('../loop.mjs', import.meta.url).href;
const AGENT_LOOP_STAGES = new URL('../agent-loop.mjs', import.meta.url).href;
const importAgentLoop = () => importInStages(AGENT_LOOP, AGENT_LOOP_STAGES);
let _codeGraphRuntimePromise = null;
let _agentLoopPromise = null;
let agentLoopImporter = importAgentLoop;
/** Test seam: replace the agent loop's import. */
export function setAgentLoopImporterForTest(importer) {
  agentLoopImporter = importer || importAgentLoop;
  _agentLoopPromise = null;
}
export async function _executeCodeGraphToolLazy(name, args, cwd, signal = null, options = {}) {
  _codeGraphRuntimePromise ??= import('../../tools/code-graph.mjs');
  const mod = await _codeGraphRuntimePromise;
  if (typeof mod.executeCodeGraphTool !== 'function') throw new Error('code_graph runtime is not available');
  return mod.executeCodeGraphTool(name, args, cwd, signal, options);
}
export async function _getAgentLoop() {
  // A failed load (a preload's included) is forgotten before its callers see
  // the error, so the next open retries.
  _agentLoopPromise ??= agentLoopImporter().catch((error) => {
    _agentLoopPromise = null;
    throw error;
  });
  const mod = await _agentLoopPromise;
  if (typeof mod.agentLoop !== 'function') throw new Error('agent loop runtime is not available');
  return mod.agentLoop;
}
export async function prewarmAgentLoop() {
  await _getAgentLoop();
  return true;
}
