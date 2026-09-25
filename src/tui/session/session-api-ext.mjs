/**
 * src/tui/session/session-api-ext.mjs - part of the public session runtime session object.
 *
 * Owns the transcript restoration from stored model messages
 * (restoreTranscriptItems) and the context-gauge projection; createSessionApiB
 * composes the surface groups under session-api/ (routes, integrations,
 * media, lifecycle).
 */
import { contextMeasurementStats } from '../../ui/context-measurement.mjs';
import { toolResultText } from './tool-result-text.mjs';
import {
  completionCardFromExecution,
  parseModelVisibleCompletionWrapper,
  parseSyntheticAgentMessage,
} from './agent-envelope.mjs';
import { createSessionOAuthFlowRegistry } from './oauth-flows.mjs';
import { createSessionRouteApi } from './session-api/routes.mjs';
import { createSessionIntegrationsApi } from './session-api/integrations.mjs';
import { createSessionMediaApi } from './session-api/media.mjs';
import { createSessionLifecycleApi } from './session-api/lifecycle.mjs';
import {
  aggregateToolCategoryEntries,
  aggregateDoneCategories,
  classifyToolCategory,
  isTaskWaitToolCall,
  summarizeToolResult,
} from '../../runtime/shared/tool-surface.mjs';
import {
  aggregateBucketForCategory,
  aggregateLoadingTargets,
  aggregateRawResult,
  aggregateResultPatch,
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
} from '../../runtime/shared/tool-execution-contract.mjs';
import { toolResultTerminalStatus } from '../../runtime/shared/tool-status.mjs';
import { transcriptRouteMetadataFields } from '../../runtime/shared/transcript-metadata.mjs';

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
  }
  return {
    ...(Number.isFinite(Number(value.at)) ? { at: Number(value.at) } : {}),
    ...transcriptRouteMetadataFields(value),
    ...(typeof value.sender === 'string' && value.sender ? { sender: value.sender } : {}),
    ...(completion ? { completion } : {}),
  };
}

function restoredAssistantTranscriptItems(message, nextId) {
  const text = (typeof message?.content === 'string' ? message.content : toolResultText(message?.content)).trim();
  if (!text) return [];
  const { completion, ...metadata } = restoredTranscriptMetadata(message);
  const items = [{ kind: 'assistant', id: nextId(), text, ...metadata }];
  if (completion) {
    items.push({
      kind: 'turndone',
      id: nextId(),
      ...completion,
      ...(metadata.at ? { at: metadata.at } : {}),
    });
  }
  return items;
}

// Restored tool cards: stored assistant messages keep their (compacted)
// tool_calls and the follow-up role:'tool' results, but resume used to drop
// both — a reopened session lost every tool marker (user bug). Rebuild one
// transcript tool item per call and attach its result by tool_call_id.
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
    if (callId) pendingByCallId.set(callId, item);
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
  const text = (typeof message?.content === 'string' ? message.content : toolResultText(message?.content)) || '';
  target.result = text;
  assignUiDiffFromMessage(target, message);
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
// aggregate card, but resume rebuilt one card per call, so a reopened session
// un-merged every run (user bug). Walk the restored items and merge adjacent
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
  const boundaries = Array.isArray(message?.meta?.sessionInheritances) ? message.meta.sessionInheritances.length : 0;
  if (message?.role === 'user') return 1 + boundaries;
  if (message?.role !== 'assistant') return boundaries;
  const calls = restoredMessageToolCalls(message);
  const content = message?.content;
  const hasContent = typeof content === 'string' ? content.length > 0 : Array.isArray(content) && content.length > 0;
  const hasCompletion = Boolean(message?.meta?.transcript?.completion);
  return Number(hasContent) + Number(hasCompletion) + calls.length + boundaries;
}

// One restored tool card for a parsed notification/completion envelope.
// `errorLabel` classifies the label only when the parser left isError unset.
function restoredNotificationToolItem(parsed, text, message, nextId, errorLabel) {
  const label = parsed.label || 'notification';
  const at = Number(message?.meta?.transcript?.at);
  return {
    kind: 'tool',
    id: nextId(),
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

function restoredUserTranscriptItems(message, nextId) {
  // Injected model-context payloads are model-visible but never user-authored:
  // skill bodies (meta:'skill'), hook/system reminders, and tag-wrapped context
  // blocks must not restore as user bubbles in any client.
  if (message?.meta === 'skill' || message?.meta === 'hook') return [];
  const text = (typeof message?.content === 'string' ? message.content : toolResultText(message?.content)).trim();
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
    return [{ kind: 'turndone', id: nextId(), status: 'cancelled', elapsedMs: 0 }];
  }
  const synthetic = parseSyntheticAgentMessage(text);
  if (!synthetic) {
    return [{ kind: 'user', id: nextId(), text, ...restoredTranscriptMetadata(message) }];
  }
  return [restoredNotificationToolItem(synthetic, text, message, nextId, /^(failed|error|killed|cancelled)$/i)];
}

function restoreTranscriptRange(messages, start, sessionId) {
  const items = [];
  const pendingToolCalls = new Map();
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    let part = 0;
    // Message-position ids remain stable when newer messages are appended and
    // let a tail-only restore skip the prefix without first counting every old
    // projected item.
    const restoredId = () => `hist_${sessionId}_${index}_${++part}`;
    if (message?.role === 'user') {
      items.push(...restoredUserTranscriptItems(message, restoredId));
    } else if (message?.role === 'assistant') {
      items.push(...restoredAssistantTranscriptItems(message, restoredId));
      items.push(...restoredToolCallItems(message, restoredId, pendingToolCalls));
    } else if (message?.role === 'tool') {
      attachRestoredToolResult(message, pendingToolCalls);
    }
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
  }
  return mergeRestoredToolItems(items);
}

export function restoreTranscriptItems(messages, { sessionId = 'session', itemLimit = Number.POSITIVE_INFINITY } = {}) {
  const source = Array.isArray(messages) ? messages : [];
  const numericLimit = Number(itemLimit);
  const limited = Number.isFinite(numericLimit) && numericLimit > 0;
  if (!limited) return restoreTranscriptRange(source, 0, sessionId);

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

  let restored = restoreTranscriptRange(source, start, sessionId);
  // Hidden/context messages and aggregate tool runs can make the cheap upper
  // bound optimistic. Expand backward exponentially only when necessary.
  let expansionTarget = Math.max(64, limit - restored.length);
  while (start > 0 && restored.length < limit) {
    let expansion = 0;
    while (start > 0 && expansion < expansionTarget) {
      start -= 1;
      expansion += restoredMessageItemUpperBound(source[start]);
    }
    restored = restoreTranscriptRange(source, start, sessionId);
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

export function createSessionApiB(bag) {
  const oauthFlows = createSessionOAuthFlowRegistry();
  return {
    ...createSessionRouteApi(bag),
    ...createSessionIntegrationsApi(bag, { oauthFlows }),
    ...createSessionMediaApi(bag),
    ...createSessionLifecycleApi(bag, { restoreTranscriptItems, oauthFlows }),
  };
}
