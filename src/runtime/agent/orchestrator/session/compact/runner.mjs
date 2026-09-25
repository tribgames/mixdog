// Rule-based Compact preserves conversation verbatim by default. A bounded
// cumulative handoff replaces only the conversation part when requested by
// its independent threshold policy.
import { estimateMessagesTokens, reconcileDedupStubs, sanitizeToolPairs } from '../context-utils.mjs';
import { HANDOFF_TIMEOUT_MAX_MS, SUMMARY_OUTPUT_TOKENS, compactDebugLog } from './constants.mjs';
import { redactToolCallSecretsInMessages, safeEstimateMessagesTokens, textByteLength } from './text-utils.mjs';
import {
  isSummaryMessage,
  latestActualUserInstructionIndex,
  latestActualUserInstructionMessage,
  splitProtectedContext,
} from './messages.mjs';
import { activeTurnContinuationMessage } from './continuation.mjs';
import { buildExecutionTail } from './execution-tail.mjs';
import { latestSkillBodies } from '../../context/skill-state.mjs';
import { effectiveBudget } from './budget.mjs';
import { stripRuntimeUserContext, withRuntimeUserContext } from '../runtime-user-context.mjs';
import {
  allTextContent,
  normalizeIngestRole,
  shouldExcludeIngestMessage,
} from '../../../../memory/lib/session-ingest.mjs';
import { codexWireSendOpts } from '../manager/session-id.mjs';
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
  const { protectedPrefix, conversation } = splitProtectedContext(sanitized);
  let previousSummaryMessage = null;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (isSummaryMessage(conversation[index])) {
      previousSummaryMessage = conversation[index];
      break;
    }
  }
  const latestUserIndex = latestActualUserInstructionIndex(conversation);
  return {
    protectedPrefix,
    previousSummary: previousSummaryMessage?.content || null,
    previousSummaryMessage,
    // Budgeting, AI input and rule-only retention use this same projection.
    // Keep current-turn reminders; remove only proven runtime additions from
    // older requests. Unmarked legacy text remains part of the summary budget.
    live: conversation
      .map((message, index) => (index === latestUserIndex ? message : stripRuntimeUserContext(message)))
      .filter((message) => !isSummaryMessage(message)),
    sanitized,
  };
}

function chunkConversationMessage(role, content, source = {}) {
  const text = String(content || '');
  const out = [];
  for (let offset = 0; offset < text.length; offset += HANDOFF_SOURCE_CHUNK_CHARS) {
    const next = {
      role,
      content: text.slice(offset, offset + HANDOFF_SOURCE_CHUNK_CHARS),
    };
    if (Object.hasOwn(source, 'ts')) next.ts = source.ts;
    if (Object.hasOwn(source, 'timestamp')) next.timestamp = source.timestamp;
    out.push(next);
  }
  return out;
}

function pureConversationForHandoff(messages) {
  const out = [];
  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue;
    const role = normalizeIngestRole(message.role);
    if (!role || shouldExcludeIngestMessage(message)) continue;
    const content = allTextContent(message.content).trim();
    if (!content) continue;
    out.push(...chunkConversationMessage(role, content, message));
  }
  return out;
}

