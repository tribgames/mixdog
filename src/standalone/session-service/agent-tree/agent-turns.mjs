// agent-tree/agent-turns.mjs
// Running one turn on an agent child session through the owning session
// runtime. Creating that child lives in ./agent-child.mjs.
import { randomUUID } from 'node:crypto';
import { createAgentChildFactory } from './agent-child.mjs';
import { partialHandoffTextFromSession } from '../../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';

export function createAgentTurns({
  registry,
  rehydrateAgentSessions,
  entryForSession,
  retainUnwatched,
  createSession,
  takeWatchdogStop,
}) {
  const createAgentChild = createAgentChildFactory({ registry, rehydrateAgentSessions, createSession });

  // The progress watchdog stopped the turn: rethrow its stall error carrying
  // the assistant text the turn produced, so the owner still gets a partial
  // result.
  async function watchdogStopError(runtime, error, messageStart) {
    const { messages } = await runtime.readModelMessages(messageStart);
    const partial = partialHandoffTextFromSession({ messages });
    if (partial) error.partialHandoff = partial;
    return error;
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
    // A stop left over from an earlier turn must not relabel this one.
    takeWatchdogStop(sessionId);
    // Transcript length before this turn: where a watchdog stop's partial
    // output starts.
    const { messageCount: messageStart } = await entry.runtime.readModelMessages(Number.MAX_SAFE_INTEGER);
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
        const watchdogStop = takeWatchdogStop(sessionId);
        if (watchdogStop) throw await watchdogStopError(entry.runtime, watchdogStop, messageStart);
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
