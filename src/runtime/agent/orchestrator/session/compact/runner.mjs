// Rule-based Compact preserves conversation verbatim by default. A bounded
// cumulative handoff replaces only the conversation part when requested by
// its independent threshold policy.
import { createHash } from 'node:crypto';
import { estimateMessagesTokens, reconcileDedupStubs, sanitizeToolPairs } from '../context-utils.mjs';
import { HANDOFF_TIMEOUT_MAX_MS, SUMMARY_OUTPUT_TOKENS, compactDebugLog } from './constants.mjs';
import {
  contentText,
  redactRawSecretString,
  redactToolCallSecretsInMessages,
  safeEstimateMessagesTokens,
  textByteLength,
} from './text-utils.mjs';
import {
  callArguments,
  contextAckMessage,
  isCompactConversationRow,
  isProtectedContextAckMessage,
  isSummaryMessage,
  latestActualUserInstructionIndex,
  latestActualUserInstructionMessage,
  pendingTaskNotificationIndexes,
  splitProtectedContext,
} from './messages.mjs';
import { activeTurnContinuationMessage } from './continuation.mjs';
import { EXECUTION_RECOVERY_SOURCE, buildExecutionTail } from './execution-tail.mjs';
import { latestSkillBodies, skillMessageText } from '../../context/skill-state.mjs';
import { effectiveBudget } from './budget.mjs';
import { parseMcpToolName } from '../../../../shared/tool-primitives.mjs';
import { stripRuntimeUserContext, withRuntimeUserContext } from '../runtime-user-context.mjs';
import { carryMessageId, messageIdOf } from '../message-ids.mjs';
import { normalizeIngestRole, shouldExcludeIngestMessage } from '../../../../memory/lib/session-ingest.mjs';
import { codexWireSendOpts } from '../manager/session-id.mjs';
import { messageHasReferencableMedia, referenceMessageMedia } from '../../../../attachments/attachment-reference.mjs';
import { messageAttachmentTokens } from '../attachment-preflight.mjs';
import { rebaseCompactedEffortConfiguration } from '../../providers/effort-configuration.mjs';
import {
  COMPACTION_SYSTEM_PROMPT,
  enforceCompactSummarySchema,
  extractResponseText,
  fitCompleteCompactionPrompt,
  fitFreshContextSummaryMessage,
  fitGeneratedHandoffMessage,
} from './summary.mjs';

const COMPACTION_PROMPT_HEADROOM = 0.85;
const HANDOFF_SOURCE_CHUNK_CHARS = 1_600;

function combinedSignal(parent, timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return parent || undefined;
  const timeout = AbortSignal.timeout(Math.floor(ms));
  if (parent && typeof AbortSignal.any === 'function') return AbortSignal.any([parent, timeout]);
  return timeout;
}

function splitFreshSource(messages) {
  const sanitized = redactToolCallSecretsInMessages(reconcileDedupStubs(sanitizeToolPairs(messages)));
  const split = splitProtectedContext(sanitized);
  // A recovery reminder right after the system prompt reads as protected
  // prefix and would outlive every pass. It belongs to the conversation, where
  // buildExecutionTail replaces it with the newest compaction's reminder.
  const isRecovery = (message) => message?.meta?.source === EXECUTION_RECOVERY_SOURCE;
  const protectedPrefix = split.protectedPrefix.filter((message) => !isRecovery(message));
  const conversation = [...split.protectedPrefix.filter(isRecovery), ...split.conversation];
  let previousSummaryMessage = null;
  let previousAck = null;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (isSummaryMessage(conversation[index])) {
      previousSummaryMessage = conversation[index];
      if (isProtectedContextAckMessage(conversation[index + 1])) previousAck = conversation[index + 1];
      break;
    }
  }
  // Where the previous Compact's skill-use window opens: `live` index after
  // the history it kept (see SKILL_WINDOW_SOURCE). Without a marker the whole
  // transcript is the window.
  const isKept = (message) => !isSummaryMessage(message) && message?.meta?.source !== SKILL_WINDOW_SOURCE;
  const markerAt = conversation.findLastIndex((message) => message?.meta?.source === SKILL_WINDOW_SOURCE);
  const span = conversation[markerAt]?.meta?.span;
  const skillWindowStart =
    markerAt >= 0 && Number.isInteger(span) && span >= 0
      ? conversation.slice(0, markerAt).filter(isKept).length + span
      : 0;
  const latestUserIndex = latestActualUserInstructionIndex(conversation);
  return {
    protectedPrefix,
    previousSummary: previousSummaryMessage?.content || null,
    previousSummaryMessage,
    previousAck,
    skillWindowStart,
    // Budgeting, AI input and rule-only retention use this same projection.
    // Keep current-turn reminders; remove only proven runtime additions from
    // older requests. Unmarked legacy text remains part of the summary budget.
    // Older requests also carry their attachments by reference from here on:
    // the file stays on disk under the path the reference names, so the
    // compacted context keeps the pointer instead of the whole document.
    live: conversation
      .map((message, index) =>
        index === latestUserIndex ? message : referenceMessageMedia(stripRuntimeUserContext(message))
      )
      .filter(isKept),
    sanitized,
  };
}

