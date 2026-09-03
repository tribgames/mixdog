/**
 * src/tui/session/session-api-ext.mjs - part of the public session runtime session object.
 */
import { listThemes, getThemeSetting, setThemeSetting } from '../theme.mjs';
import { resetAllStreamingMarkdownStablePrefixes } from '../markdown/streaming-markdown.mjs';
import { toolResultText } from './tool-result-text.mjs';
import { completionCardFromExecution, parseModelVisibleCompletionWrapper, parseSyntheticAgentMessage } from './agent-envelope.mjs';
import { flushTuiSteeringPersist } from './tui-steering-persist.mjs';
import { getVoiceStatus, toggleVoice } from '../lib/voice-setup.mjs';
import { createSessionOAuthFlowRegistry } from './oauth-flows.mjs';
import { aggregateToolCategoryEntries, aggregateDoneCategories, classifyToolCategory, formatAggregateDetail, isTaskWaitToolCall, summarizeToolResult, toolLoadingTargets } from '../../runtime/shared/tool-surface.mjs';
import { aggregateBucketForCategory, aggregateRawResult, aggregateToolMembers, failureDetailText, toolCallOutcome } from './tool-result-status.mjs';
import {
  isInternalTranscriptDisplayText,
  isTranscriptHiddenControlToolName,
  isTranscriptHiddenToolItem,
  isTranscriptCancelledStatusText,
} from '../../runtime/shared/tool-execution-contract.mjs';
import { toolResultTerminalStatus } from '../../runtime/shared/tool-status.mjs';

export function restoredTranscriptMetadata(message) {
  const value = message?.meta?.transcript;
  if (!value || typeof value !== 'object') return {};
  const completionValue = value.completion && typeof value.completion === 'object'
    ? value.completion
    : null;
  const completionStatus = typeof completionValue?.status === 'string'
    ? completionValue.status
    : '';
  const completionElapsedMs = Number(completionValue?.elapsedMs);
  const completion = completionValue && completionStatus && Number.isFinite(completionElapsedMs)
    ? {
        status: completionStatus,
        elapsedMs: Math.max(0, completionElapsedMs),
        ...(typeof completionValue.verb === 'string' && completionValue.verb
          ? { verb: completionValue.verb }
          : {}),
      }
    : null;
  return {
    ...(Number.isFinite(Number(value.at)) ? { at: Number(value.at) } : {}),
    ...(typeof value.model === 'string' && value.model ? { model: value.model } : {}),
    ...(typeof value.provider === 'string' && value.provider ? { provider: value.provider } : {}),
    ...(typeof value.agent === 'string' && value.agent ? { agent: value.agent } : {}),
    ...(typeof value.sender === 'string' && value.sender ? { sender: value.sender } : {}),
    ...(completion ? { completion } : {}),
  };
}

