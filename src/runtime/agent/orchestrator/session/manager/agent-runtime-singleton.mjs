// manager/agent-runtime-singleton.mjs
// Agent Runtime injection singleton extracted from manager.mjs. Injected via
// setAgentRuntime() during plugin init; read by createSession/resumeSession
// and askSession's cache-stat recorder.
//
// Agent Runtime is optional — if never injected, createSession simply falls
// back to classic preset-only behavior.
let _agentRuntimeApi = null;
let _agentRuntimeWarned = false;

/**
 * Inject the Agent Runtime singleton. Called once by agent/index.mjs init()
 * after initAgentRuntime(). Safe to call multiple times — later calls
 * replace the previous reference.
 */
export function setAgentRuntime(api) {
    _agentRuntimeApi = api || null;
}

export function getAgentRuntimeSync() {
    return _agentRuntimeApi;
}

// Log a resolve failure exactly once, then fall back to classic behavior.
export function warnAgentRuntimeResolveFailureOnce(message) {
    if (_agentRuntimeWarned) return;
    _agentRuntimeWarned = true;
    process.stderr.write(`[session] agent runtime resolve failed: ${message}\n`);
}
