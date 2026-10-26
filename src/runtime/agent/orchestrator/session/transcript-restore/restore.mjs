/**
 * Transcript restoration from stored model messages (restoreTranscriptItems) and the
 * context-gauge projection. Lives at the orchestrator layer because the stored
 * transcript projection (store-transcript-projection.mjs) consumes it; the TUI
 * session API re-exports it.
 */
import { contextMeasurementStats } from '../../../../shared/context-measurement.mjs';
import { toolResultText } from './tool-result-text.mjs';
import { createUserTextRestore } from './user-text.mjs';
import {
  completionCardFromExecution,
  parseModelVisibleCompletionWrapper,
  parseSyntheticAgentMessage,
} from './agent-envelope.mjs';
import {
  aggregateToolCategoryEntries,
  aggregateDoneCategories,
  classifyToolCategory,
  isTaskWaitToolCall,
  summarizeToolResult,
} from '../../../../shared/tool-surface.mjs';
import {
  aggregateBucketForCategory,
  aggregateLoadingTargets,
  aggregateRawResult,
  aggregateResultPatch,
  assignToolMetaFromMessage,
  assignUiDiffFromMessage,
  mergeAggregateCategoryEntries,
  stringUiDiffPatch,
  toolCallOutcome,
} from './tool-result-status.mjs';
import {
  isInternalTranscriptDisplayText,
  isTranscriptHiddenControlToolName,
  isTranscriptHiddenToolItem,
  isTranscriptCancelledStatusText,
} from '../../../../shared/tool-execution-contract.mjs';
import { toolResultTerminalStatus } from '../../../../shared/tool-status.mjs';
import {
  transcriptAttachmentFields,
  transcriptReactionsField,
  transcriptRouteMetadataFields,
} from '../../../../shared/transcript-metadata.mjs';
import { routineTriggerField } from '../../../../shared/routine-trigger.mjs';
import { isImportedMessage } from '../imported-message.mjs';
import { isContextAckMessage } from '../compact/user-message-kind.mjs';
import { isRoutineResultMessage, routineResultNotice } from '../routine-result.mjs';
import { heldRequestNotice, isHeldRequestMessage } from '../human-gate/held-message.mjs';
import { isRoomRowMessage, roomRowItem } from '../agent-room.mjs';

/** A failed turn's recorded end: its route, reason and quota stop, the same
 *  fields the live turndone carries. */
function restoredFailureFields(value) {
  if (value.status !== 'failed') return {};
  const errorKind = value.errorKind && typeof value.errorKind === 'object' ? value.errorKind : null;
  const quota = value.quota && typeof value.quota === 'object' ? value.quota : null;
  return {
    ...transcriptRouteMetadataFields(value),
    ...(typeof value.detail === 'string' && value.detail ? { detail: value.detail } : {}),
    ...(typeof value.errorDetails === 'string' && value.errorDetails ? { errorDetails: value.errorDetails } : {}),
    ...(errorKind && typeof errorKind.kind === 'string' ? { errorKind: { ...errorKind } } : {}),
    ...(quota && typeof quota.provider === 'string' ? { quota: { ...quota } } : {}),
  };
}

/** Whether `message` was posted into the thread outside any turn: it says so
 *  (`transcript.posted`, stamped by agent-home-delivery.mjs), or it is a row
 *  stored before that marker existed. Those carry the id agent-home-delivery
 *  mints for every posted row (`messageIdOf`: `routine_<runId>`) and are not
 *  prompts: an agent's own message (assistant role) or a result/held-request
 *  notice (stored under the user role, but not a prompt). The `routine_` scheme
 *  alone is not enough: routine-home-turn.mjs:144 gives the prompt of a routine
 *  fire (user role) the same prefix, and that prompt opens a real turn. */
function isPostedMessage(message, transcript) {
  if (transcript.posted === true) return true;
  if (typeof transcript.messageId !== 'string' || !transcript.messageId.startsWith('routine_')) return false;
  return message?.role !== 'user' || isRoutineResultMessage(message) || isHeldRequestMessage(message);
}

