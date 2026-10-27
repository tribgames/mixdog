// agent-tree/agent-turns.mjs
// Running one turn on an agent child session through the owning session
// runtime. Creating that child lives in ./agent-child.mjs.
import { randomUUID } from 'node:crypto';
import { createAgentChildFactory } from './agent-child.mjs';
import { partialHandoffTextFromSession } from '../../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import { attachmentsForIntake } from '../../../runtime/attachments/store.mjs';
import { producedFileLines } from '../../../runtime/shared/handoff-artifacts.mjs';
import {
  collectUnreportedWrites,
  handoffContent,
  sessionRoots,
} from '../../../session-runtime/handoff-attachments.mjs';

/** An agent turn's prompt: text, or text with forwarded attachment parts
 *  (handoff-attachments.mjs), never any other shape. */
export function agentTurnContent(prompt) {
  if (!Array.isArray(prompt)) return String(prompt || '');
  const text = prompt
    .filter((part) => part?.type === 'text' && !part.attachmentRef)
    .map((part) => String(part.text || ''))
    .join('\n');
  return handoffContent(text, prompt);
}

/** The prompt row's metadata: a Lead's message, with the files it carries. */
export function agentTurnTranscriptMeta(content) {
  const attachments = Array.isArray(content) ? attachmentsForIntake(content) : [];
  return { sender: 'lead', ...(attachments.length ? { attachments } : {}) };
}

/** The lines for files the turn that began at `messageStart` created or
 *  modified and `report` does not already name; [] on any failure to read it
 *  (the handoff still goes out). */
async function turnArtifactLines(runtime, messageStart, descriptor, report) {
  try {
    const { messages } = await runtime.readModelMessages(messageStart);
    const session = runtime.session || descriptor;
    const { files, omitted } = collectUnreportedWrites(messages, {
      cwd: descriptor.cwd,
      roots: sessionRoots(session, descriptor.cwd),
      report,
    });
    return producedFileLines(files, omitted);
  } catch {
    return [];
  }
}

export function createAgentTurns({
  registry,
  rehydrateAgentSessions,
  entryForSession,
  retainUnwatched,
  createSession,
  takeWatchdogStop,
  takeCancelTranscript,
}) {
  const createAgentChild = createAgentChildFactory({
    registry,
    rehydrateAgentSessions,
    createSession,
    entryForSession,
  });

  // The turn was stopped (progress watchdog or cancellation): rethrow its error
  // carrying the assistant text the turn produced, so the owner still gets a
  // partial result. A cancel that closed the session captured the transcript
  // before the close cleared it.
  async function withPartialHandoff(runtime, sessionId, error, messageStart) {
    try {
      const captured = takeCancelTranscript(sessionId);
      const messages = captured
        ? captured.slice(messageStart)
        : (await runtime.readModelMessages(messageStart)).messages;
      const partial = partialHandoffTextFromSession({ messages });
      if (partial) error.partialHandoff = partial;
    } catch {}
    return error;
  }

  async function runAgentTurn({ session, prompt, context = null, onToolResult, onTerminalResult } = {}) {
    await rehydrateAgentSessions();
    const sessionId = String(session?.id || session || '').trim();
    const cancelEpoch = registry.assertAdmission(sessionId);
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
    registry.assertAdmission(sessionId, cancelEpoch);
    if (typeof target !== 'function') {
      throw new TypeError('session runtime must implement submitAndWait');
    }
    // A stop left over from an earlier turn must not relabel this one.
    takeWatchdogStop(sessionId);
    takeCancelTranscript(sessionId);
    // Transcript length before this turn: where a watchdog stop's partial
    // output starts.
    const { messageCount: messageStart } = await entry.runtime.readModelMessages(Number.MAX_SAFE_INTEGER);
    registry.assertAdmission(sessionId, cancelEpoch);
    descriptor.status = 'running';
    descriptor.stage = 'running';
    descriptor.updatedAt = Date.now();
    try {
      const content = agentTurnContent(prompt);
      const options = {
        id: `agent-turn-${randomUUID()}`,
        mode: 'prompt',
        priority: 'next',
        context,
        transcriptMeta: agentTurnTranscriptMeta(content),
        ...(entry.runtime.isWireSafe === true || typeof onToolResult !== 'function' ? {} : { onToolResult }),
      };
      const detail = await target.call(entry.runtime, content, options);
      if (detail?.status === 'failed') {
        throw new Error(String(detail.error || 'agent session turn failed'));
      }
      if (detail?.status === 'cancelled') {
        const stop = takeWatchdogStop(sessionId) || new Error('agent session turn cancelled');
        throw await withPartialHandoff(entry.runtime, sessionId, stop, messageStart);
      }
      // Only a completed turn has a result; a rejected submission (session
      // closing/terminal, steering persist failure) or any unknown status is a
      // failure, never an empty completion.
      if (detail?.status !== 'done' && detail?.status !== 'completed') {
        const status = String(detail?.status || 'unknown');
        const reason = String(detail?.reason || detail?.error || '').trim();
        throw new Error(`agent turn ${status}${reason ? `: ${reason}` : ''}`);
      }
      let result = detail?.result || { content: '' };
      // The files the turn produced reach the owner with its handoff.
      const report = String(result.content || '');
      const files = await turnArtifactLines(entry.runtime, messageStart, descriptor, report);
      if (files.length) result = { ...result, content: [report, files.join('\n')].join('\n\n') };
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
      takeCancelTranscript(sessionId);
      descriptor.updatedAt = Date.now();
      retainUnwatched(entry, 'agent child idle');
    }
  }

  return { createAgentChild, runAgentTurn };
}