export function restoredAssistantTranscriptItems(message, nextId) {
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
function restoredToolCallItems(message, nextId, pendingByCallId) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls
    : Array.isArray(message?.toolCalls) ? message.toolCalls : [];
  const at = Number(message?.meta?.transcript?.at);
  const items = [];
  for (const call of calls) {
    const name = String(call?.function?.name || call?.name || 'tool').trim() || 'tool';
    if (isTranscriptHiddenControlToolName(name)) continue;
    let args = call?.function?.arguments ?? call?.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { /* keep the raw string args */ }
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

function attachRestoredToolResult(message, pendingByCallId) {
  const callId = typeof message?.tool_call_id === 'string' && message.tool_call_id
    ? message.tool_call_id
    : typeof message?.toolCallId === 'string' ? message.toolCallId : '';
  const target = callId ? pendingByCallId.get(callId) : null;
  if (!target) return;
  pendingByCallId.delete(callId);
  const text = (typeof message?.content === 'string' ? message.content : toolResultText(message?.content)) || '';
  target.result = text;
  if (Object.hasOwn(message || {}, 'uiDiff')) {
    target.uiDiff = typeof message.uiDiff === 'string' ? message.uiDiff : '';
  }
  // Cancel/crash control bodies are not red failures — show Cancelled tone.
  if (toolResultTerminalStatus(text) === 'cancelled') {
    target.isError = false;
    target.errorCount = 0;
    target.callErrorCount = 0;
    target.exitErrorCount = 0;
  } else {
    const { isCallError, isExitError } = toolCallOutcome({ ...message, toolName: target.name }, text);
    target.isError = isCallError;
    target.errorCount = isCallError ? 1 : 0;
    target.callErrorCount = isCallError ? 1 : 0;
    target.exitErrorCount = isExitError ? 1 : 0;
  }
}

// Collapse a consecutive run (≥2) of restored per-call tool items into ONE
// done aggregate item shaped exactly like the live turn's '__aggregate__'
// card (turn.mjs completeAggregateVisual): merged category header counts,
// per-call result summaries as the collapsed detail, raw bodies preserved
// for expansion, tool failures and command failures surfaced separately.
function buildRestoredAggregateItem(members) {
  const categories = new Map();
  const categoryOrder = [];
  const calls = [];
  for (const { item, category } of members) {
    for (const entry of aggregateToolCategoryEntries(item.name, item.args, category)) {
      if (!categories.has(entry.key)) categoryOrder.push(entry.key);
      const prev = categories.get(entry.key);
      categories.set(entry.key, { ...entry, count: Number(prev?.count || 0) + Number(entry.count || 1) });
    }
    const resultText = String(item.result ?? '');
    // Mirror live outcome semantics, including explicit no-match/no-change
    // markers and offloaded shell previews.
    const { exitCode, isExitError, isCallError } = toolCallOutcome({
      isError: item.isError === true,
      toolName: item.name,
    }, resultText);
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
      resolved: true,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      summary: !isCallError && resultText.trim()
        ? summarizeToolResult(item.name, item.args, resultText, false)
        : null,
    });
  }
  const errors = calls.filter((r) => r.isError).length;
  const callErrors = calls.filter((r) => r.isCallError).length;
  const exitErrors = calls.filter((r) => r.isExitError).length;
  const succeeded = Math.max(0, calls.length - errors - exitErrors);
  const displayDetail = errors > 0 || exitErrors > 0
    ? failureDetailText({ succeeded, realErrors: callErrors, exitErrors, exitCode: calls.find((r) => r.isExitError)?.exitCode })
    : formatAggregateDetail(calls.filter((r) => r.summary).map((r) => r.summary));
  const rawResult = aggregateRawResult(calls);
  const latestUiDiff = [...members].reverse()
    .map(({ item }) => item)
    .find((item) => Object.hasOwn(item || {}, 'uiDiff'));
  const first = members[0].item;
  const last = members[members.length - 1].item;
  const loadingTargetGroups = calls.map((call) => toolLoadingTargets(call.name, call.args));
  const loadingTargets = loadingTargetGroups.length > 0
    && loadingTargetGroups.every((targets) => targets.length > 0)
    ? [...new Set(loadingTargetGroups.flat())]
    : [];
  return {
    kind: 'tool',
    id: first.id,
    name: '__aggregate__',
    args: {
      categoryOrder,
      ...(loadingTargets.length > 0 ? { loadingTargets } : {}),
    },
    aggregate: true,
    categories: Object.fromEntries(categories),
    doneCategories: aggregateDoneCategories(calls),
    count: calls.length,
    completedCount: calls.length,
    isError: errors > 0,
    errorCount: errors,
    callErrorCount: callErrors,
    exitErrorCount: exitErrors,
    result: displayDetail,
    text: displayDetail,
    rawResult: rawResult || null,
    toolMembers: aggregateToolMembers(calls),
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
    if (!mergeable) { flushRun(); merged.push(item); continue; }
    const category = classifyToolCategory(item.name, item.args);
    const bucket = category === 'Agent' ? '' : aggregateBucketForCategory(category);
    if (!bucket) { flushRun(); merged.push(item); continue; }
    if (run && run.bucket === bucket) { run.members.push({ item, category }); continue; }
    flushRun();
    run = { bucket, members: [{ item, category }] };
  }
  flushRun();
  return merged;
}

function restoredMessageItemUpperBound(message) {
  if (message?.role === 'user') return 1;
  if (message?.role !== 'assistant') return 0;
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls
    : Array.isArray(message?.toolCalls) ? message.toolCalls : [];
  const content = message?.content;
  const hasContent = typeof content === 'string'
    ? content.length > 0
    : Array.isArray(content) && content.length > 0;
  const hasCompletion = Boolean(message?.meta?.transcript?.completion);
  return Number(hasContent) + Number(hasCompletion) + calls.length;
}

function restoredUserTranscriptItems(message, nextId) {
  // Injected model-context payloads are model-visible but never user-authored:
  // skill bodies (meta:'skill'), hook/system reminders, and tag-wrapped context
  // blocks must not restore as user bubbles in any client.
  if (message?.meta === 'skill' || message?.meta === 'hook') return [];
  const text = (typeof message?.content === 'string'
    ? message.content
    : toolResultText(message?.content)).trim();
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
    const completionLabel = completion.label || 'notification';
    const completionAt = Number(message?.meta?.transcript?.at);
    return [{
      kind: 'tool',
      id: nextId(),
      name: completion.name || 'agent',
      args: completion.args || {
        type: completionLabel,
        task_id: completion.taskId || undefined,
        description: completion.summary || 'agent notification',
      },
      result: completion.result,
      rawResult: completion.rawResult ?? text,
      isError: completion.isError ?? /^(failed|error|timeout|killed|cancelled)$/i.test(completionLabel),
      expanded: false,
      count: 1,
      completedCount: 1,
      ...(Number.isFinite(completionAt)
        ? { at: completionAt, startedAt: completionAt, completedAt: completionAt }
        : {}),
    }];
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
  const label = synthetic.label || 'notification';
  const syntheticAt = Number(message?.meta?.transcript?.at);
  return [{
    kind: 'tool',
    id: nextId(),
    name: synthetic.name || 'agent',
    args: synthetic.args || {
      type: label,
      task_id: synthetic.taskId || undefined,
      description: synthetic.summary || 'agent notification',
    },
    result: synthetic.result,
    rawResult: synthetic.rawResult ?? text,
    isError: synthetic.isError ?? /^(failed|error|killed|cancelled)$/i.test(label),
    expanded: false,
    count: 1,
    completedCount: 1,
    ...(Number.isFinite(syntheticAt)
      ? { at: syntheticAt, startedAt: syntheticAt, completedAt: syntheticAt }
      : {}),
  }];
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
  }
  return mergeRestoredToolItems(items);
}