function restoredTranscriptMetadata(message) {
  const value = message?.meta?.transcript;
  if (!value || typeof value !== 'object') return {};
  const completionValue = value.completion && typeof value.completion === 'object' ? value.completion : null;
  const completionStatus = typeof completionValue?.status === 'string' ? completionValue.status : '';
  const completionElapsedMs = Number(completionValue?.elapsedMs);
  let completion = null;
  if (completionValue && completionStatus && Number.isFinite(completionElapsedMs)) {
    completion = { status: completionStatus, elapsedMs: Math.max(0, completionElapsedMs) };
    if (typeof completionValue.verb === 'string' && completionValue.verb) completion.verb = completionValue.verb;
    if (typeof completionValue.checkpointId === 'string' && completionValue.checkpointId) {
      completion.checkpointId = completionValue.checkpointId;
    }
    Object.assign(completion, restoredFailureFields(completionValue));
    const attemptId = completionValue.attemptId || value.attemptId;
    if (typeof attemptId === 'string' && attemptId) completion.attemptId = attemptId;
    if (Number.isFinite(Number(completionValue.at))) completion.at = Number(completionValue.at);
  }
  return {
    // The stable message id lets a live view map a compaction's dropped
    // messages back to these rows.
    ...(typeof value.messageId === 'string' && value.messageId ? { messageId: value.messageId } : {}),
    ...(Number.isFinite(Number(value.at)) ? { at: Number(value.at) } : {}),
    // Delivered into the thread outside any turn (agent-home-delivery.mjs).
    ...(isPostedMessage(message, value) ? { posted: true } : {}),
    ...transcriptRouteMetadataFields(value),
    ...(typeof value.sender === 'string' && value.sender ? { sender: value.sender } : {}),
    ...(typeof value.device === 'string' && value.device ? { device: value.device } : {}),
    ...(typeof value.fromAgent === 'string' && value.fromAgent ? { fromAgent: value.fromAgent } : {}),
    ...(typeof value.checkpointId === 'string' && value.checkpointId ? { checkpointId: value.checkpointId } : {}),
    // The attachments this prompt carried, by content hash: a restored row
    // opens/downloads them by id from the attachment store.
    ...transcriptAttachmentFields(value),
    // The bots' emoji reactions on a user message (message-reactions.mjs).
    ...transcriptReactionsField(value),
    // A routine fire this turn delivered: painted as its marker row.
    ...routineTriggerField(value),
    // Skills this user turn explicitly loaded (header selection or `$name`).
    ...(Array.isArray(value.appliedSkills) && value.appliedSkills.length
      ? { appliedSkills: value.appliedSkills.filter((name) => typeof name === 'string' && name) }
      : {}),
    ...(completion ? { completion } : {}),
  };
}

function restoredTurnDoneItem(completion, metadata, nextId, finalAssistantId = '') {
  const at = Number.isFinite(completion.at) ? completion.at : metadata.at;
  return {
    kind: 'turndone',
    id: nextId(),
    ...completion,
    ...(completion.status === 'done' && finalAssistantId ? { finalAssistantId } : {}),
    ...(Number.isFinite(at) ? { at } : {}),
    ...(metadata.messageId ? { messageId: metadata.messageId } : {}),
  };
}

// A stored message's plain text: string content as is, block content flattened.
function restoredContentText(message) {
  return typeof message?.content === 'string' ? message.content : toolResultText(message?.content);
}

function restoredAssistantTranscriptItems(message, nextId) {
  const text = restoredContentText(message).trim();
  if (!text) return [];
  const { completion, ...metadata } = restoredTranscriptMetadata(message);
  const items = [{ kind: 'assistant', id: nextId(), text, ...metadata }];
  // A failed end follows the message's tool calls (restoreTranscriptRange).
  if (completion && completion.status !== 'failed') {
    items.push(restoredTurnDoneItem(completion, metadata, nextId, items[0].id));
  }
  return items;
}

/** The failed end recorded on a message that holds no reply text before it:
 *  the prompt itself, a tool call or a tool result. */
