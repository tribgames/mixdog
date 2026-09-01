// One Compact implementation:
//   1) optionally generate a bounded cumulative handoff;
//   2) rebuild a fresh provider context from protected session injection,
//      that handoff, a fixed ack, and the latest real user instruction.
import {
    estimateMessagesTokens,
    reconcileDedupStubs,
    sanitizeToolPairs,
} from '../context-utils.mjs';
import {
    SUMMARY_OUTPUT_TOKENS,
    compactDebugLog,
} from './constants.mjs';
import {
    redactToolCallSecretsInMessages,
    safeEstimateMessagesTokens,
    textByteLength,
} from './text-utils.mjs';
import {
    isSummaryMessage,
    latestActualUserInstructionMessage,
    splitProtectedContext,
} from './messages.mjs';
import { activeTurnContinuationMessage } from './continuation.mjs';
import { effectiveBudget } from './budget.mjs';
import {
    normalizeIngestRole,
    sessionMessageContentForIngest,
    shouldExcludeIngestMessage,
} from '../../../../memory/lib/session-ingest.mjs';
import { codexWireSendOpts } from '../manager/session-id.mjs';
import {
    COMPACTION_SYSTEM_PROMPT,
    enforceCompactSummarySchema,
    extractResponseText,
    fitCompactionPrompt,
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
    const sanitized = redactToolCallSecretsInMessages(
        reconcileDedupStubs(sanitizeToolPairs(messages)),
    );
    const { protectedPrefix, conversation } = splitProtectedContext(sanitized);
    let previousSummary = null;
    for (let index = conversation.length - 1; index >= 0; index -= 1) {
        if (isSummaryMessage(conversation[index])) {
            previousSummary = conversation[index].content;
            break;
        }
    }
    return {
        protectedPrefix,
        previousSummary,
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

export async function generateFreshHandoffSummary(provider, messages, model, budgetTokens, opts = {}) {
    if (!provider || typeof provider.send !== 'function') {
        throw new Error('generateFreshHandoffSummary: provider.send is required');
    }
    const startedAt = Date.now();
    const budget = effectiveBudget(budgetTokens, opts);
    const source = splitFreshSource(messages);
    const head = opts.filterOldHistoryForIngest === true
        ? pureConversationForHandoff(source.live)
        : source.live;
    if (head.length === 0 && !source.previousSummary) {
        throw new Error('generateFreshHandoffSummary: no compactable session history');
    }
    const promptInput = {
        head,
        tail: [],
        previousSummary: source.previousSummary,
        preservedFacts: null,
    };
    const callBudget = Math.max(
        1,
        Math.floor((opts.compactionInputBudgetTokens || budget) * COMPACTION_PROMPT_HEADROOM),
    );
    const prompt = fitCompactionPrompt(promptInput, callBudget);
    if (!prompt) {
        throw new Error(`generateFreshHandoffSummary: prompt cannot fit call budget=${callBudget}`);
    }
    const sendOpts = {
        ...(opts.sendOpts || {}),
        thinkingBudgetTokens: undefined,
        xaiReasoningEffort: undefined,
        reasoningEffort: undefined,
        effort: 'low',
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
        signal: combinedSignal(
            opts.signal || opts.sendOpts?.signal || null,
            opts.timeoutMs || 30_000,
        ),
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

    const response = await provider.send([
        { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
    ], model, undefined, sendOpts);
    const rawSummary = extractResponseText(response);
    if (!rawSummary) {
        throw new Error('generateFreshHandoffSummary: summary provider returned empty output');
    }
    const enforced = enforceCompactSummarySchema(rawSummary, { head, tail: [] });
    const summary = enforced.summary;
    const summaryMessage = fitGeneratedHandoffMessage(
        source.live,
        summary,
        budget,
        {
            provider: opts.providerName || provider.name || null,
            model,
        },
    );
    if (!summaryMessage) {
        throw new Error(`generateFreshHandoffSummary: summary cannot fit budget=${budget}`);
    }
    const resultMessages = sanitizeToolPairs([
        ...source.protectedPrefix,
        summaryMessage,
    ]);
    const diagnostics = {
        inputMessages: Array.isArray(messages) ? messages.length : 0,
        sourceMessages: source.live.length,
        handoffInputMessages: head.length,
        previousSummary: !!source.previousSummary,
        promptChars: prompt.length,
        promptBytes: textByteLength(prompt),
        promptTokens: safeEstimateMessagesTokens([
            { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
        ]),
        summaryChars: summary.length,
        rawSummaryChars: rawSummary.length,
        summaryRepaired: enforced.repaired === true,
        durationMs: Date.now() - startedAt,
    };
    compactDebugLog('fresh handoff generation', diagnostics);
    return {
        messages: resultMessages,
        usage: response?.usage || null,
        providerState: response?.providerState,
        handoffGenerated: true,
        summary,
        summaryRepaired: enforced.repaired === true,
        diagnostics,
    };
}

function prependLatestUserContext(message, prefix) {
    const text = String(prefix || '').trim();
    if (!message || !text) return message;
    const replacesGoalState = text.includes('<goal_state>');
    const stripPriorGoalState = (value) => (
        replacesGoalState
            ? String(value ?? '').replace(
                /<system-reminder>\s*<goal_state>[\s\S]*?<\/goal_state>\s*<\/system-reminder>\s*/gi,
                '',
            )
            : String(value ?? '')
    );
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
    const budget = effectiveBudget(budgetTokens, opts);
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
    if (source.live.length === 0 && !(handoffText || opts.allowEmptyHandoff === true)) {
        throw new Error('freshContextCompactMessages: no compactable session history');
    }
    const latestUser = prependLatestUserContext(
        latestActualUserInstructionMessage(source.live),
        opts.latestUserPrefix,
    );
    const activeTurnContinuation = latestUser && opts.activeTurn === true
        ? activeTurnContinuationMessage(source.live)
        : null;
    const stableAck = latestUser ? { role: 'assistant', content: '.' } : null;
    const volatileTail = [
        ...(latestUser ? [latestUser] : []),
        ...(activeTurnContinuation ? [activeTurnContinuation] : []),
    ];
    const mandatory = [
        ...source.protectedPrefix,
        ...(stableAck ? [stableAck] : []),
        ...volatileTail,
    ];
    const mandatoryCost = estimateMessagesTokens(mandatory);
    if (mandatoryCost >= budget) {
        throw new Error(
            `freshContextCompactMessages: mandatory session context/latest instruction exceeds compact budget=${budget} ` +
            `(mandatory=${mandatoryCost})`,
        );
    }
    if (!handoffText && opts.allowEmptyHandoff !== true) {
        throw new Error('freshContextCompactMessages: handoff text is empty');
    }
    const handoffRoomUncapped = budget - mandatoryCost;
    const handoffTokenCap = Number(opts.handoffTokenCap);
    const handoffRoom = Number.isFinite(handoffTokenCap) && handoffTokenCap > 0
        ? Math.min(handoffRoomUncapped, handoffTokenCap)
        : handoffRoomUncapped;
    const summaryMessage = fitFreshContextSummaryMessage(
        source.live,
        handoffText,
        handoffRoom,
    );
    if (!summaryMessage) {
        throw new Error(`freshContextCompactMessages: summary cannot fit remaining budget=${handoffRoom}`);
    }
    const summaryContent = String(summaryMessage.content || '');
    if (handoffText && !summaryContent.includes(handoffText)) {
        throw new Error(
            `freshContextCompactMessages: complete handoff exceeds the compact budget=${handoffRoom}; ` +
            'refusing to drop older context',
        );
    }
    const result = reconcileDedupStubs(sanitizeToolPairs([
        ...source.protectedPrefix,
        summaryMessage,
        ...(stableAck ? [stableAck] : []),
        ...volatileTail,
    ]));
    const finalTokens = estimateMessagesTokens(result);
    if (finalTokens > budget) {
        throw new Error(
            `freshContextCompactMessages: compacted result exceeds budget=${budget} (result=${finalTokens})`,
        );
    }
    const stablePrefixMessages = [
        ...source.protectedPrefix,
        summaryMessage,
        ...(stableAck ? [stableAck] : []),
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
        stablePrefixTokens: safeEstimateMessagesTokens(stablePrefixMessages),
        volatileTailTokens: safeEstimateMessagesTokens(volatileTail),
        latestUserRetained: !!latestUser,
        activeTurnContinuation: !!activeTurnContinuation,
        retainedAssistantToolMessages: 0,
        retainedProviderReplayMessages: 0,
        budgetTokens: budget,
        remainingTokens: budget - mandatoryCost,
        handoffTokenCap: Number.isFinite(handoffTokenCap) && handoffTokenCap > 0
            ? handoffTokenCap
            : null,
        handoffRoom,
        handoffChars: handoffText.length,
        handoffBytes: textByteLength(handoffText),
        summaryMessageChars: summaryContent.length,
        summaryMessageBytes: textByteLength(summaryContent),
        handoffEmpty: !handoffText,
        handoffTruncatedInSummary: !!handoffText && !summaryContent.includes(handoffText),
        fileReattached: false,
        tailOptions: {
            latestActualUserOnly: true,
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