export function restoreTranscriptItems(messages, {
  sessionId = 'session',
  itemLimit = Number.POSITIVE_INFINITY,
} = {}) {
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
  const usedSource = String(contextStatus.usedSource || '').toLowerCase();
  const estimatedTokens = Math.max(0, Number(
    contextStatus.currentEstimatedTokens
    ?? contextStatus.usedTokens
    ?? 0,
  ));
  const lastApiRequestTokens = Math.max(0, Number(
    contextStatus.lastApiRequestTokens
    ?? contextStatus.usage?.lastContextTokens
    ?? 0,
  ));
  return {
    stats: {
      currentContextTokens: usedSource === 'last_api_request'
        ? lastApiRequestTokens
        : 0,
      currentEstimatedContextTokens: estimatedTokens,
      // Carry the runtime's own provenance instead of flattening every
      // projection to `estimated`: a cold pane must be able to tell a measured
      // prompt from a local guess.
      currentContextSource: usedSource || (estimatedTokens > 0 ? 'estimated' : null),
      currentContextUpdatedAt: Date.now(),
    },
    contextWindow: Math.max(
      0,
      Number(session?.contextWindow || contextStatus.effectiveContextWindow || 0),
    ),
    rawContextWindow: Math.max(
      0,
      Number(session?.rawContextWindow || contextStatus.rawContextWindow || 0),
    ),
    effectiveContextWindowPercent: Number(
      session?.effectiveContextWindowPercent
      ?? contextStatus.effectiveContextWindowPercent
      ?? 0,
    ),
    displayContextWindow: Math.max(0, Number(contextStatus.contextWindow || 0)),
    compactBoundaryTokens: Math.max(
      0,
      Number(contextStatus.compaction?.boundaryTokens || 0),
    ),
    autoCompactTokenLimit: Math.max(
      0,
      Number(contextStatus.compaction?.triggerTokens || 0),
    ),
  };
}