function restoredFailedTurnItems(message, nextId) {
  const { completion, ...metadata } = restoredTranscriptMetadata(message);
  const previous = Array.isArray(message?.meta?.transcript?.previousCompletions)
    ? message.meta.transcript.previousCompletions
    : [];
  const items = previous.flatMap((value) => {
    const historical = restoredTranscriptMetadata({ meta: { transcript: { completion: value, at: value?.at } } });
    return historical.completion ? [restoredTurnDoneItem(historical.completion, historical, nextId)] : [];
  });
  if (completion?.status === 'failed') items.push(restoredTurnDoneItem(completion, metadata, nextId));
  return items;
}

// Restored tool cards: stored assistant messages keep their (compacted)
// tool_calls and the follow-up role:'tool' results. Rebuild one transcript
// tool item per call and attach its result by tool_call_id, so a reopened
// session keeps its tool markers.
function restoredMessageToolCalls(message) {
  if (Array.isArray(message?.tool_calls)) return message.tool_calls;
  if (Array.isArray(message?.toolCalls)) return message.toolCalls;
  return [];
}

function restoredToolCallItems(message, nextId, pendingByCallId) {
  const calls = restoredMessageToolCalls(message);
  const at = Number(message?.meta?.transcript?.at);
  const items = [];
  for (const call of calls) {
    const name = String(call?.function?.name || call?.name || 'tool').trim() || 'tool';
    if (isTranscriptHiddenControlToolName(name)) continue;
    let args = call?.function?.arguments ?? call?.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        /* keep the raw string args */
      }
    }
    if (isTaskWaitToolCall(name, args)) continue;
    const item = {
      kind: 'tool',
      id: nextId(),
      name,
      ...(args !== undefined && args !== '' ? { args } : {}),
      expanded: false,
      count: 1,
      completedCount: 1,
      ...(Number.isFinite(at) ? { at, startedAt: at, completedAt: at } : {}),
    };
    const callId = typeof call?.id === 'string' ? call.id : '';
    // The call id ties the card to its call and result messages (a live view
    // greys it when a compaction drops them).
    if (callId) {
      item.callId = callId;
      pendingByCallId.set(callId, item);
    }
    items.push(item);
  }
  return items;
}

function restoredResultCallId(message) {
  if (typeof message?.tool_call_id === 'string' && message.tool_call_id) return message.tool_call_id;
  if (typeof message?.toolCallId === 'string') return message.toolCallId;
  return '';
}

function attachRestoredToolResult(message, pendingByCallId) {
  const callId = restoredResultCallId(message);
  const target = callId ? pendingByCallId.get(callId) : null;
  if (!target) return;
  pendingByCallId.delete(callId);
  const text = restoredContentText(message) || '';
  target.result = text;
  assignUiDiffFromMessage(target, message);
  assignToolMetaFromMessage(target, message);
  // Cancel/crash control bodies are not red failures — show Cancelled tone.
  if (toolResultTerminalStatus(text) === 'cancelled') {
    target.isError = false;
    target.errorCount = 0;
    target.callErrorCount = 0;
    target.exitErrorCount = 0;
    return;
  }
  const { isCallError, isExitError } = toolCallOutcome({ ...message, toolName: target.name }, text);
  target.isError = isCallError;
  target.errorCount = isCallError ? 1 : 0;
  target.callErrorCount = isCallError ? 1 : 0;
  target.exitErrorCount = isExitError ? 1 : 0;
}

