// agent-tree/agent-turns.mjs
// Creating an agent child session and running one turn on it through the
// owning session runtime.
import { randomUUID } from 'node:crypto';

export function createAgentTurns({
  registry,
  rehydrateAgentSessions,
  entryForSession,
  retainUnwatched,
  createSession,
}) {
  async function createAgentChild({ spec = {}, prompt = '', tag = null } = {}) {
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
    void prompt;
    return { session: descriptor, effectiveCwd: descriptor.cwd };
  }

  async function runAgentTurn({ session, prompt, context = null, onToolResult, onTerminalResult } = {}) {
    await rehydrateAgentSessions();
    const sessionId = String(session?.id || session || '').trim();
    const descriptor = registry.get(sessionId);
    if (!descriptor || descriptor.closed) {
      throw new Error(`agent session ${sessionId || '(empty)'} is closed`);
    }
    const entry = await entryForSession(sessionId, {
      cwd: descriptor.cwd,
      provider: descriptor.provider,
      model: descriptor.model,
      toolMode: 'full',
    });
    const target = entry.runtime.submitAndWait;
    if (typeof target !== 'function') {
      throw new TypeError('session runtime must implement submitAndWait');
    }
    descriptor.status = 'running';
    descriptor.stage = 'running';
    descriptor.updatedAt = Date.now();
    try {
      const options = {
        id: `agent-turn-${randomUUID()}`,
        mode: 'prompt',
        priority: 'next',
        context,
        transcriptMeta: { sender: 'lead' },
        ...(entry.runtime.isWireSafe === true || typeof onToolResult !== 'function' ? {} : { onToolResult }),
      };
      const detail = await target.call(entry.runtime, String(prompt || ''), options);
      if (detail?.status === 'failed') {
        throw new Error(String(detail.error || 'agent session turn failed'));
      }
      if (detail?.status === 'cancelled') {
        throw new Error('agent session turn cancelled');
      }
      const result = detail?.result || { content: '' };
      descriptor.status = 'idle';
      descriptor.stage = 'idle';
      descriptor.lastHandoff = typeof result?.content === 'string' ? result.content : '';
      try {
        onTerminalResult?.(result);
      } catch {}
      return result;
    } catch (error) {
      descriptor.status = /cancel/i.test(String(error?.message || '')) ? 'cancelled' : 'error';
      descriptor.stage = descriptor.status;
      throw error;
    } finally {
      descriptor.updatedAt = Date.now();
      retainUnwatched(entry, 'agent child idle');
    }
  }

  return { createAgentChild, runAgentTurn };
}