export function createSessionApiB(bag) {
  const {
    runtime, nextId, flags, lifecycle, listeners, getState, set, flushEmitImmediate, disposeEmit, replaceItems, pushNotice, removeNotice, setProgressHint, clearToastTimers, disposeTranscriptSpill, disposeGoalContinuation, routeState, syncContextStats, finishToolApproval, denyAllToolApprovals, restoreLeadSteeringFromDisk, resetStats, clearUiActivityBeforeContextSync, resetTuiForPendingSessionReset, snapshotTuiBeforeSessionReset, restoreTuiAfterFailedSessionReset, commitTuiSessionReset, resetStatsAndSyncContext,
  } = bag;
  const oauthFlows = createSessionOAuthFlowRegistry();
  /**
   * Session inheritance as ONE addressable session action. THIS session is the
   * already-created heir, so only the carry step runs here — the desktop
   * creates and routes the new session first, then calls this by name. The
   * daemon resolves actions on THIS surface, so `inheritFrom` has to live here
   * and not only on the runtime beneath it.
   */
  const inheritFrom = async (sourceSessionId) => {
    const result = await runtime.inheritFrom(sourceSessionId);
    const sessionId = String(result?.sessionId || runtime.sessionId || getState().sessionId || '');
    // Only model messages travel with the conversation. Rebuild the visible
    // transcript from them right here so the heir opens showing the carried
    // conversation; without it the view stays blank until a cold reopen
    // resumes the session from disk and restores the same items.
    const carried = runtime.readModelMessages?.(0)?.messages;
    const items = restoreTranscriptItems(Array.isArray(carried) ? carried : [], { sessionId });
    resetStatsAndSyncContext();
    set({
      sessionId,
      items: replaceItems(items),
      toasts: [],
      queued: [],
      thinking: null,
      spinner: null,
      lastTurn: null,
      ...routeState(),
      stats: { ...getState().stats },
    });
    flushEmitImmediate();
    return result;
  };
  return {
    resolveToolApproval: (id, decision = {}) => {
      const approved = decision === true || decision?.approved === true;
      return finishToolApproval(id, approved, decision?.reason || (approved ? 'approved by user' : 'denied by user'));
    },
    listPresets: () => {
      return runtime.listPresets();
    },
    listProviderModels: (options = {}) => {
      return runtime.listProviderModels(options);
    },
    prefetchSession: (id) => {
      return runtime.prefetchSession?.(id) === true;
    },
    getWebSearchRoute: () => {
      return runtime.getWebSearchRoute?.() || runtime.webSearchRoute || null;
    },
    listWebSearchModels: (options = {}) => {
      return runtime.listWebSearchModels?.(options) || [];
    },
    setWebSearchRoute: async (opts) => {
      if (getState().commandBusy) return null;
      const beforeRouteState = routeState();
      const optimisticWebSearchRoute = opts?.provider && opts?.model
        ? {
            provider: String(opts.provider).trim(),
            model: String(opts.model).trim(),
            ...(opts.effort ? { effort: opts.effort } : {}),
            ...(opts.fast === true ? { fast: true } : {}),
            ...(opts.modelParameters ? { modelParameters: { ...opts.modelParameters } } : {}),
            ...(opts.toolType ? { toolType: opts.toolType } : {}),
          }
        : null;
      set({ commandBusy: true });
      try {
        if (optimisticWebSearchRoute?.provider && optimisticWebSearchRoute.model) {
          set({ webSearchRoute: optimisticWebSearchRoute });
        }
        const result = await runtime.setWebSearchRoute?.(opts);
        set({ ...routeState(), stats: { ...getState().stats } });
        return result;
      } catch (e) {
        set({ webSearchRoute: beforeRouteState.webSearchRoute || null });
        throw e;
      } finally {
        set({ commandBusy: false });
      }
    },
    listAgents: () => {
      return runtime.listAgents?.() || [];
    },
    listWorkflows: () => {
      return runtime.listWorkflows?.() || [];
    },
    // Workflow pack editing (desktop Workflows page): direct passthroughs —
    // the runtime owns validation, user-pack persistence, and delete guards.
    getWorkflowPack: (workflowId) => runtime.getWorkflowPack?.(workflowId) ?? null,
    saveWorkflowPack: async (payload) => runtime.saveWorkflowPack?.(payload) ?? null,
    createWorkflow: async (payload) => runtime.createWorkflow?.(payload) ?? null,
    deleteWorkflow: async (workflowId) => runtime.deleteWorkflow?.(workflowId) ?? null,
    getAgentDefinition: (agentId) => runtime.getAgentDefinition?.(agentId) ?? null,
    saveAgentDefinition: async (payload) => runtime.saveAgentDefinition?.(payload) ?? null,
    deleteAgentDefinition: async (agentId) => runtime.deleteAgentDefinition?.(agentId) ?? null,
    getOutputStyle: () => {
      return runtime.getOutputStyle?.() || runtime.listOutputStyles?.() || null;
    },
    listOutputStyles: () => {
      return runtime.listOutputStyles?.() || runtime.getOutputStyle?.() || { styles: [], current: null, configured: 'default' };
    },
    setOutputStyle: async (styleId) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.setOutputStyle?.(styleId);
        resetStats();
        set({ ...routeState(), stats: { ...getState().stats } });
        // Defer the context recompute (transcript scan) off this tick so
        // the style change repaints immediately; stats settle right after.
        setTimeout(() => {
          syncContextStats({ allowEstimated: true });
          set({ stats: { ...getState().stats } });
        }, 0);
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    setWorkflow: async (workflowId) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.setWorkflow?.(workflowId);
        set({ ...routeState(), stats: { ...getState().stats } });
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    getVoiceStatus: () => getVoiceStatus(),
    // Desktop push-to-talk dictation: accept a recorded audio payload
    // (base64), stage it as a temp file, and run it through the SAME managed
    // whisper.cpp pipeline the channels use (ffmpeg convert -> whisper server,
    // standard multilingual Q8 model). Returns the transcript
    // text or throws a user-actionable error (e.g. runtime not installed).
    transcribeAudio: async ({ data, mimeType = 'audio/webm' } = {}) => {
      const base64 = String(data || '');
      if (!base64) throw new Error('transcribeAudio: audio payload is required');
      if (base64.length > 40_000_000) throw new Error('transcribeAudio: recording too large');
      const [{ createVoiceTranscription }, { resolvePluginData }, { readSection }, os, path, fsp, crypto] = await Promise.all([
        import('../../runtime/channels/lib/voice-transcription.mjs'),
        import('../../runtime/shared/plugin-paths.mjs'),
        import('../../runtime/shared/config.mjs'),
        import('node:os'),
        import('node:path'),
        import('node:fs/promises'),
        import('node:crypto'),
      ]);
      const extension = /ogg/i.test(mimeType) ? 'ogg' : /wav/i.test(mimeType) ? 'wav' : /mp4|m4a/i.test(mimeType) ? 'm4a' : 'webm';
      const audioPath = path.join(os.tmpdir(), `mixdog-dictation-${process.pid}-${Date.now()}.${extension}`);
      await fsp.writeFile(audioPath, Buffer.from(base64, 'base64'));
      try {
        const { transcribeVoice } = createVoiceTranscription({
          getConfig: () => ({ voice: readSection('voice') || {} }),
          dataDir: resolvePluginData(),
        });
        const text = await transcribeVoice(audioPath, {
          attachmentId: `dictation-${crypto.randomUUID()}`,
        });
        return typeof text === 'string' ? text : '';
      } finally {
        fsp.rm(audioPath, { force: true }).catch(() => undefined);
      }
    },
    // Desktop composer image attach: run the SAME optional-sharp resize
    // pipeline the TUI paste path uses. The current provider selects the
    // Anthropic 2000px/5MB profile or OpenAI 2048px/1536-patch profile.
    resizeImage: async ({ data, mimeType = 'image/png', filename = '' } = {}) => {
      const base64 = String(data || '');
      if (!base64) throw new Error('resizeImage: image payload is required');
      if (base64.length > 40_000_000) throw new Error('resizeImage: image too large');
      const { imageAttachmentFromBuffer } = await import('../paste-attachments.mjs');
      const attachment = await imageAttachmentFromBuffer(
        Buffer.from(base64, 'base64'),
        String(mimeType || 'image/png'),
        {
          filename: String(filename || 'Pasted image'),
          provider: routeState().provider || '',
        },
      );
      return {
        data: attachment.content,
        mimeType: attachment.mediaType,
        metadataText: attachment.metadataText || '',
      };
    },
    toggleVoice: async (enabled) => {
      const result = await toggleVoice({
        pushNotice,
        setProgressHint,
        enabled: typeof enabled === 'boolean' ? enabled : undefined,
      });
      return {
        ...(await getVoiceStatus()),
        result: typeof result === 'boolean'
          ? { ok: true, enabled: result }
          : (result && typeof result === 'object' ? result : { ok: false }),
      };
    },
    // Theme is a TUI-local concern (no runtime round-trip). listThemes returns
    // picker metadata; getTheme reports the active id; setTheme applies the
    // palette in-place + persists ui.theme and bumps a themeEpoch so the React
    // tree re-renders (markdown/status/spinner colorizers re-resolve).
    listThemes: () => listThemes(),
    getTheme: () => getThemeSetting(),
    setTheme: (id, options = {}) => {
      const applied = setThemeSetting(id, options);
      set({ themeEpoch: (getState().themeEpoch || 0) + 1 });
      return applied;
    },
    setAgentRoute: async (agentId, opts) => {
      return await runtime.setAgentRoute?.(agentId, opts);
    },
    listProviders: () => {
      return runtime.listProviders();
    },
    getProviderSetup: () => {
      return runtime.getProviderSetup();
    },
    getUsageDashboard: async (options = {}) => {
      return await runtime.getUsageDashboard?.(options);
    },
    consumeCodexRateLimitResetCredit: async (options = {}) => {
      // Desktop capability parity: without this delegation the session runtime surface
      // rejects the sidebar's reset-credit invoke as unsupported even though
      // the session runtime implements it.
      if (typeof runtime.consumeCodexRateLimitResetCredit !== 'function') {
        throw new Error('Codex reset is unavailable');
      }
      return await runtime.consumeCodexRateLimitResetCredit(options);
    },
    getTurnReviewDiff: async (options = {}) => {
      return (await runtime.getTurnReviewDiff?.(options)) ?? { supported: false, files: [], patch: '' };
    },
    getSessionReviewDiff: async () => {
      return (await runtime.getSessionReviewDiff?.()) ?? { supported: false, files: [], patch: '' };
    },
    revertTurnReview: async (checkpointId) => {
      if (typeof runtime.revertTurnReview !== 'function') {
        throw new Error('Turn review revert is unavailable');
      }
      return await runtime.revertTurnReview(checkpointId);
    },
    revertTurnReviewFile: async (file, checkpointId) => {
      if (typeof runtime.revertTurnReviewFile !== 'function') {
        throw new Error('Turn review revert is unavailable');
      }
      return await runtime.revertTurnReviewFile(file, checkpointId);
    },
    getOnboardingStatus: () => {
      return runtime.getOnboardingStatus?.() || { completed: true, workflowRoutes: {} };
    },
    skipOnboarding: () => {
      // Completed-marking only; no route/agent/provider writes.
      return runtime.skipOnboarding?.() || null;
    },
    completeOnboarding: async (payload = {}) => {
      if (getState().commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.completeOnboarding?.(payload);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...getState().stats } });
        pushNotice('first-run setup saved', 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    loginOAuthProvider: async (provider) => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      try {
        const result = await runtime.loginOAuthProvider(provider);
        pushNotice(`provider oauth ok: ${result.provider}`, 'info');
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    beginOAuthProviderLogin: async (provider) => {
      if (getState().commandBusy) throw new Error('command busy');
      set({ commandBusy: true });
      try {
        const result = oauthFlows.register(await runtime.beginOAuthProviderLogin(provider));
        pushNotice(`provider oauth started: ${result.provider}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    getOAuthProviderLoginStatus: (flowId) => oauthFlows.status(flowId),
    completeOAuthProviderLogin: async (flowId, code) => oauthFlows.complete(flowId, code),
    cancelOAuthProviderLogin: async (flowId) => oauthFlows.cancel(flowId),
    saveProviderApiKey: (provider, secret) => {
      const result = runtime.saveProviderApiKey(provider, secret);
      pushNotice(`provider api key saved: ${result.provider}`, 'info');
      return true;
    },
    saveOpenCodeGoUsageAuth: (opts) => {
      // User-facing notices never expose the raw workspace-derived `wrk_…`
      // identifier (Project is the product vocabulary; "workspace" is not).
      runtime.saveOpenCodeGoUsageAuth(opts);
      pushNotice('OpenCode Go usage auth saved', 'info');
      return true;
    },
    loginOpenCodeGoUsage: async () => {
      if (getState().commandBusy) throw new Error('command busy');
      set({ commandBusy: true });
      try {
        return await runtime.loginOpenCodeGoUsage();
      } finally {
        set({ commandBusy: false });
      }
    },
    saveOpenAIUsageSessionKey: (secret) => {
      runtime.saveOpenAIUsageSessionKey(secret);
      pushNotice('OpenAI usage auth saved', 'info');
      return true;
    },
    setLocalProvider: (provider, opts) => {
      const result = runtime.setLocalProvider(provider, opts);
      pushNotice(`local provider ${result.enabled ? 'enabled' : 'disabled'}: ${result.provider}`, 'info');
      return true;
    },
    authenticateProvider: async (provider, secret) => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      try {
        const result = await runtime.authenticateProvider(provider, secret);
        pushNotice(`provider auth ok: ${result.provider} (${result.type})`, 'info');
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    forgetProviderAuth: (provider) => {
      const result = runtime.forgetProviderAuth(provider);
      pushNotice(`provider auth forgotten: ${result.provider}`, 'info');
      return true;
    },
    getChannelSetup: () => {
      return runtime.getChannelSetup();
    },
    getChannelWorkerStatus: () => runtime.getChannelWorkerStatus?.(),
    // Media studio (image/video generation). Reads stay quiet; only the
    // generation start posts a notice so the TUI shows background work.
    listMediaLanes: () => runtime.listMediaLanes?.(),
    listMediaAssets: (options) => runtime.listMediaAssets?.(options),
    readMediaAsset: (id, options) => runtime.readMediaAsset?.(id, options),
    cacheMediaThumbnail: (id, input) => runtime.cacheMediaThumbnail?.(id, input),
    resolveMediaFile: (id, options) => runtime.resolveMediaFile?.(id, options),
    getMediaJob: (id) => runtime.getMediaJob?.(id),
    listMediaJobs: () => runtime.listMediaJobs?.(),
    // No notice on start: the Studio surfaces progress on its own pending tile,
    // and a toast for a user-initiated generation is pure noise.
    startMediaJob: (input) => runtime.startMediaJob(input),
    cancelMediaJob: (id) => runtime.cancelMediaJob?.(id),
    deleteMediaAsset: (id) => runtime.deleteMediaAsset?.(id),
    openMediaAsset: (id) => runtime.openMediaAsset?.(id),
    openMediaFolder: (id) => runtime.openMediaFolder?.(id),
    setWebhookConfig: async (patch) => {
      const result = await runtime.setWebhookConfig(patch);
      pushNotice('webhook config updated', 'info');
      return result;
    },
    saveSchedule: async (entry) => {
      const result = await runtime.saveSchedule(entry);
      pushNotice(`schedule saved: ${result.name}`, 'info');
      return result;
    },
    deleteSchedule: async (name) => {
      const result = await runtime.deleteSchedule(name);
      pushNotice(`schedule deleted: ${name}`, 'info');
      return result;
    },
    setScheduleEnabled: async (name, enabled) => {
      const result = await runtime.setScheduleEnabled(name, enabled);
      pushNotice(`schedule ${enabled ? 'enabled' : 'disabled'}: ${name}`, 'info');
      return result;
    },
    runScheduleNow: async (name) => {
      const result = await runtime.runScheduleNow(name);
      pushNotice(`schedule ran: ${name}`, 'info');
      return result;
    },
    saveWebhook: async (entry) => {
      const result = await runtime.saveWebhook(entry);
      pushNotice(`webhook saved: ${result.name}`, 'info');
      return result;
    },
    deleteWebhook: async (name) => {
      const result = await runtime.deleteWebhook(name);
      pushNotice(`webhook deleted: ${name}`, 'info');
      return result;
    },
    setWebhookEnabled: async (name, enabled) => {
      const result = await runtime.setWebhookEnabled(name, enabled);
      pushNotice(`webhook ${enabled ? 'enabled' : 'disabled'}: ${name}`, 'info');
      return result;
    },
    setRoute: async (opts) => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      try {
        const routeOpts = opts && typeof opts === 'object' ? opts : {};
        // Default: apply to the NEXT session only. Only an explicit
        // `applyToCurrentSession: true` rewrites the live session in place.
        const applyToCurrentSession = routeOpts.applyToCurrentSession === true;
        const { applyToCurrentSession: _drop, ...nextRoute } = routeOpts;
        const resolvedRoute = await runtime.setRoute(nextRoute, { applyToCurrentSession });
        if (applyToCurrentSession) syncContextStats({ allowEstimated: true });
        set({ ...routeState(), stats: { ...getState().stats } });
        return resolvedRoute;
      } finally {
        set({ commandBusy: false });
      }
    },
    pushNotice,
    removeNotice,
    setProgressHint,
    clear: async () => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      clearToastTimers();
      resetAllStreamingMarkdownStablePrefixes();
      const rollbackSnapshot = snapshotTuiBeforeSessionReset();
      resetTuiForPendingSessionReset();
      set({
        items: getState().items,
        toasts: getState().toasts,
        queued: getState().queued,
        thinking: null,
        spinner: null,
        lastTurn: null,
        sessionId: null,
        stats: { ...getState().stats },
      });
      try {
        await runtime.clear({ recoverAgent: true });
        clearUiActivityBeforeContextSync();
        flags.pendingSessionReset = false;
        resetStatsAndSyncContext();
        set({ items: replaceItems([]), toasts: [], queued: [], thinking: null, spinner: null, lastTurn: null, ...routeState(), stats: { ...getState().stats } });
        commitTuiSessionReset(rollbackSnapshot);
        flags.lastUserActivityAt = Date.now();
        return true;
      } catch (error) {
        restoreTuiAfterFailedSessionReset(rollbackSnapshot);
        throw error;
      } finally {
        flags.pendingSessionReset = false;
        set({ commandBusy: false });
      }
    },
    listSessions: (options) => {
      return runtime.listSessions(options);
    },
    renameSessionTitle: (id, title) => {
      return runtime.renameSessionTitle?.(id, title) ?? false;
    },
    // Desktop sidebar watcher hook: the daemon watches this directory so
    // heartbeat sidecar create/delete pushes instant working/dot updates.
    // Without it the watcher silently no-ops and the sidebar falls back to
    // the 60s safety poll (user: spinner kept spinning after the turn ended).
    sessionStoreDir: () => {
      try { return runtime.sessionStoreDir?.() || null; } catch { return null; }
    },
    deleteSession: async (id) => {
      if (getState().commandBusy) return false;
      const deletingCurrent = String(runtime.session?.id || getState().sessionId || '') === String(id || '');
      set({ commandBusy: true });
      clearToastTimers();
      resetAllStreamingMarkdownStablePrefixes();
      const rollbackSnapshot = deletingCurrent ? snapshotTuiBeforeSessionReset() : null;
      if (deletingCurrent) resetTuiForPendingSessionReset();
      try {
        if (await runtime.deleteSession(id) !== true) {
          if (rollbackSnapshot) restoreTuiAfterFailedSessionReset(rollbackSnapshot);
          return false;
        }
        if (deletingCurrent) {
          clearUiActivityBeforeContextSync();
          flags.pendingSessionReset = false;
          resetStatsAndSyncContext();
          set({
            items: replaceItems([]),
            toasts: [],
            queued: [],
            thinking: null,
            spinner: null,
            lastTurn: null,
            sessionId: null,
            cwd: runtime.cwd,
            ...routeState(),
            stats: { ...getState().stats },
          });
          commitTuiSessionReset(rollbackSnapshot);
        }
        return true;
      } catch (error) {
        if (rollbackSnapshot) restoreTuiAfterFailedSessionReset(rollbackSnapshot);
        throw error;
      } finally {
        flags.pendingSessionReset = false;
        set({ commandBusy: false });
      }
    },
    /**
     * /inherit — open a NEW session on the current route and carry this
     * conversation into it. The source session file is left as it is, so the
     * two transcripts share a prefix and then diverge.
     */
    inheritFrom,
    inheritSession: async () => {
      if (getState().commandBusy) return false;
      const sourceId = getState().sessionId || null;
      if (!sourceId) return false;
      set({ commandBusy: true });
      try {
        await runtime.newSession();
        return await inheritFrom(sourceId);
      } finally {
        set({ commandBusy: false });
      }
    },
    switchContext: async (options) => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      clearToastTimers();
      resetAllStreamingMarkdownStablePrefixes();
      const rollbackSnapshot = snapshotTuiBeforeSessionReset();
      resetTuiForPendingSessionReset();
      try {
        await runtime.switchContext(options);
        clearUiActivityBeforeContextSync();
        flags.pendingSessionReset = false;
        resetStatsAndSyncContext();
        set({
          items: replaceItems([]),
          toasts: [],
          queued: [],
          thinking: null,
          spinner: null,
          lastTurn: null,
          sessionId: null,
          cwd: runtime.cwd,
          ...routeState(),
          stats: { ...getState().stats },
        });
        commitTuiSessionReset(rollbackSnapshot);
        return true;
      } catch (error) {
        restoreTuiAfterFailedSessionReset(rollbackSnapshot);
        throw error;
      } finally {
        flags.pendingSessionReset = false;
        set({ commandBusy: false });
      }
    },
    newSession: async () => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      clearToastTimers();
      resetAllStreamingMarkdownStablePrefixes();
      const rollbackSnapshot = snapshotTuiBeforeSessionReset();
      resetTuiForPendingSessionReset();
      set({
        items: getState().items,
        toasts: getState().toasts,
        queued: getState().queued,
        thinking: null,
        spinner: null,
        lastTurn: null,
        sessionId: null,
        stats: { ...getState().stats },
      });
      // Publish the blank session boundary before runtime session creation can
      // block on disk/provider work. Otherwise the old transcript remains the
      // last committed React snapshot until the async command completes.
      flushEmitImmediate();
      try {
        await runtime.newSession();
        clearUiActivityBeforeContextSync();
        flags.pendingSessionReset = false;
        resetStatsAndSyncContext();
        set({ items: replaceItems([]), toasts: [], queued: [], thinking: null, spinner: null, lastTurn: null, ...routeState(), stats: { ...getState().stats } });
        commitTuiSessionReset(rollbackSnapshot);
        return true;
      } catch (error) {
        restoreTuiAfterFailedSessionReset(rollbackSnapshot);
        throw error;
      } finally {
        flags.pendingSessionReset = false;
        set({ commandBusy: false });
        // Match resume's atomic handoff: callers (and the forced terminal
        // repaint triggered by /new) must observe the completed empty session.
        flushEmitImmediate();
      }
    },
    resume: async (id, options = {}) => {
      if (getState().commandBusy) return false;
      // quiet: viewer-follow refreshes (session runtime share tick) re-resume on every
      // owner turn — they must not flash the "Resuming conversation" status.
      set({
        commandBusy: true,
        ...(options.quiet === true
          ? {}
          : { commandStatus: { active: true, verb: 'Resuming conversation', startedAt: Date.now(), mode: 'resuming' } }),
      });
      clearToastTimers();
      try {
        const r = await runtime.resume(id);
        if (!r) return false;
        resetStatsAndSyncContext();
        const requestedLimit = Number(options.transcriptItemLimit);
        if (Number.isFinite(requestedLimit) && requestedLimit > 0) {
          flags.resumeTranscriptItemLimit = Math.max(1, Math.floor(requestedLimit));
        }
        const itemLimit = Number(flags.resumeTranscriptItemLimit);
        const items = restoreTranscriptItems(r.messages, {
          sessionId: String(r.id || id),
          itemLimit: Number.isFinite(itemLimit) && itemLimit > 0
            ? itemLimit
            : Number.POSITIVE_INFINITY,
        });
        set({
          items: replaceItems(items),
          toasts: [],
          queued: [],
          thinking: null,
          spinner: null,
          lastTurn: null,
          ...routeState(),
          stats: { ...getState().stats },
        });
        // Reconcile the live-share legs NOW (viewer pipe attach / owner pipe
        // start). The 3s share tick otherwise leaves a live-owned session on
        // the stale disk snapshot and then full-swaps it seconds after entry —
        // the visible transcript lurch. Connecting here makes the owner's
        // full frame land at the resume boundary, so entry paints settled.
        bag.ensureLiveShare?.();
        // A shard/process restart recreates the runtime before resuming its
        // durable session. Restore accepted steering while commandBusy is
        // still held so the central release hook drains it exactly once after
        // the transcript/session boundary is ready, rather than stranding the
        // queued prompt behind a visible Cancelled recovery marker.
        await restoreLeadSteeringFromDisk();
        return true;
      } finally {
        set({ commandBusy: false, commandStatus: null });
        // Desktop resume returns a snapshot immediately after this promise.
        // Publish the completed route/transcript boundary now so callers never
        // observe the previous frame's session id and title.
        flushEmitImmediate();
      }
    },

    deliverToolCompletion: (sessionId, text, meta = {}) =>
      runtime.deliverToolCompletion?.(sessionId, text, meta) === true,

    closeCanonicalSession: (reason = 'canonical-session-close') =>
      runtime.closeCanonicalSession?.(reason) === true,

    dispose: async (reason = 'cli-react-exit', options = {}) => {
      if (flags.disposed) return;
      disposeEmit?.();
      flags.disposed = true;
      // Release the interactive-presence beacon so a cross-open after this
      // surface exits takes normal ownership instead of viewer-attaching to a
      // dead owner (crash paths fall back to the 2min staleness window).
      try { runtime.clearSessionPresence?.(); } catch { /* best-effort */ }
      clearToastTimers();
      disposeTranscriptSpill?.();
      disposeGoalContinuation?.();
      try { clearInterval(lifecycle.runtimePulseTimer); } catch {}
      try { lifecycle.unsubscribeRuntimeNotifications?.(); } catch {}
      lifecycle.unsubscribeRuntimeNotifications = null;
      try { lifecycle.unsubscribeAgentStatus?.(); } catch {}
      lifecycle.unsubscribeAgentStatus = null;
      try { lifecycle.unsubscribeRemoteState?.(); } catch {}
      lifecycle.unsubscribeRemoteState = null;
      denyAllToolApprovals('runtime closing');
      oauthFlows.cancelAll();
      await flushTuiSteeringPersist();
      await runtime.close(reason, options);
      listeners.clear();
    },
  };
}