// Collapse a consecutive run (≥2) of restored per-call tool items into ONE
// done aggregate item shaped exactly like the live turn's '__aggregate__'
// card (turn.mjs completeAggregateVisual): merged category header counts,
// per-call result summaries as the collapsed detail, raw bodies preserved
// for expansion, tool failures and command failures surfaced separately.
function buildRestoredAggregateItem(members) {
  const header = { categories: new Map(), categoryOrder: [] };
  const calls = [];
  for (const { item, category } of members) {
    mergeAggregateCategoryEntries(header, aggregateToolCategoryEntries(item.name, item.args, category));
    const resultText = String(item.result ?? '');
    // Mirror live outcome semantics, including explicit no-match/no-change
    // markers and offloaded shell previews.
    const { exitCode, isExitError, isCallError } = toolCallOutcome(
      {
        isError: item.isError === true,
        toolName: item.name,
      },
      resultText
    );
    calls.push({
      callId: item.id,
      name: item.name,
      args: item.args,
      category,
      isError: isCallError,
      isCallError,
      isExitError,
      exitCode,
      resultText,
      rawResultText: String(item.rawResult ?? item.result ?? ''),
      ...stringUiDiffPatch(item.uiDiff),
      resolved: true,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      summary: !isCallError && resultText.trim() ? summarizeToolResult(item.name, item.args, resultText, false) : null,
    });
  }
  const outcomePatch = aggregateResultPatch({ calls }, calls, calls.length);
  const latestUiDiff = [...members]
    .reverse()
    .map(({ item }) => item)
    .find((item) => Object.hasOwn(item || {}, 'uiDiff'));
  const first = members[0].item;
  const last = members[members.length - 1].item;
  const loadingTargets = aggregateLoadingTargets(calls);
  return {
    kind: 'tool',
    id: first.id,
    name: '__aggregate__',
    args: {
      categoryOrder: header.categoryOrder,
      ...(loadingTargets.length > 0 ? { loadingTargets } : {}),
    },
    aggregate: true,
    ...(members.some(({ item }) => item.callId)
      ? { callIds: members.map(({ item }) => item.callId).filter(Boolean) }
      : {}),
    categories: Object.fromEntries(header.categories),
    doneCategories: aggregateDoneCategories(calls),
    completedCount: calls.length,
    ...outcomePatch,
    rawResult: aggregateRawResult(calls) || null,
    ...(latestUiDiff ? { uiDiff: latestUiDiff.uiDiff } : {}),
    expanded: false,
    headerFinalized: true,
    ...(first.at != null ? { at: first.at } : {}),
    ...(first.startedAt != null ? { startedAt: first.startedAt } : {}),
    ...(last.completedAt != null ? { completedAt: last.completedAt } : {}),
  };
}

// Restored transcripts must mirror the live turn's category merging: the live
// session runtime (turn.mjs) collapses consecutive same-bucket tool calls into one
// aggregate card, so a reopened session must not show them un-merged. Walk the
// restored items and merge adjacent
// tool cards whose aggregateBucketForCategory matches; any non-tool item
// (user/assistant/turndone) is a block boundary, same as the live seal rule.
// Runs of 1 keep the plain per-call card (its argument summary stays visible).
// Agent cards never merge on restore: the live rule scopes Agent grouping to
// a single provider batch, a boundary the stored history no longer carries.
function mergeRestoredToolItems(items) {
  const merged = [];
  let run = null; // { bucket, members: [{ item, category }] }
  const flushRun = () => {
    if (!run) return;
    if (run.members.length >= 2) merged.push(buildRestoredAggregateItem(run.members));
    else for (const member of run.members) merged.push(member.item);
    run = null;
  };
  for (const item of items || []) {
    // Result-dependent hiding (built-in skill loads) resolves here, after
    // every role:'tool' result has been attached to its restored call.
    if (item?.kind === 'tool' && isTranscriptHiddenToolItem(item)) continue;
    const mergeable = item?.kind === 'tool' && item.aggregate !== true;
    if (!mergeable) {
      flushRun();
      merged.push(item);
      continue;
    }
    const category = classifyToolCategory(item.name, item.args);
    const bucket = category === 'Agent' ? '' : aggregateBucketForCategory(category);
    if (!bucket) {
      flushRun();
      merged.push(item);
      continue;
    }
    if (run && run.bucket === bucket) {
      run.members.push({ item, category });
      continue;
    }
    flushRun();
    run = { bucket, members: [{ item, category }] };
  }
  flushRun();
  return merged;
}

