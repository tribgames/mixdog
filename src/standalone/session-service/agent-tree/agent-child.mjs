// agent-tree/agent-child.mjs
// Creating one agent child session: the session profile derived from the
// caller's spec, creation of the runtime behind it, and the descriptor linked
// into the agent registry. Running a turn on that child is ./agent-turns.mjs.

export function createAgentChildFactory({ registry, rehydrateAgentSessions, createSession }) {
  return async function createAgentChild({ spec = {}, prompt: _prompt = '', tag = null } = {}) {
    await rehydrateAgentSessions();
    const parentSessionId = String(spec.parentSessionId || '').trim();
    if (!parentSessionId) throw new TypeError('agent child parentSessionId is required');
    const ownerSessionId = String(
      spec.ownerSessionId || registry.get(parentSessionId)?.ownerSessionId || parentSessionId
    );
    const preset = spec.preset && typeof spec.preset === 'object' ? spec.preset : {};
    const provider = String(preset.provider || spec.provider || '').trim();
    const model = String(preset.model || spec.model || '').trim();
    if (!provider || !model) throw new Error('agent child route is incomplete');
    const sessionProfile = {
      owner: 'agent',
      agent: String(spec.agent || 'worker'),
      parentSessionId,
      ownerSessionId,
      visibility: 'agent-only',
      agentTag: String(spec.agentTag || tag || '').trim() || null,
      taskType: spec.taskType || null,
      permission: spec.permission || null,
      permissionMode: spec.permissionMode || null,
      schemaAllowedTools: Array.isArray(spec.schemaAllowedTools) ? spec.schemaAllowedTools : null,
      sourceType: spec.sourceType || 'agent',
      sourceName: spec.sourceName || spec.agent || 'agent',
      clientHostPid: spec.clientHostPid || null,
    };
    const created = await createSession({
      cwd: spec.cwd || process.cwd(),
      provider,
      model,
      effort: preset.effort,
      fast: preset.fast === true,
      modelParameters: preset.modelParameters,
      toolMode: 'full',
      sessionProfile,
    });
    const descriptor = registry.linkAgentDescriptor({
      id: created.sessionId,
      ...sessionProfile,
      cwd: spec.cwd || process.cwd(),
      provider,
      model,
      presetName: preset.id || preset.name || null,
      effort: preset.effort || null,
      fast: preset.fast === true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
      stage: 'idle',
    });
    return { session: descriptor, effectiveCwd: descriptor.cwd };
  };
}
