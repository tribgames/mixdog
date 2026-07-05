// manager/runtime-loaders.mjs
// Lazy runtime import bridges extracted from manager.mjs. Dynamic import()
// keeps the heavy code_graph tool / agent loop / bash-session runtimes out of
// the session-creation path and avoids a circular import through loop.mjs.
let _codeGraphRuntimePromise = null;
let _agentLoopPromise = null;
let _bashSessionRuntimePromise = null;
export async function _executeCodeGraphToolLazy(name, args, cwd, signal = null, options = {}) {
    _codeGraphRuntimePromise ??= import('../../tools/code-graph.mjs');
    const mod = await _codeGraphRuntimePromise;
    if (typeof mod.executeCodeGraphTool !== 'function') throw new Error('code_graph runtime is not available');
    return mod.executeCodeGraphTool(name, args, cwd, signal, options);
}
export async function _getAgentLoop() {
    _agentLoopPromise ??= import('../loop.mjs');
    const mod = await _agentLoopPromise;
    if (typeof mod.agentLoop !== 'function') throw new Error('agent loop runtime is not available');
    return mod.agentLoop;
}
export function _closeBashSessionLazy(sessionId, reason) {
    if (!sessionId) return;
    _bashSessionRuntimePromise ??= import('../../tools/bash-session.mjs');
    _bashSessionRuntimePromise
        .then((mod) => { if (typeof mod.closeBashSession === 'function') mod.closeBashSession(sessionId, reason); })
        .catch(() => {});
}