function restoredMessageItemUpperBound(message) {
  const boundaries =
    (Array.isArray(message?.meta?.sessionInheritances) ? message.meta.sessionInheritances.length : 0) +
    (Array.isArray(message?.meta?.modelSwitches) ? message.meta.modelSwitches.length : 0) +
    (Array.isArray(message?.meta?.workflowSwitches) ? message.meta.workflowSwitches.length : 0) +
    (Array.isArray(message?.meta?.orchestrationModeSwitches) ? message.meta.orchestrationModeSwitches.length : 0);
  const completionCount =
    Number(Boolean(message?.meta?.transcript?.completion)) +
    (Array.isArray(message?.meta?.transcript?.previousCompletions)
      ? message.meta.transcript.previousCompletions.length
      : 0);
  if (message?.role === 'user') return 1 + completionCount + boundaries;
  if (message?.role !== 'assistant') return completionCount + boundaries;
  const calls = restoredMessageToolCalls(message);
  const content = message?.content;
  const hasContent = typeof content === 'string' ? content.length > 0 : Array.isArray(content) && content.length > 0;
  return Number(hasContent) + completionCount + calls.length + boundaries;
}

// One restored tool card for a parsed notification/completion envelope.
// `errorLabel` classifies the label only when the parser left isError unset.
function restoredNotificationToolItem(parsed, text, message, nextId, errorLabel) {
  const label = parsed.label || 'notification';
  const at = Number(message?.meta?.transcript?.at);
  const messageId = message?.meta?.transcript?.messageId;
  return {
    kind: 'tool',
    id: nextId(),
    ...(typeof messageId === 'string' && messageId ? { messageId } : {}),
    name: parsed.name || 'agent',
    args: parsed.args || {
      type: label,
      task_id: parsed.taskId || undefined,
      description: parsed.summary || 'agent notification',
    },
    result: parsed.result,
    rawResult: parsed.rawResult ?? text,
    isError: parsed.isError ?? errorLabel.test(label),
    expanded: false,
    count: 1,
    completedCount: 1,
    ...(Number.isFinite(at) ? { at, startedAt: at, completedAt: at } : {}),
  };
}

function restoredUserTranscriptItems(message, nextId, userText) {
  // Injected model-context payloads are model-visible but never user-authored:
  // skill bodies (meta:'skill'), hook/system reminders, and tag-wrapped context
  // blocks must not restore as user bubbles in any client.
  if (message?.meta === 'skill' || message?.meta === 'hook') return [];
  // A schedule's result in its owner's home thread: a notice row.
  // A held request of an unattended run (human-gate/held-message.mjs) likewise.
  if (isRoutineResultMessage(message) || isHeldRequestMessage(message)) {
    const { messageId, at, posted } = restoredTranscriptMetadata(message);
    return [
      {
        kind: 'notice',
        id: nextId(),
        ...(isHeldRequestMessage(message) ? heldRequestNotice(message) : routineResultNotice(message)),
        ...(messageId ? { messageId } : {}),
        ...(at ? { at } : {}),
        ...(posted ? { posted } : {}),
      },
    ];
  }
  // Imported prose renders verbatim: never a control row, card or display rewrite.
  if (isImportedMessage(message)) {
    const text = restoredContentText(message).trim();
    return text ? [{ kind: 'user', id: nextId(), text, ...restoredTranscriptMetadata(message) }] : [];
  }
  const text = userText.text(message?.content).trim();
  // Persisted async-completion wrappers ("Async shell task ... finished. Result:
  // > ...") are the only durable record of a background completion — the live
  // Response card is an event-time push that does not survive a transcript
  // rebuild. Restore them as tool cards instead of dropping them with the
  // internal-display suppression below (2026-08-17 field report: bench shell
  // output permanently missing from the pane after rebuild).
  // A row stored under the task-notification source carries its execution
  // provenance in meta, so it restores as a card even when its body has no
  // parseable envelope (restart-recovery notices). Text parsing remains the
  // fallback for rows persisted before the source existed.
  const notificationRow = message?.meta?.source === 'task-notification';
  const completion = notificationRow
    ? completionCardFromExecution(message?.meta?.execution, text)
    : parseModelVisibleCompletionWrapper(text);
  if (completion) {
    return [
      restoredNotificationToolItem(completion, text, message, nextId, /^(failed|error|timeout|killed|cancelled)$/i),
    ];
  }
  if (isInternalTranscriptDisplayText(text)) return [];
  if (!text) return [];
  // Crash-recovery control row: keep the persisted marker for the next model
  // step, but render it like a live cancel tail (◈ Cancelled) instead of a
  // raw user bubble with bracketed internals.
  if (isTranscriptCancelledStatusText(text)) {
    const { messageId } = restoredTranscriptMetadata(message);
    return [{ kind: 'turndone', id: nextId(), status: 'cancelled', elapsedMs: 0, ...(messageId ? { messageId } : {}) }];
  }
  const synthetic = parseSyntheticAgentMessage(text);
  if (!synthetic) {
    const imageRefs = userText.imageRefs(message?.content);
    return [
      {
        kind: 'user',
        id: nextId(),
        text,
        ...restoredTranscriptMetadata(message),
        ...(imageRefs.length ? { imageRefs } : {}),
        // Read by the model inside its running turn, as the live row says.
        ...(message?.meta?.source === 'steering' ? { steered: true } : {}),
      },
    ];
  }
  return [restoredNotificationToolItem(synthetic, text, message, nextId, /^(failed|error|killed|cancelled)$/i)];
}

