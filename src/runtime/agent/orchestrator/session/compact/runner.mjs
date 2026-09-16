// Rule-based Compact preserves conversation verbatim by default. A bounded
// cumulative handoff replaces only the conversation part when requested by
// its independent threshold policy.
import { estimateMessagesTokens, reconcileDedupStubs, sanitizeToolPairs } from '../context-utils.mjs';
import { SUMMARY_OUTPUT_TOKENS, compactDebugLog } from './constants.mjs';
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
import {
  normalizeIngestRole,
  sessionMessageContentForIngest,
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
  return {
    protectedPrefix,
    previousSummary: previousSummaryMessage?.content || null,
    previousSummaryMessage,
    live: conversation.filter((message) => !isSummaryMessage(message)),
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
    const content = String(sessionMessageContentForIngest(message) || '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
      .trim();
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
  const sendOpts = {
    ...(opts.sendOpts || {}),
    thinkingBudgetTokens: undefined,
    xaiReasoningEffort: undefined,
    reasoningEffort: undefined,
    effort: 'low',
    // Summary generation is an independent request, not a continuation
    // of the source conversation's effort-control history.
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
    signal: combinedSignal(opts.signal || opts.sendOpts?.signal || null, opts.timeoutMs || 30_000),
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

  let offset = 0;
  let calls = 0;
  let promptChars = 0;
  let promptBytes = 0;
  let promptTokens = 0;
  let summary = '';
  let rawSummary = '';
  let summaryRepaired = false;
  let usage = null;
  do {
    sendOpts.signal?.throwIfAborted();
    // Find the largest complete next batch that fits beside the previous
    // summary. Each successful call advances the source cursor, so this
    // cannot retry the same failed input or loop indefinitely.
    let end = head.length;
    let prompt = fit(head.slice(offset), previousSummary);
    if (!prompt) {
      let low = offset + 1;
      let high = head.length;
      end = offset;
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
    }
    if (!prompt || (end === offset && offset < head.length)) {
      throw new Error(`generateFreshHandoffSummary: complete source cannot fit call budget=${callBudget}`);
    }
    const response = await provider.send(
      [
        { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      model,
      undefined,
      sendOpts
    );
    sendOpts.signal?.throwIfAborted();
    rawSummary = extractResponseText(response);
    if (!rawSummary) {
      throw new Error('generateFreshHandoffSummary: summary provider returned empty output');
    }
    const enforced = enforceCompactSummarySchema(rawSummary, { head: head.slice(offset, end), tail: [] });
    summary = enforced.summary;
    summaryRepaired ||= enforced.repaired === true;
    if (response?.usage) {
      usage ||= { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
      for (const key of Object.keys(usage)) usage[key] += Number(response.usage[key]) || 0;
    }
    calls += 1;
    promptChars += prompt.length;
    promptBytes += textByteLength(prompt);
    promptTokens = Math.max(
      promptTokens,
      safeEstimateMessagesTokens([
        { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ]) || 0
    );
    previousSummary = summary;
    offset = end;
  } while (offset < head.length);
  const summaryMessage = fitGeneratedHandoffMessage(source.live, summary, budget, {
    provider: opts.providerName || provider.name || null,
    model,
  });
  if (!summaryMessage) {
    throw new Error(`generateFreshHandoffSummary: summary cannot fit budget=${budget}`);
  }
  const resultMessages = sanitizeToolPairs([...source.protectedPrefix, summaryMessage]);
  const diagnostics = {
    inputMessages: Array.isArray(messages) ? messages.length : 0,
    sourceMessages: source.live.length,
    handoffInputMessages: head.length,
    previousSummary: !!source.previousSummary,
    calls,
    promptChars,
    promptBytes,
    promptTokens,
    summaryChars: summary.length,
    rawSummaryChars: rawSummary.length,
    summaryRepaired,
    durationMs: Date.now() - startedAt,
  };
  compactDebugLog('fresh handoff generation', diagnostics);
  return {
    messages: resultMessages,
    usage,
    handoffGenerated: true,
    summary,
    summaryRepaired,
    diagnostics,
  };
}

function prependLatestUserContext(message, prefix) {
  const text = String(prefix || '').trim();
  if (!message || !text) return message;
  const replacesGoalState = text.includes('<goal_state>');
  const stripPriorGoalState = (value) =>
    replacesGoalState
      ? String(value ?? '').replace(
          /<system-reminder>\s*<goal_state>[\s\S]*?<\/goal_state>\s*<\/system-reminder>\s*/gi,
          ''
        )
      : String(value ?? '');
  const priorContent = Array.isArray(message.content)
    ? message.content.map((block) => {
        if (typeof block === 'string') return stripPriorGoalState(block);
        if (block?.type === 'text' && typeof block.text === 'string') {
          return { ...block, text: stripPriorGoalState(block.text) };
        }
        return block;
      })
    : stripPriorGoalState(message.content);
  const content = Array.isArray(priorContent)
    ? [{ type: 'text', text: `${text}\n\n` }, ...priorContent]
    : `${text}\n\n${priorContent.trimStart()}`;
  return { ...message, content };
}

export function freshContextCompactMessages(messages, budgetTokens, opts = {}) {
  const startedAt = Date.now();
  const targetBudget = effectiveBudget(budgetTokens, opts);
  let budget = targetBudget;
  const baseSanitized = reconcileDedupStubs(sanitizeToolPairs(messages));
  const baseTokens = safeEstimateMessagesTokens(baseSanitized);
  if (baseTokens != null && baseTokens <= budget && opts.force !== true) {
    return {
      messages: baseSanitized,
      freshContext: false,
      query: opts.query || '',
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

  const source = splitFreshSource(baseSanitized);
  const handoffText = String(opts.handoffText || '').trim();
  const preserveConversation = !handoffText;
  const completeSummary = handoffText
    ? fitFreshContextSummaryMessage(source.live, handoffText, Number.MAX_SAFE_INTEGER)
    : source.previousSummaryMessage;
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
  const stableAck = latestUser && completeSummary ? { role: 'assistant', content: '.' } : null;
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
  const volatileTail = [
    ...retainedTail,
    ...(activeTurnContinuation ? [activeTurnContinuation] : []),
    ...(standaloneContext ? [standaloneContext] : []),
  ];
  const mandatory = [...source.protectedPrefix, ...(stableAck ? [stableAck] : []), ...volatileTail];
  const mandatoryCost = estimateMessagesTokens(mandatory);
  if (opts.maxBudgetTokens > budgetTokens) {
    const required = mandatoryCost + estimateMessagesTokens(completeSummary ? [completeSummary] : []);
    // The target is soft, the model window is not. Never trim the latest
    // instruction or an execution record just to claim a 25% result.
    budget = Math.min(effectiveBudget(opts.maxBudgetTokens, opts), Math.max(targetBudget, required));
  }
  if (mandatoryCost > budget || (completeSummary && mandatoryCost === budget)) {
    throw new Error(
      `freshContextCompactMessages: mandatory session context/latest instruction exceeds compact budget=${budget} ` +
        `(mandatory=${mandatoryCost})`
    );
  }
  const handoffRoomUncapped = budget - mandatoryCost;
  const handoffTokenCap = Number(opts.handoffTokenCap);
  const handoffRoom =
    Number.isFinite(handoffTokenCap) && handoffTokenCap > 0
      ? Math.min(handoffRoomUncapped, handoffTokenCap)
      : handoffRoomUncapped;
  const summaryMessage = completeSummary;
  const summaryContent = String(summaryMessage?.content || '');
  if (summaryMessage && estimateMessagesTokens([summaryMessage]) > handoffRoom) {
    throw new Error(
      `freshContextCompactMessages: complete handoff exceeds the compact budget=${handoffRoom}; ` +
        'refusing to drop older context'
    );
  }
  const baseResult = [
    ...source.protectedPrefix,
    ...(summaryMessage ? [summaryMessage] : []),
    ...(stableAck ? [stableAck] : []),
    ...volatileTail,
  ];
  // Preserve complete, most-recent skill bodies from the durable transcript.
  // Never summarize/truncate operating instructions or displace the handoff
  // and current task. An omitted body remains eligible for a normal reload.
  const skillBudget = Math.max(
    0,
    Math.min(25_000, Math.floor(targetBudget * 0.2), budget - estimateMessagesTokens(baseResult))
  );
  const restoredSkills = [];
  let skillTokens = 0;
  for (const { message } of latestSkillBodies(source.live).reverse()) {
    const cost = estimateMessagesTokens([message]);
    if (skillTokens + cost > skillBudget) continue;
    restoredSkills.unshift(message);
    skillTokens += cost;
  }
  const result = rebaseCompactedEffortConfiguration(
    baseSanitized,
    reconcileDedupStubs(
      sanitizeToolPairs([
        ...source.protectedPrefix,
        ...(summaryMessage ? [summaryMessage] : []),
        ...(stableAck ? [stableAck] : []),
        ...restoredSkills,
        ...volatileTail,
      ])
    )
  );
  const finalTokens = estimateMessagesTokens(result);
  if (finalTokens > budget) {
    throw new Error(`freshContextCompactMessages: compacted result exceeds budget=${budget} (result=${finalTokens})`);
  }
  const stablePrefixMessages = [
    ...source.protectedPrefix,
    ...(summaryMessage ? [summaryMessage] : []),
    ...(stableAck ? [stableAck] : []),
    ...restoredSkills,
  ];
  const diagnostics = {
    noOp: false,
    inputMessages: Array.isArray(messages) ? messages.length : 0,
    baseMessages: baseSanitized.length,
    baseTokens,
    systemMessages: source.protectedPrefix.length,
    liveMessages: source.live.length,
    headMessages: source.live.length,
    tailMessages: volatileTail.length,
    mandatoryMessages: mandatory.length,
    finalMessages: result.length,
    systemTokens: safeEstimateMessagesTokens(source.protectedPrefix),
    liveTokens: safeEstimateMessagesTokens(source.live),
    headTokens: safeEstimateMessagesTokens(source.live),
    tailTokens: safeEstimateMessagesTokens(volatileTail),
    mandatoryCost,
    finalTokens,
    targetBudgetTokens: targetBudget,
    targetExceeded: finalTokens > targetBudget,
    stablePrefixTokens: safeEstimateMessagesTokens(stablePrefixMessages),
    volatileTailTokens: safeEstimateMessagesTokens(volatileTail),
    latestUserRetained: !!latestUser,
    activeTurnContinuation: !!activeTurnContinuation,
    retainedAssistantToolMessages: retainedTail.filter((message) => message.toolCalls?.length).length,
    retainedProviderReplayMessages: retainedTail.filter((message) => message.providerReplay).length,
    toolHistoryBudget: execution.toolBudget,
    restoredSkillBodies: restoredSkills.length,
    skillBodyBudget: skillBudget,
    skillBodyTokens: skillTokens,
    toolHistoryTokens: execution.toolTokens,
    omittedToolGroups: execution.omittedGroups || 0,
    budgetTokens: budget,
    remainingTokens: budget - mandatoryCost,
    handoffTokenCap: Number.isFinite(handoffTokenCap) && handoffTokenCap > 0 ? handoffTokenCap : null,
    handoffRoom,
    handoffChars: handoffText.length,
    handoffBytes: textByteLength(handoffText),
    summaryMessageChars: summaryContent.length,
    summaryMessageBytes: textByteLength(summaryContent),
    handoffEmpty: !handoffText,
    conversationPreserved: preserveConversation,
    handoffTruncatedInSummary: !!handoffText && !summaryContent.includes(handoffText),
    fileReattached: false,
    tailOptions: {
      latestActualUserOnly: execution.retainedGroups === 0,
      activeTurnContinuation: !!activeTurnContinuation,
    },
    durationMs: Date.now() - startedAt,
  };
  compactDebugLog('fresh-context result', diagnostics);
  return {
    messages: result,
    freshContext: true,
    query: opts.query || '',
    diagnostics,
  };
}
