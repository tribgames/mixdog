/**
 * src/tui/session/transcript-intake.mjs - user / injected text → transcript items.
 *
 * Decides how a submitted or injected text lands in the transcript: a
 * synthetic tool card (task notifications, completion wrappers, agent
 * responses), a hidden model-only reminder, or a genuine user bubble.
 */
import {
  isInternalTranscriptDisplayText,
  isModelVisibleToolCompletionWrapper,
} from '../../runtime/shared/tool-execution-contract.mjs';
import { isLateToolAnnouncement } from '../../session-runtime/session-text.mjs';
import { appendPromptHistory } from '../prompt-history-store.mjs';
import {
  buildExecutionResponseToolItem,
  completionCardFromExecution,
  parseModelVisibleCompletionWrapper,
  parseSyntheticAgentMessage,
} from './agent-envelope.mjs';
import { appendAgentResponseTail } from './agent-response-tail.mjs';
import { nextId } from './transcript-spill.mjs';

export function createTranscriptIntake({ getState, flags, pushItem, patchItem, transcriptRouteMetadata }) {
  const upsertSyntheticToolItem = (text, id = nextId(), parsed = null) => {
    const synthetic = parsed || parseSyntheticAgentMessage(text);
    if (!synthetic) return false;
    const label = synthetic.label || 'notification';
    const args = synthetic.args || {
      type: label,
      task_id: synthetic.taskId || parsed?.taskId || undefined,
      description: synthetic.summary || 'agent notification',
    };
    const isError = synthetic.isError ?? /^(failed|error|timeout|killed|cancelled)$/i.test(label);
    // True upsert: one completion can reach the transcript twice (live
    // notification push + queued-twin drain render). Key on task_id + name so
    // the second arrival patches the existing card instead of duplicating it.
    const upsertTaskId = String(args?.task_id || synthetic.taskId || '').trim();
    if (upsertTaskId) {
      const existing = getState().items.findLast(
        (it) =>
          it?.kind === 'tool' &&
          String(it?.args?.task_id || '').trim() === upsertTaskId &&
          (it.name || 'agent') === (synthetic.name || 'agent')
      );
      if (existing) {
        patchItem(existing.id, {
          args,
          result: synthetic.result,
          rawResult: synthetic.rawResult ?? text,
          isError,
          completedAt: Date.now(),
        });
        return true;
      }
    }
    pushItem({
      kind: 'tool',
      id,
      name: synthetic.name || 'agent',
      args,
      result: synthetic.result,
      rawResult: synthetic.rawResult ?? text,
      isError,
      expanded: false,
      count: 1,
      completedCount: 1,
      startedAt: Date.now(),
      completedAt: Date.now(),
    });
    return true;
  };
  const pushUserOrSyntheticItem = (text, id = nextId(), origin = 'user', extra = null) => {
    // A drained task notification arrives with its provenance (queue mode +
    // execution). Render it as the tool card it is — structurally, so a body
    // the text parser cannot read still shows up instead of vanishing.
    if (origin === 'injected' && (extra?.mode === 'task-notification' || extra?.execution)) {
      const card = completionCardFromExecution(extra?.execution, text);
      if (card && upsertSyntheticToolItem(text, id, card)) return;
    }
    if (origin === 'injected') {
      const completion = parseModelVisibleCompletionWrapper(text);
      if (completion && upsertSyntheticToolItem(text, id, completion)) return;
    }
    // The lenient shape-only wrapper check is display-suppression only and
    // must never hide a real, directly-typed/pasted user prompt just because
    // it happens to resemble "instruction + Result: + quoted body". Only
    // apply it for injected origins (mid-turn steer relay of async
    // notifications, or non-editable task-notification queue entries) where
    // the text is known to have been synthesized by the runtime, not typed
    // by the user. Direct user submissions always go through the strict
    // detector only, same as before this change.
    if (origin === 'injected' && isInternalTranscriptDisplayText(text)) return;
    if (isModelVisibleToolCompletionWrapper(text)) return;
    // Late-MCP deferred-tool announcement (model-visible <system-reminder>):
    // keep it in model context, but render NOTHING user-facing — not even the
    // collapsed one-line notice (user request: hide late-tool notices entirely).
    if (isLateToolAnnouncement(text)) return;
    if (upsertSyntheticToolItem(text, id)) return;
    // Genuine, directly-typed/pasted user submissions only (never injected or
    // synthetic paths, which returned above): persist to the cwd-scoped store so
    // up-arrow history survives across sessions. Runs before pushItem so the
    // merge in pushItem's user branch (loadPromptHistory) already sees it.
    if (origin === 'user') appendPromptHistory(getState().cwd, text);
    const transcriptMeta = transcriptRouteMetadata();
    if (origin === 'user') flags.pendingTranscriptMeta = transcriptMeta;
    pushItem({
      kind: 'user',
      id,
      text,
      ...transcriptMeta,
      ...(extra && typeof extra.sender === 'string' && extra.sender ? { sender: extra.sender } : {}),
      // Byte-free attachment metadata (name/mime/size) from the queue entry —
      // lets the desktop transcript render image chips without ever carrying
      // base64 payloads through snapshots.
      ...(extra && Array.isArray(extra.images) && extra.images.length ? { images: extra.images } : {}),
    });
  };
  const pushAsyncAgentResponse = (text, id = nextId(), origin = 'injected', metadata = {}) => {
    const responseItem = buildExecutionResponseToolItem(text, {
      id,
      responseKey: metadata.responseKey || metadata.executionId,
      executionSurface: metadata.executionSurface,
      executionStatus: metadata.executionStatus,
    });
    if (!responseItem) return pushUserOrSyntheticItem(text, id, origin);
    if (responseItem.name !== 'agent') {
      pushItem(responseItem);
      return true;
    }
    const previous = getState().items.at(-1);
    // Tail-only aggregation prevents a later completion from mutating a card
    // above any outbound tool, assistant, user, or preview/body boundary.
    if (previous?.kind === 'tool' && previous.agentDirection === 'inbound') {
      const patch = appendAgentResponseTail(previous, {
        key: responseItem.agentResponseKey,
        args: responseItem.args,
        result: responseItem.result,
        rawResult: responseItem.rawResult,
        hasBody: responseItem.agentResponseHasBody,
        isError: responseItem.isError,
      });
      if (patch) {
        patchItem(previous.id, patch);
        return true;
      }
    }
    pushItem(responseItem);
    return true;
  };
  return { upsertSyntheticToolItem, pushUserOrSyntheticItem, pushAsyncAgentResponse };
}