export function conversationCompactionInput(messages) {
  const source = splitFreshSource(messages);
  const latest = latestActualUserInstructionIndex(source.live);
  return [
    ...(source.previousSummaryMessage ? [source.previousSummaryMessage] : []),
    // The latest actual request is mandatory and must never be replaced by
    // a summary. Tool outputs, skills and runtime injections are excluded
    // by the same conversation projection used by summary generation.
    ...pureConversationForHandoff(source.live.filter((_, index) => index !== latest)),
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
    fast: opts.fast ?? opts.sendOpts?.fast ?? true,
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
  if (opts.sessionId) sendOpts.sessionId = `${opts.sessionId}:compact`;
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
  let head = opts.filterOldHistoryForIngest === true ? pureConversationForHandoff(source.live) : source.live;
  if (head.length === 0 && !source.previousSummary) {
    throw new Error('generateFreshHandoffSummary: no compactable session history');
  }
  const callBudget = Math.max(1, Math.floor((opts.compactionInputBudgetTokens || budget) * COMPACTION_PROMPT_HEADROOM));
  let previousSummary = source.previousSummary;
  const fit = (items, previous) =>
    fitCompleteCompactionPrompt(
      {
        head: items,
        tail: [],
        previousSummary: previous,
        preservedFacts: null,
      },
      callBudget
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
  return withRuntimeUserContext(bare, { prefix: `${text}\n\n`, suffix });
}

// The retained execution tail plus the current-turn messages that must
// survive every compaction verbatim.
function freshContextTail(source, budgetTokens, preserveConversation, opts) {
  const execution = buildExecutionTail(source.live, {
    contextWindow: opts.contextWindow || budgetTokens,
    sessionId: opts.sessionId,
    preserveConversation,
  });
  const latestUser = latestActualUserInstructionMessage(source.live);
  const latestIndex = execution.messages.findLastIndex(
    (message) => message.role === 'user' && message.content === latestUser?.content
  );
  const retainedTail = execution.messages.map((message, index) =>
    index === latestIndex ? prependLatestUserContext(message, opts.latestUserPrefix) : message
  );
  const activeTurnContinuation =
    latestUser && opts.activeTurn === true ? activeTurnContinuationMessage(source.live) : null;
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
    retainedTail,
    activeTurnContinuation,
    volatileTail: [
      ...retainedTail,
      ...(activeTurnContinuation ? [activeTurnContinuation] : []),
      ...(standaloneContext ? [standaloneContext] : []),
    ],
  };
}

// Native tool search exposes a skill's linked tools only through the executed
// Skill result that referenced them. A restored body keeps that pair, unless
// the retained tail already carries it, so its instructions never return
// without the tools they require.
function skillLoaderPair(live, bodyIndex, name, retainedCallIds) {
  for (let index = bodyIndex - 1; index >= 0; index -= 1) {
    const result = live[index];
    if (result?.role !== 'tool') continue;
    const owner = live
      .slice(0, index)
      .findLast(
        (message) => message?.role === 'assistant' && message.toolCalls?.some((c) => c.id === result.toolCallId)
      );
    const call = owner?.toolCalls.find((entry) => entry.id === result.toolCallId);
    if (call?.name !== 'Skill' || call.arguments?.name !== name) continue;
    if (!result.nativeToolSearch || retainedCallIds.has(result.toolCallId)) return [];
    return [{ role: 'assistant', content: '', toolCalls: [call] }, result];
  }
  return [];
}

// Preserve complete, most-recent skill bodies from the durable transcript.
// Never summarize/truncate operating instructions or displace the handoff
// and current task. An omitted body remains eligible for a normal reload.
function restoreSkillBodies(live, skillBudget, retainedTail) {
  const retainedCallIds = new Set(retainedTail.filter((m) => m?.role === 'tool').map((m) => m.toolCallId));
  const restoredSkills = [];
  let skillTokens = 0;
  for (const { name, message } of latestSkillBodies(live).reverse()) {
    const restored = [...skillLoaderPair(live, live.lastIndexOf(message), name, retainedCallIds), message];
    const cost = estimateMessagesTokens(restored);
    if (skillTokens + cost > skillBudget) continue;
    restoredSkills.unshift(...restored);
    skillTokens += cost;
  }
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

// The pieces every fresh context carries: the protected prefix, the handoff
// summary (or the previous one when no handoff was produced), the stable
// acknowledgement between them and the volatile tail. `mandatory` is what
// must fit before any summary is admitted.
function freshContextLayout(source, budgetTokens, opts) {
  const handoffText = String(opts.handoffText || '').trim();
  const summaryMessage = handoffText
    ? fitFreshContextSummaryMessage(source.live, handoffText, Number.MAX_SAFE_INTEGER)
    : source.previousSummaryMessage;
  const tail = freshContextTail(source, budgetTokens, !handoffText, opts);
  const stableAck = tail.latestUser && summaryMessage ? { role: 'assistant', content: '.' } : null;
  const stableHead = [
    ...source.protectedPrefix,
    ...(summaryMessage ? [summaryMessage] : []),
    ...(stableAck ? [stableAck] : []),
  ];
  const mandatory = [...source.protectedPrefix, ...(stableAck ? [stableAck] : []), ...tail.volatileTail];
  return { handoffText, summaryMessage, tail, stableHead, mandatory, mandatoryCost: estimateMessagesTokens(mandatory) };
}

function assertMandatoryFits(budget, mandatoryCost, summaryMessage) {
  if (mandatoryCost > budget || (summaryMessage && mandatoryCost === budget)) {
    throw new Error(
      `freshContextCompactMessages: mandatory session context/latest instruction exceeds compact budget=${budget} ` +
        `(mandatory=${mandatoryCost})`
    );
  }
}

function assertHandoffFits(summaryMessage, room) {
  if (summaryMessage && estimateMessagesTokens([summaryMessage]) > room) {
    throw new Error(
      `freshContextCompactMessages: complete handoff exceeds the compact budget=${room}; ` +
        'refusing to drop older context'
    );
  }
}

export function freshContextCompactMessages(messages, budgetTokens, opts = {}) {
  const startedAt = Date.now();
  const targetBudget = effectiveBudget(budgetTokens, opts);
  let budget = targetBudget;
  const baseSanitized = reconcileDedupStubs(sanitizeToolPairs(messages));
  const baseTokens = safeEstimateMessagesTokens(baseSanitized);
  if (baseTokens != null && baseTokens <= budget && opts.force !== true) {
    return fitsBudgetResult({ startedAt, messages, baseSanitized, baseTokens, budget, query: opts.query || '' });
  }

  const source = splitFreshSource(baseSanitized);
  const { handoffText, summaryMessage, tail, stableHead, mandatory, mandatoryCost } = freshContextLayout(
    source,
    budgetTokens,
    opts
  );
  budget = freshContextBudget({ targetBudget, budgetTokens, mandatoryCost, summaryMessage, opts });
  assertMandatoryFits(budget, mandatoryCost, summaryMessage);
  const handoff = handoffRoomFor(budget, mandatoryCost, opts);
  const summaryContent = String(summaryMessage?.content || '');
  assertHandoffFits(summaryMessage, handoff.room);
  const skillBudget = freshSkillBudget(targetBudget, budget, [...stableHead, ...tail.volatileTail]);
  const skills = { ...restoreSkillBodies(source.live, skillBudget, tail.volatileTail), skillBudget };
  const stablePrefixMessages = [...stableHead, ...skills.restoredSkills];
  const result = rebaseCompactedEffortConfiguration(
    baseSanitized,
    reconcileDedupStubs(sanitizeToolPairs([...stablePrefixMessages, ...tail.volatileTail]))
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