/** The transcript row of an in-place model switch (live and restored). */
export function modelSwitchItem(id, boundary) {
  return {
    kind: 'statusdone',
    id,
    status: 'model-switched',
    label: 'Model switched',
    provider: boundary.provider,
    modelId: boundary.modelId,
    at: boundary.at,
  };
}

/** The transcript row of a mid-conversation workflow switch (live and
 *  restored); `unavailable`: the chosen workflow was gone when it was due and
 *  the conversation kept `from`. */
export function workflowSwitchItem(id, boundary) {
  return {
    kind: 'statusdone',
    id,
    status: 'workflow-switched',
    label: 'Workflow switched',
    from: boundary.from,
    to: boundary.to,
    ...(boundary.unavailable === true ? { unavailable: true } : {}),
    at: boundary.at,
  };
}

/** The transcript row of a mid-conversation orchestration (delegation) mode
 *  switch (live and restored); `from`/`to` are mode ids. */
export function orchestrationModeSwitchItem(id, boundary) {
  return {
    kind: 'statusdone',
    id,
    status: 'orchestration-mode-switched',
    label: 'Delegation mode switched',
    from: boundary.from,
    to: boundary.to,
    at: boundary.at,
  };
}

function restoreTranscriptRange(messages, start, sessionId, userText) {
  const items = [];
  const pendingToolCalls = new Map();
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    let part = 0;
    // Message-position ids remain stable when newer messages are appended and
    // let a tail-only restore skip the prefix without first counting every old
    // projected item.
    const restoredId = () => `hist_${sessionId}_${index}_${++part}`;
    // A group room's posted row (agent-room.mjs): one bubble or notice row.
    if (isRoomRowMessage(message)) {
      items.push(roomRowItem(message, restoredId()));
      continue;
    }
    if (message?.role === 'user') {
      items.push(...restoredUserTranscriptItems(message, restoredId, userText));
    } else if (message?.role === 'assistant' && !isContextAckMessage(message, messages[index - 1])) {
      items.push(...restoredAssistantTranscriptItems(message, restoredId));
      items.push(...restoredToolCallItems(message, restoredId, pendingToolCalls));
    } else if (message?.role === 'tool') {
      attachRestoredToolResult(message, pendingToolCalls);
    }
    const eventStart = items.length;
    items.push(...restoredFailedTurnItems(message, restoredId));
    for (const boundary of Array.isArray(message?.meta?.sessionInheritances) ? message.meta.sessionInheritances : []) {
      if (!boundary?.sessionId || !boundary?.provider || !boundary?.modelId) continue;
      items.push({
        kind: 'statusdone',
        id: restoredId(),
        status: 'inherited',
        label: 'Session inherited',
        detail: 'Continuing with the previous context.',
        provider: boundary.provider,
        modelId: boundary.modelId,
        at: boundary.at,
      });
    }
    for (const boundary of Array.isArray(message?.meta?.modelSwitches) ? message.meta.modelSwitches : []) {
      if (!boundary?.provider || !boundary?.modelId) continue;
      items.push(modelSwitchItem(restoredId(), boundary));
    }
    for (const boundary of Array.isArray(message?.meta?.workflowSwitches) ? message.meta.workflowSwitches : []) {
      if (!boundary?.to) continue;
      items.push(workflowSwitchItem(restoredId(), boundary));
    }
    for (const boundary of Array.isArray(message?.meta?.orchestrationModeSwitches)
      ? message.meta.orchestrationModeSwitches
      : []) {
      if (!boundary?.to) continue;
      items.push(orchestrationModeSwitchItem(restoredId(), boundary));
    }
    if (message?.meta?.transcript?.previousCompletions?.length) {
      const events = items.slice(eventStart);
      if (events.every((item) => Number.isFinite(item.at))) {
        events.sort((left, right) => left.at - right.at);
        items.splice(eventStart, events.length, ...events);
      }
    }
  }
  return mergeRestoredToolItems(items);
}