// A cut at `end` that would split a surrogate pair (an emoji) moves back one
// unit: a lone surrogate serializes as an escape providers reject as invalid
// JSON, failing every Compact of the session.
function codePointEnd(text, end) {
  const code = text.charCodeAt(end - 1);
  return end < text.length && code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

function chunkConversationMessage(role, content, source = {}) {
  const text = String(content || '');
  const out = [];
  for (let offset = 0; offset < text.length; ) {
    const end = codePointEnd(text, offset + HANDOFF_SOURCE_CHUNK_CHARS);
    const next = {
      role,
      content: text.slice(offset, end),
    };
    offset = end;
    if (Object.hasOwn(source, 'ts')) next.ts = source.ts;
    if (Object.hasOwn(source, 'timestamp')) next.timestamp = source.timestamp;
    out.push(next);
  }
  return out;
}

// What the summary reads of runtime conversation rows and tool calls. The
// rows stay whole in rule-only Compact; the calls stay in the execution tail
// and archive.
const SUMMARY_RUNTIME_ROW_CHARS = 4_000;
const SUMMARY_TOOL_ARGS_CHARS = 200;
const SUMMARY_TOOL_OUTCOME_CHARS = 300;

function boundedSummaryText(text, limit) {
  if (text.length <= limit) return text;
  const end = codePointEnd(text, limit);
  return `${text.slice(0, end)}… [${text.length - end} more chars]`;
}

function toolCallSummaryLine(call, result) {
  const rawArgs = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
  const args = boundedSummaryText(rawArgs.replace(/\s+/g, ' '), SUMMARY_TOOL_ARGS_CHARS);
  // Arguments arrive redacted (splitFreshSource); the outcome is redacted
  // here, before any cut can split a secret from its key.
  const outcome = redactRawSecretString(contentText(result?.content)).trim();
  // An ask_user or handoff_user result is the user's own answer: never cut.
  const shown =
    call.name === 'ask_user' || call.name === 'handoff_user'
      ? outcome
      : boundedSummaryText(outcome.replace(/\s+/g, ' '), SUMMARY_TOOL_OUTCOME_CHARS);
  return `[tool call] ${call.name}(${args}) → ${result ? shown || '(empty result)' : '(no result)'}`;
}

// The conversation Compact measures and summarizes: user and assistant text
// (the memory-ingest projection) plus runtime conversation rows. `summary`
// bounds those rows and adds one line per tool call with its outcome.
function compactionConversationRows(messages, { summary = false } = {}) {
  const list = messages || [];
  const results = new Map(list.filter((m) => m?.role === 'tool').map((m) => [m.toolCallId, m]));
  const out = [];
  for (const message of list) {
    if (!message || typeof message !== 'object') continue;
    const content = contentText(message.content).trim();
    if (isCompactConversationRow(message)) {
      // A notification can carry a background command's output: the summary
      // reads it redacted like a tool outcome.
      const text = summary ? boundedSummaryText(redactRawSecretString(content), SUMMARY_RUNTIME_ROW_CHARS) : content;
      if (text) out.push(...chunkConversationMessage('user', text, message));
      continue;
    }
    const role = normalizeIngestRole(message.role);
    if (role && content && !shouldExcludeIngestMessage(message)) {
      out.push(...chunkConversationMessage(role, content, message));
    }
    if (summary && message.role === 'assistant' && message.toolCalls?.length) {
      const lines = message.toolCalls.map((call) => toolCallSummaryLine(call, results.get(call.id)));
      out.push(...chunkConversationMessage('assistant', lines.join('\n'), message));
    }
  }
  return out;
}

/** The conversation Compact measures against its summary threshold, or with
 *  `summary`, the input the summary is written from. */
export function conversationCompactionInput(messages, { summary = false } = {}) {
  const source = splitFreshSource(messages);
  // The turn input (the latest actual request and unanswered notifications)
  // is mandatory and must never be replaced by a summary. Skills and runtime
  // injections are excluded by the same conversation projection used by
  // summary generation.
  const turnInput = new Set([
    latestActualUserInstructionIndex(source.live),
    ...pendingTaskNotificationIndexes(source.live),
  ]);
  return [
    ...(source.previousSummaryMessage ? [source.previousSummaryMessage] : []),
    ...compactionConversationRows(
      source.live.filter((_, index) => !turnInput.has(index)),
      { summary }
    ),
  ];
}

// Summary generation is an independent request, not a continuation of the
// source conversation's effort-control history: the parent send's effort
// controls, provider state and streaming/tool callbacks are all dropped.
function summarySendOpts(opts) {
  const sendOpts = {
    ...(opts.sendOpts || {}),
    thinkingBudgetTokens: undefined,
    xaiReasoningEffort: undefined,
    reasoningEffort: undefined,
    effort: 'low',
    effortConfiguration: undefined,
    effortConfigurationEnabled: false,
    // Fast mode is opt-in (it needs separate account credits); the summary
    // follows the route/session choice and never enables it on its own.
    fast: opts.fast ?? opts.sendOpts?.fast ?? false,
    // Usage-ledger source for a foreground session's summary call (a
    // background session's own sourceType still wins there).
    requestKind: 'compaction',
    maxOutputTokens: opts.maxOutputTokens || SUMMARY_OUTPUT_TOKENS,
    providerState: undefined,
    onToolCall: undefined,
    onToolResult: undefined,
    onTextDelta: undefined,
    onReasoningDelta: undefined,
    onUsageDelta: undefined,
    onStreamDelta: undefined,
    onStageChange: undefined,
    drainSteering: undefined,
    onSteerMessage: undefined,
    signal: combinedSignal(opts.signal || opts.sendOpts?.signal || null, opts.timeoutMs || HANDOFF_TIMEOUT_MAX_MS),
  };
  // The `:compact` id isolates provider state (cache, socket pool); the
  // spend still belongs to the source session.
  if (opts.sessionId) {
    sendOpts.sessionId = `${opts.sessionId}:compact`;
    sendOpts.usageSessionId = opts.sessionId;
  }
  if (opts.promptCacheKey || opts.sendOpts?.promptCacheKey) {
    sendOpts.promptCacheKey = `${opts.promptCacheKey || opts.sendOpts.promptCacheKey}:compact`;
  }
  if (opts.providerCacheKey || opts.sendOpts?.providerCacheKey) {
    sendOpts.providerCacheKey = `${opts.providerCacheKey || opts.sendOpts.providerCacheKey}:compact`;
  }
  const codexWire = codexWireSendOpts(sendOpts.session, { requestKind: 'compaction' });
  if (codexWire) Object.assign(sendOpts, codexWire);
  return sendOpts;
}

// The largest complete next batch that fits beside the previous summary.
// Each successful call advances the source cursor, so the caller cannot
// retry the same failed input or loop indefinitely.
function fitNextBatch(fit, head, offset, previousSummary) {
  let prompt = fit(head.slice(offset), previousSummary);
  if (prompt) return { prompt, end: head.length };
  let low = offset + 1;
  let high = head.length;
  let end = offset;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = fit(head.slice(offset, mid), previousSummary);
    if (candidate) {
      prompt = candidate;
      end = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return { prompt, end };
}

function addSummaryUsage(usage, responseUsage) {
  if (!responseUsage) return usage;
  const total = usage || { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
  for (const key of Object.keys(total)) total[key] += Number(responseUsage[key]) || 0;
  return total;
}

function handoffGenerationDiagnostics({ messages, source, head, run, startedAt }) {
  return {
    inputMessages: Array.isArray(messages) ? messages.length : 0,
    sourceMessages: source.live.length,
    handoffInputMessages: head.length,
    previousSummary: !!source.previousSummary,
    calls: run.calls,
    promptChars: run.promptChars,
    promptBytes: run.promptBytes,
    promptTokens: run.promptTokens,
    summaryChars: run.summary.length,
    rawSummaryChars: run.rawSummary.length,
    summaryRepaired: run.summaryRepaired,
    durationMs: Date.now() - startedAt,
  };
}

export async function generateFreshHandoffSummary(provider, messages, model, budgetTokens, opts = {}) {
  if (!provider || typeof provider.send !== 'function') {
    throw new Error('generateFreshHandoffSummary: provider.send is required');
  }
  const startedAt = Date.now();
  const budget = effectiveBudget(budgetTokens, opts);
  const source = splitFreshSource(messages);
  let head =
    opts.filterOldHistoryForIngest === true ? compactionConversationRows(source.live, { summary: true }) : source.live;
  if (head.length === 0 && !source.previousSummary) {
    throw new Error('generateFreshHandoffSummary: no compactable session history');
  }
  const callBudget = Math.max(1, Math.floor((opts.compactionInputBudgetTokens || budget) * COMPACTION_PROMPT_HEADROOM));
  let previousSummary = source.previousSummary;
  // Batch fitting renders overlapping slices of the same head repeatedly.
  const lineCache = new Map();
  const fit = (items, previous) =>
    fitCompleteCompactionPrompt(
      {
        head: items,
        tail: [],
        previousSummary: previous,
        preservedFacts: null,
      },
      callBudget,
      lineCache
    );
  // Old installations may carry an enormous verbatim Memory handoff. Feed
  // every fragment through the same bounded pass; never silently cut it.
  if (previousSummary && !fit([], previousSummary)) {
    head = [...chunkConversationMessage('assistant', previousSummary), ...head];
    previousSummary = null;
  }
  const run = await summarizeInBatches({
    provider,
    model,
    sendOpts: summarySendOpts(opts),
    fit,
    head,
    previousSummary,
    callBudget,
  });
  const summaryMessage = fitGeneratedHandoffMessage(source.live, run.summary, budget, {
    provider: opts.providerName || provider.name || null,
    model,
  });
  if (!summaryMessage) {
    throw new Error(`generateFreshHandoffSummary: summary cannot fit budget=${budget}`);
  }
  const resultMessages = sanitizeToolPairs([...source.protectedPrefix, summaryMessage]);
  const diagnostics = handoffGenerationDiagnostics({ messages, source, head, run, startedAt });
  compactDebugLog('fresh handoff generation', diagnostics);
  return {
    messages: resultMessages,
    usage: run.usage,
    handoffGenerated: true,
    summary: run.summary,
    summaryRepaired: run.summaryRepaired,
    diagnostics,
  };
}

function compactionPromptMessages(prompt) {
  return [
    { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];
}

// Feeds the head through the provider in budget-fitting batches; each call
// carries the running summary as its previous-summary context.
async function summarizeInBatches({ provider, model, sendOpts, fit, head, previousSummary, callBudget }) {
  const run = {
    summary: '',
    rawSummary: '',
    summaryRepaired: false,
    usage: null,
    calls: 0,
    promptChars: 0,
    promptBytes: 0,
    promptTokens: 0,
  };
  let previous = previousSummary;
  let offset = 0;
  do {
    sendOpts.signal?.throwIfAborted();
    const { prompt, end } = fitNextBatch(fit, head, offset, previous);
    if (!prompt || (end === offset && offset < head.length)) {
      throw new Error(`generateFreshHandoffSummary: complete source cannot fit call budget=${callBudget}`);
    }
    const response = await provider.send(compactionPromptMessages(prompt), model, undefined, sendOpts);
    sendOpts.signal?.throwIfAborted();
    run.rawSummary = extractResponseText(response);
    if (!run.rawSummary) {
      throw new Error('generateFreshHandoffSummary: summary provider returned empty output');
    }
    const enforced = enforceCompactSummarySchema(run.rawSummary, { head: head.slice(offset, end), tail: [] });
    run.summary = enforced.summary;
    run.summaryRepaired ||= enforced.repaired === true;
    run.usage = addSummaryUsage(run.usage, response?.usage);
    run.calls += 1;
    run.promptChars += prompt.length;
    run.promptBytes += textByteLength(prompt);
    run.promptTokens = Math.max(run.promptTokens, safeEstimateMessagesTokens(compactionPromptMessages(prompt)) || 0);
    previous = run.summary;
    offset = end;
  } while (offset < head.length);
  return run;
}

function prependLatestUserContext(message, prefix) {
  const text = String(prefix || '').trim();
  if (!message || !text) return message;
  const replacesGoalState = text.includes('<goal_state>');
  const bare = stripRuntimeUserContext(message);
  // Replacement is confined to producer-owned reminders, never human XML.
  let suffix = bare !== message ? message.meta.runtimeUserContext.suffix : '';
  if (replacesGoalState) {
    suffix = suffix.replace(/<system-reminder>\s*<goal_state>[\s\S]*?<\/goal_state>\s*<\/system-reminder>\s*/gi, '');
  }
  // The kept suffix still carries the turn's agent list reminder: it stays told.
  const told = bare !== message && message.meta.agentListing ? { agentListing: message.meta.agentListing } : null;
  return withRuntimeUserContext(told ? { ...bare, meta: { ...bare.meta, ...told } } : bare, {
    prefix: `${text}\n\n`,
    suffix,
  });
}

const LOADED_SKILL_RESULT_RE = /^Loaded (?:built-in )?skill: /;

// A Skill load the retained execution tail keeps states what the skill
// delivered then: its tool list (the native payload or the summary text). It
// is brought to what the skill delivers now, in place, so its call stays
// paired: a skill that no longer loads keeps a result saying so, with no tool
// payload; a skill whose dependencies changed carries its current payload.
// Failed loads (errors) are left as they are. `currentSkill` absent, or a
// skill's `native` undefined (a preview), keeps the result.
function reconcileRetainedSkillLoads(messages, currentSkill) {
  if (!currentSkill) return messages;
  const calls = new Map(
    messages.flatMap((message) =>
      message?.role === 'assistant' ? (message.toolCalls || []).map((call) => [call.id, call]) : []
    )
  );
  const withoutPayload = ({ nativeToolSearch: _native, ...message }, content) => ({ ...message, content });
  return messages.map((message) => {
    if (message?.role !== 'tool') return message;
    const call = calls.get(message.toolCallId);
    const name = call?.name === 'Skill' ? String(call.arguments?.name || '').trim() : '';
    if (!name) return message;
    const text = contentText(message.content);
    if (!message.nativeToolSearch && !LOADED_SKILL_RESULT_RE.test(text)) return message;
    const skill = currentSkill(name);
    if (skill === null) {
      return withoutPayload(
        message,
        `Skill "${name}" is no longer available in this session (switched off, removed, or outside this project's scope); its instructions and tools are not active.`
      );
    }
    if (skill?.native === undefined) return message;
    if (skill.native) {
      return nativeToolsKey(message.nativeToolSearch) === nativeToolsKey(skill.native)
        ? message
        : { ...message, content: skill.native.summary, nativeToolSearch: skill.native };
    }
    return !message.nativeToolSearch && text === skill.summary ? message : withoutPayload(message, skill.summary);
  });
}

// The retained execution tail plus the current-turn messages that must
// survive every compaction verbatim.
function freshContextTail(source, budgetTokens, preserveConversation, opts) {
  const execution = buildExecutionTail(source.live, {
    contextWindow: opts.contextWindow || budgetTokens,
    sessionId: opts.sessionId,
    preserveConversation,
    preview: opts.preview === true,
  });
  const latestUser = latestActualUserInstructionMessage(source.live);
  const executed = reconcileRetainedSkillLoads(execution.messages, opts.currentSkill);
  const latestIndex = executed.findLastIndex(
    (message) => message.role === 'user' && message.content === latestUser?.content
  );
  const retainedTail = executed.map((message, index) =>
    index === latestIndex ? prependLatestUserContext(message, opts.latestUserPrefix) : message
  );
  // The turn's input: the latest real request or an unanswered notification
  // (a bot home thread may hold no human request at all).
  const turnInput = !!latestUser || pendingTaskNotificationIndexes(source.live).length > 0;
  const activeTurnContinuation =
    turnInput && opts.activeTurn === true ? activeTurnContinuationMessage(source.live) : null;
  // Older compacted sessions may have only synthetic Goal turns left.
  // Preserve the current snapshot without inventing a human instruction
  // to attach it to or resurrecting every historical Goal reminder.
  const standaloneContext =
    !latestUser && String(opts.latestUserPrefix || '').trim()
      ? {
          role: 'user',
          content: String(opts.latestUserPrefix).trim(),
          meta: { source: 'compact-context', synthetic: true },
        }
      : null;
  return {
    execution,
    latestUser,
    turnInput,
    retainedTail,
    activeTurnContinuation,
    volatileTail: [
      ...retainedTail,
      ...(activeTurnContinuation ? [activeTurnContinuation] : []),
      ...(standaloneContext ? [standaloneContext] : []),
    ],
  };
}

// The executed Skill call (its owner message, the call and its result) that
// delivered the body at `bodyIndex`, or null.
function skillLoader(live, bodyIndex, name) {
  for (let index = bodyIndex - 1; index >= 0; index -= 1) {
    const result = live[index];
    if (result?.role !== 'tool') continue;
    const owner = live
      .slice(0, index)
      .findLast(
        (message) => message?.role === 'assistant' && message.toolCalls?.some((c) => c.id === result.toolCallId)
      );
    const call = owner?.toolCalls.find((entry) => entry.id === result.toolCallId);
    if (call?.name === 'Skill' && call.arguments?.name === name) return { owner, call, result };
  }
  return null;
}

const nativeToolsKey = (native) =>
  JSON.stringify([native?.provider || '', native?.toolReferences || [], native?.openaiTools || []]);

const SKILL_RESTORE_SOURCE = 'compact-skill-restore';

// Native tool search exposes a skill's linked tools only through the executed
// Skill result that referenced them. A restored body keeps that pair, unless
// the retained tail already carries it, so its instructions never return
// without the tools they require. `current.native` is the payload the skill's
// current dependencies produce (null: none to expose); the transcript pair is
// kept while it matches, otherwise rebuilt from it. `current` absent, or its
// `native` undefined, keeps the transcript pair as it is.
function skillLoaderPair(live, bodyIndex, name, retainedCallIds, current) {
  const loader = skillLoader(live, bodyIndex, name);
  if (loader && retainedCallIds.has(loader.result.toolCallId)) return [];
  const native = current?.native === undefined ? loader?.result.nativeToolSearch : current.native;
  if (!native) return [];
  // The re-attached call is part of its owner message: it keeps that id.
  const callMessage = (call) =>
    loader
      ? carryMessageId({ role: 'assistant', content: '', toolCalls: [call] }, loader.owner)
      : { role: 'assistant', content: '', toolCalls: [call], meta: { source: SKILL_RESTORE_SOURCE, synthetic: true } };
  if (loader?.result.nativeToolSearch && nativeToolsKey(loader.result.nativeToolSearch) === nativeToolsKey(native)) {
    return [callMessage(loader.call), loader.result];
  }
  // A body that arrived without a native pair still needs one now: a
  // per-skill call id, stable across later Compacts that keep it.
  const call = loader?.call || {
    id: `skill-restore-${createHash('sha256').update(name).digest('hex').slice(0, 24)}`,
    name: 'Skill',
    arguments: { name },
  };
  const result = { role: 'tool', toolCallId: call.id, content: native.summary, nativeToolSearch: native };
  return [callMessage(call), loader ? carryMessageId(result, loader.result) : result];
}

// The body to restore: the transcript copy while it is what the Skill tool
// delivers now, else the current body.
function currentSkillBodyMessage(message, current) {
  if (!current || skillMessageText(message.content).trimStart() === current.body) return message;
  return { role: 'user', content: current.body, meta: 'skill' };
}

const SKILL_RELOAD_SOURCE = 'compact-skill-reload';

// How many Compacts in a row a skill may go unused before even its reload
// line is dropped: a skill untouched that long belongs to finished work, and
// the model can still load it by name from the skill manifest.
export const SKILL_RELOAD_MAX_IDLE = 3;

const SKILL_TOOL_NAMES = new Set(['Skill', 'skill_view']);

function skillReloadReminder(name, idle = 0) {
  return {
    role: 'user',
    content: `[mixdog-runtime] Skill "${name}" was active earlier, but Compact did not keep its instructions. Reload it with the Skill tool before relying on them.`,
    meta: { source: SKILL_RELOAD_SOURCE, synthetic: true, skill: name, idle },
  };
}

// Every Compact leaves this marker just ahead of the skills it restores, with
// `span`: how many messages follow it (restored skills and retained tail).
// All of them happened before that Compact, so the next one reads the skill
// use window from after them, whether or not a summary exists. The marker is
// not conversation: the next Compact removes it and writes a new one.
const SKILL_WINDOW_SOURCE = 'compact-skill-window';

function skillWindowMarker(span = 0) {
  return {
    role: 'user',
    content: '[mixdog-runtime] Compact boundary.',
    meta: { source: SKILL_WINDOW_SOURCE, synthetic: true, span },
  };
}

// Restore the skills the session used since the previous Compact, each as the
// Skill tool would deliver it now. A skill is used when it was loaded or one of
// its linked tools ran in that window (`windowStart` onward); its linked
// tools are the native tool references of its loader pair and, when the
// resolver gives them, `tools`. `currentSkill(name)` (the caller's resolver)
// answers `{ body, native, summary, tools? }` for a skill that still loads in
// the session, or null for one switched off, outside its scope or removed:
// such a skill is restored neither as a body nor as a reload line, since its
// instructions are no longer in force. Without a resolver the transcript
// copies are kept.
// Never summarize/truncate operating instructions or displace the handoff
// and current task. Every other active skill, and a used one whose body does
// not fit, is left as a one-line reload line. The line counts the Compacts
// the skill went unused (`meta.idle`) and is dropped past SKILL_RELOAD_MAX_IDLE.
// Reload lines are charged to the same budget: every possible line is
// reserved before any body is restored, and restoring a body releases its own.
function restoreSkillBodies(live, skillBudget, retainedTail, currentSkill = null, windowStart = 0) {
  const retainedCallIds = new Set(retainedTail.filter((m) => m?.role === 'tool').map((m) => m.toolCallId));
  const current = (name) => (currentSkill ? currentSkill(name) : undefined);
  const loads = (name) => current(name) !== null;
  const transcriptBodies = latestSkillBodies(live);
  const loaded = new Set(transcriptBodies.map((body) => body.name));
  const bodies = transcriptBodies.filter((body) => loads(body.name));
  // Reload lines from earlier Compacts: skill -> Compacts it went unused.
  const earlier = new Map();
  for (const m of live) {
    if (m?.meta?.source !== SKILL_RELOAD_SOURCE || loaded.has(m.meta.skill) || !loads(m.meta.skill)) continue;
    earlier.delete(m.meta.skill);
    earlier.set(m.meta.skill, Number.isFinite(m.meta.idle) ? m.meta.idle : 0);
  }

  // A loader pair can sit anywhere in the transcript (a restored body stays
  // ahead of the retained tail's pair), so read them all.
  const results = new Map(live.filter((m) => m?.role === 'tool').map((m) => [m.toolCallId, m]));
  const loaderTools = new Map();
  for (const message of live) {
    for (const call of message?.role === 'assistant' ? message.toolCalls || [] : []) {
      const references = results.get(call.id)?.nativeToolSearch?.toolReferences;
      if (call.name !== 'Skill' || !references) continue;
      const name = String(callArguments(call).name || '').trim();
      loaderTools.set(name, [...(loaderTools.get(name) || []), ...references]);
    }
  }
  const skillsOfTool = new Map();
  for (const name of new Set([...earlier.keys(), ...bodies.map((body) => body.name)])) {
    const skill = current(name);
    const tools = [...(skill?.native?.toolReferences || []), ...(skill?.tools || []), ...(loaderTools.get(name) || [])];
    for (const tool of tools) skillsOfTool.set(tool, (skillsOfTool.get(tool) || new Set()).add(name));
  }
  // Use since the previous Compact (from `windowStart`): the newest transcript
  // position of a load or of a linked tool's call.
  const lastUse = new Map();
  const noteUse = (name, index) => lastUse.set(name, Math.max(lastUse.get(name) ?? -1, index));
  live.forEach((message, index) => {
    if (index < windowStart || message?.role !== 'assistant') return;
    for (const call of message.toolCalls || []) {
      const args = callArguments(call);
      if (SKILL_TOOL_NAMES.has(call.name)) noteUse(String(args.name || '').trim(), index);
      else {
        const tool = call.name === 'call_tool' ? args.name : call.name;
        const mcpServer = `mcp:${parseMcpToolName(tool)?.server}`;
        for (const name of [...(skillsOfTool.get(tool) || []), ...(skillsOfTool.get(mcpServer) || [])]) {
          noteUse(name, index);
        }
      }
    }
  });
  for (const { name, message } of bodies) {
    const index = live.lastIndexOf(message);
    if (index >= windowStart) noteUse(name, index);
  }

  // Every active skill without a body ends as a reload line: an unused one
  // ages by a Compact and goes once past the bound; one used (or whose body
  // did not fit) starts over.
  const reminders = new Map();
  for (const [name, idle] of earlier) {
    if (lastUse.has(name)) reminders.set(name, 0);
    else if (idle < SKILL_RELOAD_MAX_IDLE) reminders.set(name, idle + 1);
  }
  const used = bodies.filter(({ name }) => lastUse.has(name)).sort((a, b) => lastUse.get(b.name) - lastUse.get(a.name));
  const unused = bodies.filter(({ name }) => !lastUse.has(name));

  const reminderCost = (name, idle = 0) => estimateMessagesTokens([skillReloadReminder(name, idle)]);
  let reserved =
    [...reminders].reduce((sum, [name, idle]) => sum + reminderCost(name, idle), 0) +
    unused.reduce((sum, { name }) => sum + reminderCost(name, 1), 0) +
    used.reduce((sum, { name }) => sum + reminderCost(name), 0);
  const dropped = new Set();
  const restoredSkills = [];
  let skillTokens = 0;
  for (const { name, message } of used) {
    const skill = current(name);
    const restored = [
      ...skillLoaderPair(live, live.lastIndexOf(message), name, retainedCallIds, skill),
      currentSkillBodyMessage(message, skill),
    ];
    const cost = estimateMessagesTokens(restored);
    const own = reminderCost(name);
    if (skillTokens + cost + reserved - own > skillBudget) {
      dropped.add(name);
      continue;
    }
    restoredSkills.unshift(...restored);
    skillTokens += cost;
    reserved -= own;
  }
  // In transcript order, after the lines of earlier Compacts.
  for (const { name } of bodies) {
    if (!lastUse.has(name)) reminders.set(name, 1);
    else if (dropped.has(name)) reminders.set(name, 0);
  }
  // Newest skill first; only a budget too small for the lines themselves
  // leaves one out.
  const pending = [...reminders];
  const reminded = new Set();
  for (const [name, idle] of pending.toReversed()) {
    const cost = reminderCost(name, idle);
    if (skillTokens + cost > skillBudget) continue;
    reminded.add(name);
    skillTokens += cost;
  }
  restoredSkills.push(
    ...pending.filter(([name]) => reminded.has(name)).map(([name, idle]) => skillReloadReminder(name, idle))
  );
  return { restoredSkills, skillTokens };
}

function freshContextDiagnostics(plan) {
  const { source, tail, skills, handoff, budget, targetBudget, mandatoryCost, finalTokens } = plan;
  const { execution, retainedTail, volatileTail, activeTurnContinuation } = tail;
  const liveTokens = safeEstimateMessagesTokens(source.live);
  const volatileTailTokens = safeEstimateMessagesTokens(volatileTail);
  return {
    noOp: false,
    inputMessages: Array.isArray(plan.messages) ? plan.messages.length : 0,
    baseMessages: plan.baseSanitized.length,
    baseTokens: plan.baseTokens,
    systemMessages: source.protectedPrefix.length,
    liveMessages: source.live.length,
    headMessages: source.live.length,
    tailMessages: volatileTail.length,
    mandatoryMessages: plan.mandatory.length,
    finalMessages: plan.result.length,
    systemTokens: safeEstimateMessagesTokens(source.protectedPrefix),
    liveTokens,
    headTokens: liveTokens,
    tailTokens: volatileTailTokens,
    mandatoryCost,
    finalTokens,
    targetBudgetTokens: targetBudget,
    targetExceeded: finalTokens > targetBudget,
    stablePrefixTokens: safeEstimateMessagesTokens(plan.stablePrefixMessages),
    volatileTailTokens,
    latestUserRetained: !!tail.latestUser,
    activeTurnContinuation: !!activeTurnContinuation,
    retainedAssistantToolMessages: retainedTail.filter((message) => message.toolCalls?.length).length,
    retainedProviderReplayMessages: retainedTail.filter((message) => message.providerReplay).length,
    toolHistoryBudget: execution.toolBudget,
    restoredSkillBodies: latestSkillBodies(skills.restoredSkills).length,
    skillBodyBudget: skills.skillBudget,
    skillBodyTokens: skills.skillTokens,
    toolHistoryTokens: execution.toolTokens,
    omittedToolGroups: execution.omittedGroups || 0,
    budgetTokens: budget,
    remainingTokens: budget - mandatoryCost,
    handoffTokenCap: handoff.tokenCap,
    handoffRoom: handoff.room,
    handoffChars: handoff.text.length,
    handoffBytes: textByteLength(handoff.text),
    summaryMessageChars: handoff.summaryContent.length,
    summaryMessageBytes: textByteLength(handoff.summaryContent),
    handoffEmpty: !handoff.text,
    conversationPreserved: !handoff.text,
    handoffTruncatedInSummary: !!handoff.text && !handoff.summaryContent.includes(handoff.text),
    fileReattached: false,
    tailOptions: {
      latestActualUserOnly: execution.retainedGroups === 0,
      activeTurnContinuation: !!activeTurnContinuation,
    },
    durationMs: Date.now() - plan.startedAt,
  };
}

function fitsBudgetResult({ startedAt, messages, baseSanitized, baseTokens, budget, query }) {
  return {
    messages: baseSanitized,
    freshContext: false,
    query,
    diagnostics: {
      noOp: true,
      reason: 'fits_budget',
      inputMessages: Array.isArray(messages) ? messages.length : 0,
      baseMessages: baseSanitized.length,
      baseTokens,
      budgetTokens: budget,
      durationMs: Date.now() - startedAt,
    },
  };
}

// How much of the budget the handoff summary may take: what the mandatory
// messages leave, capped by opts.handoffTokenCap when one is set.
function handoffRoomFor(budget, mandatoryCost, opts) {
  const handoffRoomUncapped = budget - mandatoryCost;
  const handoffTokenCap = Number(opts.handoffTokenCap);
  const cappedHandoff = Number.isFinite(handoffTokenCap) && handoffTokenCap > 0;
  return {
    room: cappedHandoff ? Math.min(handoffRoomUncapped, handoffTokenCap) : handoffRoomUncapped,
    tokenCap: cappedHandoff ? handoffTokenCap : null,
  };
}

// The compact budget: the soft target, widened toward the model window when
// the mandatory context and the handoff need more. The target is soft, the
// model window is not. Never trim the latest instruction or an execution
// record just to claim a 25% result.
function freshContextBudget({ targetBudget, budgetTokens, mandatoryCost, summaryMessage, opts }) {
  if (!(opts.maxBudgetTokens > budgetTokens)) return targetBudget;
  const required = mandatoryCost + estimateMessagesTokens(summaryMessage ? [summaryMessage] : []);
  return Math.min(effectiveBudget(opts.maxBudgetTokens, opts), Math.max(targetBudget, required));
}

// Room for restored skill bodies: a fifth of the target, capped, and never
// more than what the stable head and volatile tail leave over.
function freshSkillBudget(targetBudget, budget, committed) {
  return Math.max(0, Math.min(25_000, Math.floor(targetBudget * 0.2), budget - estimateMessagesTokens(committed)));
}

// Every pass rebuilds the ack; it keeps the previous ack's id so the archive
// does not count an unchanged ack as dropped, unless the tail still holds it.
function stableAckMessage(previousAck, volatileTail) {
  const ack = contextAckMessage();
  const id = messageIdOf(previousAck);
  if (!id || volatileTail.some((message) => messageIdOf(message) === id)) return ack;
  return carryMessageId(ack, previousAck);
}

// The pieces every fresh context carries: the protected prefix, the handoff
// summary (or the previous one when no handoff was produced), the stable
// acknowledgement between them and the volatile tail. `mandatory` is what
// must fit before any summary is admitted.
function freshContextLayout(source, budgetTokens, opts) {
  const handoffText = String(opts.handoffText || '').trim();
  // The preview carries the real summary envelope but no invented AI text.
  // Its caller adds the summary output ceiling to the resulting token estimate.
  const replaceConversation = !!handoffText || (opts.preview === true && opts.previewSummary === true);
  const summaryMessage = replaceConversation
    ? fitFreshContextSummaryMessage(source.live, handoffText, Number.MAX_SAFE_INTEGER)
    : source.previousSummaryMessage;
  const tail = freshContextTail(source, budgetTokens, !replaceConversation, opts);
  const stableAck = tail.turnInput && summaryMessage ? stableAckMessage(source.previousAck, tail.volatileTail) : null;
  const stableHead = [
    ...source.protectedPrefix,
    ...(summaryMessage ? [summaryMessage] : []),
    ...(stableAck ? [stableAck] : []),
  ];
  const mandatory = [...source.protectedPrefix, ...(stableAck ? [stableAck] : []), ...tail.volatileTail];
  return { handoffText, summaryMessage, tail, stableHead, mandatory, mandatoryCost: estimateMessagesTokens(mandatory) };
}

function mandatoryOverflows(budget, mandatoryCost, summaryMessage) {
  return mandatoryCost > budget || (summaryMessage && mandatoryCost === budget);
}

export const LATEST_TURN_EXCEEDS_CONTEXT = 'LATEST_TURN_EXCEEDS_CONTEXT';

// Says what does not fit and what would make it fit. A larger window is only
// offered when one would actually hold the required size.
function assertMandatoryFits(budget, mandatoryCost, summaryMessage, contextWindow, latestUser) {
  if (!mandatoryOverflows(budget, mandatoryCost, summaryMessage)) return;
  // Fixed sentences with the sizes inline: the desktop re-speaks each one
  // through its catalog (error-notice-copy / transcript-failure-text).
  const count = (value) => Number(value).toLocaleString('en-US');
  const window = Number(contextWindow) > 0 ? `${count(contextWindow)}-token` : 'current';
  const attachments = messageAttachmentTokens(latestUser);
  const cause =
    attachments > 0
      ? `Its attachments alone are about ${count(attachments)} tokens.`
      : 'The latest message and protected session context (system rules, tool definitions) are that large.';
  const error = new Error(
    `The latest message cannot fit this model (${LATEST_TURN_EXCEEDS_CONTEXT}): it needs about ` +
      `${count(mandatoryCost)} tokens, but the ${window} window leaves ${count(budget)} for it. ${cause} ` +
      'Shorten the message or move large pasted text into a file the model can read. ' +
      `A larger context window helps only if it holds ${count(mandatoryCost)} tokens plus room for the answer.`
  );
  error.code = LATEST_TURN_EXCEEDS_CONTEXT;
  throw error;
}

// The source with the latest request's attachments sent by reference. Same
// source when it carries none.
function withLatestAttachmentsReferenced(source) {
  const latest = latestActualUserInstructionIndex(source.live);
  if (latest < 0 || !messageHasReferencableMedia(source.live[latest])) return source;
  const live = source.live.slice();
  live[latest] = referenceMessageMedia(live[latest]);
  return { ...source, live };
}

function assertHandoffFits(summaryMessage, room) {
  if (summaryMessage && estimateMessagesTokens([summaryMessage]) > room) {
    throw new Error(
      `freshContextCompactMessages: complete handoff exceeds the compact budget=${room}; ` +
        'refusing to drop older context'
    );
  }
}

// One resolution per skill per Compact: the retained tail and the restored
// bodies read the same answer (the real pass re-arms dependencies once).
function memoizedSkillResolver(resolve) {
  if (!resolve) return null;
  const known = new Map();
  return (name) => {
    if (!known.has(name)) known.set(name, resolve(name));
    return known.get(name);
  };
}

export function freshContextCompactMessages(messages, budgetTokens, options = {}) {
  const opts = { ...options, currentSkill: memoizedSkillResolver(options.currentSkill) };
  const startedAt = Date.now();
  const targetBudget = effectiveBudget(budgetTokens, opts);
  const baseSanitized = reconcileDedupStubs(sanitizeToolPairs(messages));
  const baseTokens = safeEstimateMessagesTokens(baseSanitized);
  if (baseTokens != null && baseTokens <= targetBudget && opts.force !== true) {
    return fitsBudgetResult({
      startedAt,
      messages,
      baseSanitized,
      baseTokens,
      budget: targetBudget,
      query: opts.query || '',
    });
  }

  let source = splitFreshSource(baseSanitized);
  let layout = freshContextLayout(source, budgetTokens, opts);
  let budget = freshContextBudget({ targetBudget, budgetTokens, ...layout, opts });
  // The latest request is mandatory and kept verbatim — except its
  // attachments: when they are what does not fit (or the provider already
  // refused this request as too long), they travel by reference instead of
  // failing the turn, and every later turn, forever.
  if (
    opts.referenceLatestAttachments === true ||
    mandatoryOverflows(budget, layout.mandatoryCost, layout.summaryMessage)
  ) {
    const referenced = withLatestAttachmentsReferenced(source);
    if (referenced !== source) {
      source = referenced;
      layout = freshContextLayout(source, budgetTokens, opts);
      budget = freshContextBudget({ targetBudget, budgetTokens, ...layout, opts });
    }
  }
  const { handoffText, summaryMessage, tail, stableHead, mandatory, mandatoryCost } = layout;
  assertMandatoryFits(budget, mandatoryCost, summaryMessage, opts.contextWindow, tail.latestUser);
  const handoff = handoffRoomFor(budget, mandatoryCost, opts);
  const summaryContent = String(summaryMessage?.content || '');
  assertHandoffFits(summaryMessage, handoff.room);
  const skillBudget = freshSkillBudget(targetBudget, budget, [...stableHead, ...tail.volatileTail]);
  // Restored skills carry the window marker, which is charged to their budget.
  const markerCost = estimateMessagesTokens([skillWindowMarker()]);
  const skills = {
    ...restoreSkillBodies(
      source.live,
      Math.max(0, skillBudget - markerCost),
      tail.volatileTail,
      opts.currentSkill,
      source.skillWindowStart
    ),
    skillBudget,
  };
  // A session with no skill state has no use to window: no marker.
  const marker = skills.restoredSkills.length ? [skillWindowMarker()] : [];
  const stablePrefixMessages = [...stableHead, ...marker, ...skills.restoredSkills];
  const compacted = rebaseCompactedEffortConfiguration(
    baseSanitized,
    reconcileDedupStubs(sanitizeToolPairs([...stablePrefixMessages, ...tail.volatileTail]))
  );
  // The next Compact reads everything after the marker as history, not as use.
  const markerAt = compacted.findLastIndex((message) => message?.meta?.source === SKILL_WINDOW_SOURCE);
  const result =
    markerAt < 0
      ? compacted
      : compacted.map((message, index) =>
          index === markerAt ? skillWindowMarker(compacted.length - markerAt - 1) : message
        );
  const finalTokens = estimateMessagesTokens(result);
  if (finalTokens > budget) {
    throw new Error(`freshContextCompactMessages: compacted result exceeds budget=${budget} (result=${finalTokens})`);
  }
  const diagnostics = freshContextDiagnostics({
    startedAt,
    messages,
    baseSanitized,
    baseTokens,
    source,
    tail,
    mandatory,
    mandatoryCost,
    budget,
    targetBudget,
    skills,
    stablePrefixMessages,
    result,
    finalTokens,
    handoff: { text: handoffText, tokenCap: handoff.tokenCap, room: handoff.room, summaryContent },
  });
  compactDebugLog('fresh-context result', diagnostics);
  return {
    messages: result,
    freshContext: true,
    query: opts.query || '',
    diagnostics,
  };
}