export function restoreTranscriptItems(messages, { sessionId = 'session', itemLimit = Number.POSITIVE_INFINITY } = {}) {
  const source = Array.isArray(messages) ? messages : [];
  // One projection per load: a widened range reuses each prompt's parts and
  // the paste-line reads share one budget.
  const userText = createUserTextRestore();
  const numericLimit = Number(itemLimit);
  const limited = Number.isFinite(numericLimit) && numericLimit > 0;
  if (!limited) return restoreTranscriptRange(source, 0, sessionId, userText);

  const limit = Math.max(1, Math.floor(numericLimit));
  // Restore beyond the visible cap so a boundary tool run can merge exactly
  // as it did in the full transcript. Selection is incremental from the tail:
  // large cold sessions never read or project their old message bodies.
  const target = limit + Math.min(128, limit);
  let start = source.length;
  let upperBound = 0;
  while (start > 0 && upperBound < target) {
    start -= 1;
    upperBound += restoredMessageItemUpperBound(source[start]);
  }

  let restored = restoreTranscriptRange(source, start, sessionId, userText);
  // Hidden/context messages and aggregate tool runs can make the cheap upper
  // bound optimistic. Expand backward exponentially only when necessary.
  let expansionTarget = Math.max(64, limit - restored.length);
  while (start > 0 && restored.length < limit) {
    let expansion = 0;
    while (start > 0 && expansion < expansionTarget) {
      start -= 1;
      expansion += restoredMessageItemUpperBound(source[start]);
    }
    restored = restoreTranscriptRange(source, start, sessionId, userText);
    expansionTarget *= 2;
  }
  return restored.length > limit ? restored.slice(-limit) : restored;
}

export function sessionContextSnapshotProjection(session, contextStatus) {
  if (!contextStatus) return {};
  return {
    stats: contextMeasurementStats(contextStatus),
    contextWindow: Math.max(0, Number(session?.contextWindow || contextStatus.effectiveContextWindow || 0)),
    rawContextWindow: Math.max(0, Number(session?.rawContextWindow || contextStatus.rawContextWindow || 0)),
    effectiveContextWindowPercent: Number(
      session?.effectiveContextWindowPercent ?? contextStatus.effectiveContextWindowPercent ?? 0
    ),
    displayContextWindow: Math.max(0, Number(contextStatus.contextWindow || 0)),
    compactBoundaryTokens: Math.max(0, Number(contextStatus.compaction?.boundaryTokens || 0)),
    autoCompactTokenLimit: Math.max(0, Number(contextStatus.compaction?.triggerTokens || 0)),
  };
}
