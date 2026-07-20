// Compaction window selection, recall-tail preservation, and the semantic +
// recall fast-track compaction entry points. Extracted verbatim from
// compact.mjs (behavior-preserving).
import {
    sanitizeToolPairs,
    dedupToolResultBodies,
    reconcileDedupStubs,
    estimateMessagesTokens,
    DEFAULT_COMPACTION_KEEP_TOKENS,
} from '../context-utils.mjs';
import {
    SUMMARY_OUTPUT_TOKENS,
    COMPACT_SUMMARY_MIN_ROOM_TOKENS,
    COMPACT_TYPE_SEMANTIC,
    COMPACT_TYPE_RECALL_FASTTRACK,
    compactDebugLog,
} from './constants.mjs';
import {
    extractText,
    safeEstimateMessagesTokens,
    textByteLength,
    messageContentHasMarker,
    redactToolCallSecretsInMessages,
} from './text-utils.mjs';
import {
    isSummaryMessage,
    splitProtectedContext,
} from './messages.mjs';
import {
    effectiveBudget,
    extractPreservedFacts,
    preserveRecentBudget,
} from './budget.mjs';
import {
    normalizeIngestRole,
    sessionMessageContentForIngest,
    shouldExcludeIngestMessage,
} from '../../../../memory/lib/session-ingest.mjs';
import { cleanMemoryText } from '../../../../memory/lib/memory-extraction.mjs';
import {
    COMPACTION_SYSTEM_PROMPT,
    fitCompactionPrompt,
    extractResponseText,
    enforceSemanticSummarySchema,
    fitSemanticSummaryMessage,
    fitRecallFastTrackSummaryMessage,
    stripNestedSummaryHeaderLines,
    RECALL_TAIL_TRUNCATION_MARKER,
    RECALL_TAIL_SHORT_TRUNCATION_MARKER,
} from './summary.mjs';
import { buildPostCompactFileAttachment } from './file-reattach.mjs';

// Post-compact file re-attachment (claude-code parity): re-inject fresh reads
// of files the summarized-away head was working with, when they still fit the
// budget. Applied identically by the semantic and recall-fasttrack paths.
// Follows the `Reference files:` + assistant `.` ack convention from
// session-lifecycle.mjs so provider turn alternation and ingest exclusion
// both hold. Best-effort: on any failure the plain result stands.
function withFileReattachment(result, finalTokens, budget, headMessages, tailMessages, cwd) {
    try {
        const attachment = buildPostCompactFileAttachment(
            headMessages,
            tailMessages,
            budget - finalTokens,
            { cwd },
        );
        if (!attachment) return { result, finalTokens, reattached: false };
        const summaryIdx = result.length - tailMessages.length;
        const augmented = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs([
            ...result.slice(0, summaryIdx),
            attachment,
            { role: 'assistant', content: '.' },
            ...result.slice(summaryIdx),
        ])));
        const augmentedTokens = estimateMessagesTokens(augmented);
        if (augmentedTokens > budget) return { result, finalTokens, reattached: false };
        return { result: augmented, finalTokens: augmentedTokens, reattached: true };
    } catch {
        return { result, finalTokens, reattached: false };
    }
}

const DEFAULT_TAIL_TURNS = 2;
const COMPACTION_PROMPT_HEADROOM = 0.85;

function userIndexes(messages) {
    const out = [];
    for (let i = 0; i < messages.length; i += 1) {
        if (messages[i]?.role === 'user') out.push(i);
    }
    return out;
}

function splitTailIntoTurns(messages) {
    const turns = [];
    let current = null;
    for (const m of messages) {
        if (isSummaryMessage(m)) continue;
        if (m?.role === 'user') {
            if (current) turns.push(current);
            current = [m];
        } else {
            if (!current) current = [];
            current.push(m);
        }
    }
    if (current && current.length) turns.push(current);
    return turns;
}

function indexLiveTurns(live) {
    const turns = splitTailIntoTurns(live);
    const indexed = [];
    let scan = 0;
    for (const messages of turns) {
        while (scan < live.length && live[scan] !== messages[0]) scan += 1;
        const start = scan;
        const end = start + messages.length;
        indexed.push({ start, end, messages });
        scan = end;
    }
    return indexed;
}

function splitTurnStartIndexForBudget(turn, budget) {
    const { start, end, messages } = turn;
    for (let i = 0; i < messages.length; i += 1) {
        // A tool result must stay paired with its preceding assistant tool_call,
        // so the preserved tail suffix can never begin at one (mirrors
        // findValidCutIndices). Skip tool-result boundaries; if no non-tool
        // suffix fits the budget, fall through to `end` so the caller keeps the
        // whole turn in the head for summarization instead of orphaning it.
        if (messages[i]?.role === 'tool') continue;
        const suffixStart = start + i;
        const suffix = messages.slice(i);
        if (suffix.length > 0 && estimateMessagesTokens(suffix) <= budget) {
            return suffixStart;
        }
    }
    return end;
}

function splitLiveCompactionContext(messages) {
    const sanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    const { protectedPrefix, conversation: nonSystem } = splitProtectedContext(sanitized);
    let previousSummary = null;
    for (let i = nonSystem.length - 1; i >= 0; i -= 1) {
        if (isSummaryMessage(nonSystem[i])) {
            previousSummary = nonSystem[i].content;
            break;
        }
    }
    const live = nonSystem.filter((m) => !isSummaryMessage(m));
    return { system: protectedPrefix, live, previousSummary, sanitized };
}

// Shape ONLY the older history selected for semantic summarization through the
// exact pure-conversation pipeline used by Memory ingest_session. System rules
// and the recent preserved tail are split before this runs and therefore remain
// structurally intact; old developer/tool rows, synthetic runtime injections,
// tool-call metadata, and reminder blocks cannot enter the summary prompt.
function filterOldHistoryForMemoryIngest(messages) {
    const out = [];
    for (const m of messages || []) {
        if (!m || typeof m !== 'object') continue;
        const role = normalizeIngestRole(m.role);
        if (!role || shouldExcludeIngestMessage(m)) continue;
        const content = cleanMemoryText(sessionMessageContentForIngest(m));
        if (!content || !content.trim()) continue;
        out.push({ role, content });
    }
    return out;
}

// A tail may begin ONLY at an index that is not a tool result: a tool result
// must stay paired with the assistant tool_call that precedes it, so it can
// never be the first message of the preserved tail. Every other role (user /
// assistant / developer / ...) is a valid tail boundary. This replaces the old
// "the tail must begin at a real user turn" rule, which threw whenever the
// recent window carried no user message (single-turn agent sessions whose tail
// is assistant/tool only).
function findValidCutIndices(live) {
    const out = [];
    for (let i = 0; i < live.length; i += 1) {
        if (live[i]?.role === 'tool') continue;
        out.push(i);
    }
    return out;
}

// User-anchored path (unchanged behaviour): keep up to tailTurns recent turns
// bounded by recentBudget, splitting the newest turn's suffix when it alone is
// too large. Preserved verbatim so Lead / normal sessions with real user turns
// compact exactly as before.
function selectTailStartByTurns(live, recentBudget, tailTurns, previousSummary, opts) {
    const indexedTurns = indexLiveTurns(live);
    if (indexedTurns.length === 0) return live.length;

    let tailStartIdx = live.length;
    let keptTurns = 0;

    for (let t = indexedTurns.length - 1; t >= 0; t -= 1) {
        if (keptTurns >= tailTurns) break;
        const turn = indexedTurns[t];
        const tailFromTurn = live.slice(turn.start);
        if (keptTurns === 0) {
            if (estimateMessagesTokens(tailFromTurn) <= recentBudget) {
                tailStartIdx = turn.start;
                keptTurns += 1;
                continue;
            }
            const splitIdx = splitTurnStartIndexForBudget(turn, recentBudget);
            if (splitIdx < turn.end) {
                tailStartIdx = splitIdx;
                keptTurns += 1;
                break;
            }
            // Newest turn has no fitting suffix: keep entire live transcript in head for summarization.
            tailStartIdx = live.length;
            keptTurns = 0;
            break;
        }
        const candidateStart = turn.start;
        const candidateTail = live.slice(candidateStart);
        if (estimateMessagesTokens(candidateTail) <= recentBudget) {
            tailStartIdx = candidateStart;
            keptTurns += 1;
            continue;
        }
        break;
    }

    if (opts.force === true && !previousSummary && tailStartIdx <= 0) {
        if (indexedTurns.length >= 2) {
            tailStartIdx = indexedTurns[1].start;
        } else if (indexedTurns.length === 1) {
            const onlyTurn = indexedTurns[0];
            const splitIdx = splitTurnStartIndexForBudget(onlyTurn, recentBudget);
            if (splitIdx > onlyTurn.start && splitIdx < onlyTurn.end) {
                tailStartIdx = splitIdx;
            } else if (onlyTurn.end > onlyTurn.start + 1) {
                tailStartIdx = onlyTurn.start + 1;
            }
        }
    }
    return tailStartIdx;
}

// No-user path: pick the tail boundary from valid cut points. Walk newest ->
// oldest, growing the tail across valid cut points while its suffix still fits
// recentBudget, and stop before it overflows. Never anchors on a user turn, so
// an assistant/tool-only single-turn transcript still yields a head to
// summarize and a paired tail to keep.
function selectTailStartByCutPoint(live, recentBudget, previousSummary) {
    const validCuts = findValidCutIndices(live);
    if (validCuts.length === 0) return live.length; // degenerate: only tool results

    let chosen = null;
    for (let k = validCuts.length - 1; k >= 0; k -= 1) {
        const idx = validCuts[k];
        if (estimateMessagesTokens(live.slice(idx)) <= recentBudget) {
            chosen = idx; // fits — try to grow the tail toward an older cut
            continue;
        }
        break; // this cut overflows recentBudget; keep the previous (newer) choice
    }

    if (chosen === null) {
        // Even the newest valid cut's suffix exceeds recentBudget (a single huge
        // message run). Keep the minimal tail from the newest valid cut so a head
        // remains to summarize; if that cut is at index 0 there is nothing to
        // split off, so keep everything in the head instead. The oversized tail
        // is tolerated downstream (mandatory-cost budget raise) rather than
        // throwing.
        const newestCut = validCuts[validCuts.length - 1];
        return newestCut > 0 ? newestCut : live.length;
    }

    if (chosen <= 0) {
        // Whole transcript would become the tail => nothing to compact. With no
        // prior summary to build on, pull the tail start forward to the next
        // valid cut so the leading message(s) become the compactable head.
        if (!previousSummary && validCuts.length >= 2) return validCuts[1];
        // Only ONE valid cut (or a leading tool run before it) and no prior
        // summary: there is no older cut to pull forward to. Returning 0 would
        // make the whole transcript the tail with an empty head, and
        // semanticCompactMessages throws on head.length===0 && !previousSummary.
        // Keep everything in the HEAD instead (empty tail) so a head remains to
        // summarize; an empty tail is valid downstream (mandatory = system+tail).
        if (!previousSummary && validCuts.length < 2) return live.length;
        return chosen;
    }
    return chosen;
}

function selectCompactionWindow(messages, budget, opts = {}) {
    const { system, live, previousSummary } = splitLiveCompactionContext(messages);
    const tailTurns = Math.max(1, Number(opts.tailTurns) || DEFAULT_TAIL_TURNS);
    const recentBudget = preserveRecentBudget(budget, opts);

    const tailStartIdx = userIndexes(live).length
        ? selectTailStartByTurns(live, recentBudget, tailTurns, previousSummary, opts)
        : selectTailStartByCutPoint(live, recentBudget, previousSummary);

    const head = live.slice(0, tailStartIdx);
    let tail = live.slice(tailStartIdx);
    // sanitizeToolPairs/dedup/reconcile repairs any orphan tool_result the cut
    // may have left; because valid cut points never start on a tool result, an
    // assistant tool_call and its trailing tool_results always land on the same
    // side of the boundary, so pairing stays provider-valid.
    tail = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(tail)));

    // Only a genuinely empty live window is unrecoverable. Absence of a user
    // turn in the tail is no longer an error.
    if (!head.length && !tail.length) {
        throw new Error('semanticCompactMessages: nothing to compact (empty live window)');
    }

    const preservedFacts = extractPreservedFacts(head);
    const originalHead = head;
    return {
        system,
        head,
        tail,
        previousSummary,
        originalHead,
        preservedFacts,
    };
}

function combinedSignal(parent, timeoutMs) {
    const ms = Number(timeoutMs);
    if (!Number.isFinite(ms) || ms <= 0) return parent || undefined;
    const timeout = AbortSignal.timeout(Math.floor(ms));
    if (parent && typeof AbortSignal.any === 'function') return AbortSignal.any([parent, timeout]);
    return timeout;
}

export async function semanticCompactMessages(provider, messages, model, budgetTokens, opts = {}) {
    if (!provider || typeof provider.send !== 'function') {
        throw new Error('semanticCompactMessages: provider.send is required');
    }
    const startedAt = Date.now();
    let budget = effectiveBudget(budgetTokens, opts);
    const baseSanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    const baseTokens = safeEstimateMessagesTokens(baseSanitized);
    // No-op fast path: if the original sanitized transcript already fits and we
    // are not forced, return it UNCHANGED (no preserved-tail redaction applied)
    // to keep prior no-compaction semantics.
    if (baseTokens != null && baseTokens <= budget && opts.force !== true) {
        return {
            messages: baseSanitized,
            usage: null,
            semantic: false,
            compactType: COMPACT_TYPE_SEMANTIC,
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
    // Compaction will proceed: redact sensitive tool-call argument VALUES before
    // window selection so the preserved tail/system that survive verbatim are
    // measured AND emitted in their redacted form. Head prompt normalizers
    // (toolCallSummary/normalizeToolArgValue) still apply on top for the
    // summarized head. Redaction is shape-preserving, so tool-pair structure
    // stays provider-valid.
    const sanitized = redactToolCallSecretsInMessages(baseSanitized);

    const selectedRaw = selectCompactionWindow(sanitized, budget, opts);
    const headFilterApplied = opts.filterOldHistoryForIngest === true;
    const summaryHead = headFilterApplied
        ? filterOldHistoryForMemoryIngest(selectedRaw.head)
        : selectedRaw.head;
    const selected = headFilterApplied
        ? {
            ...selectedRaw,
            head: summaryHead,
            originalHead: summaryHead,
            preservedFacts: extractPreservedFacts(summaryHead),
        }
        : selectedRaw;
    if (selected.head.length === 0 && !selected.previousSummary) {
        throw new Error('semanticCompactMessages: no compactable prior history before preserved tail');
    }

    const mandatory = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs([...selected.system, ...selected.tail])));
    const mandatoryCost = estimateMessagesTokens(mandatory);
    const originalBudget = budget;
    // The preserved tail is kept verbatim and the head is replaced by a much
    // smaller summary, so the compacted result is always smaller than the
    // input regardless of how the configured target budget compares to the
    // mandatory cost. When the budget cannot even hold what we must keep, raise
    // it to fit (mandatory + summary room) rather than refusing — a refusal
    // here was the source of auto-clear / overflow compact failures.
    if (mandatoryCost + COMPACT_SUMMARY_MIN_ROOM_TOKENS > budget) {
        budget = mandatoryCost + COMPACT_SUMMARY_MIN_ROOM_TOKENS;
    }
    const budgetRaisedBy = Math.max(0, budget - originalBudget);

    const callBudget = Math.max(1, Math.floor((opts.compactionInputBudgetTokens || budget) * COMPACTION_PROMPT_HEADROOM));
    const prompt = fitCompactionPrompt(selected, callBudget);
    if (!prompt) {
        throw new Error(`semanticCompactMessages: compaction prompt cannot fit call budget=${callBudget}`);
    }
    const compactModel = model;
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
        signal: combinedSignal(opts.signal || opts.sendOpts?.signal || null, opts.timeoutMs || 30_000),
    };
    if (opts.sessionId) sendOpts.sessionId = `${opts.sessionId}:compact`;
    if (opts.promptCacheKey || opts.sendOpts?.promptCacheKey) {
        sendOpts.promptCacheKey = `${opts.promptCacheKey || opts.sendOpts.promptCacheKey}:compact`;
    }
    if (opts.providerCacheKey || opts.sendOpts?.providerCacheKey) {
        sendOpts.providerCacheKey = `${opts.providerCacheKey || opts.sendOpts.providerCacheKey}:compact`;
    }

    const response = await provider.send([
        { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
    ], compactModel, undefined, sendOpts);
    const rawSummary = extractResponseText(response);
    if (!rawSummary) throw new Error('semanticCompactMessages: compaction agent returned empty summary');
    // Lightweight schema enforcement: a non-empty but malformed provider
    // response (missing the required template sections) is deterministically
    // repaired into the structured anchored shape rather than injected blindly.
    const enforced = enforceSemanticSummarySchema(rawSummary, { head: selected.head, tail: selected.tail });
    const summary = enforced.summary;

    const oldHistory = selected.originalHead;
    const semanticMeta = {
        provider: opts.providerName || provider.name || null,
        model: compactModel,
    };
    const summaryMessage = fitSemanticSummaryMessage(oldHistory, summary, budget - mandatoryCost, semanticMeta, selected.preservedFacts);
    if (!summaryMessage) {
        throw new Error(`semanticCompactMessages: summary cannot fit remaining budget=${budget - mandatoryCost}`);
    }

    // selected.system / selected.tail already carry redacted tool-call args
    // (sanitized was redacted before window selection), so the preserved tail
    // is both measured and emitted in redacted form.
    let result = sanitizeToolPairs([...selected.system, summaryMessage, ...selected.tail]);
    result = reconcileDedupStubs(dedupToolResultBodies(result));
    let finalTokens = estimateMessagesTokens(result);
    if (finalTokens > budget) {
        throw new Error(`semanticCompactMessages: compacted result exceeds budget=${budget} (result=${finalTokens})`);
    }
    // Re-attach fresh reads of head files. Uses the RAW (pre-ingest-filter)
    // head so tool_call read paths are visible even on the /compact path.
    const reattach = withFileReattachment(result, finalTokens, budget, selectedRaw.head, selected.tail, opts.cwd);
    result = reattach.result;
    finalTokens = reattach.finalTokens;
    const diagnostics = {
        noOp: false,
        inputMessages: Array.isArray(messages) ? messages.length : 0,
        baseMessages: baseSanitized.length,
        baseTokens,
        systemMessages: selected.system.length,
        headMessages: selected.head.length,
        sourceHeadMessages: selectedRaw.head.length,
        headFilterApplied,
        headFilterRemovedMessages: selectedRaw.head.length - selected.head.length,
        originalHeadMessages: selected.originalHead.length,
        tailMessages: selected.tail.length,
        mandatoryMessages: mandatory.length,
        finalMessages: result.length,
        systemTokens: safeEstimateMessagesTokens(selected.system),
        headTokens: safeEstimateMessagesTokens(selected.head),
        tailTokens: safeEstimateMessagesTokens(selected.tail),
        mandatoryCost,
        finalTokens,
        originalBudgetTokens: originalBudget,
        budgetTokens: budget,
        budgetRaised: budgetRaisedBy > 0,
        budgetRaisedBy,
        remainingTokens: budget - mandatoryCost,
        callBudgetTokens: callBudget,
        promptChars: String(prompt || '').length,
        promptBytes: textByteLength(prompt),
        promptTokens: safeEstimateMessagesTokens([
            { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
        ]),
        summaryChars: String(summary || '').length,
        rawSummaryChars: String(rawSummary || '').length,
        summaryRepaired: enforced.repaired === true,
        fileReattached: reattach.reattached,
        previousSummary: !!selected.previousSummary,
        durationMs: Date.now() - startedAt,
    };
    compactDebugLog('semantic result', diagnostics);
    return {
        messages: result,
        usage: response?.usage || null,
        providerState: response?.providerState,
        semantic: true,
        compactType: COMPACT_TYPE_SEMANTIC,
        summary,
        summaryRepaired: enforced.repaired === true,
        diagnostics,
    };
}

export function recallFastTrackCompactMessages(messages, budgetTokens, opts = {}) {
    return _recallFastTrackCompactMessages(messages, budgetTokens, opts);
}

// Recall fast-track (type 2) tail policy: preserve the most recent turns of the
// live conversation VERBATIM and STRUCTURED, keeping role semantics for
// user / assistant / tool / system / developer instead of collapsing the tail
// to user-only. The chunk summary anchors older history; the preserved tail
// keeps recent assistant reasoning, tool_calls, and tool_results so fresh
// state is not silently dropped.
//
// Turns are anchored on user-role boundaries: each turn = a user message plus
// the assistant/tool/system/developer messages that follow it (a leading run of
// non-user messages before the first user boundary is treated as its own
// partial turn so nothing is lost). We keep the newest RECALL_TAIL_USER_MAX
// turns; if the kept set exceeds RECALL_TAIL_TOKEN_CAP we drop whole oldest
// turns first, then middle-truncate the oldest surviving messages' string
// content so the set fits while leaving the newest message whole.
//
// Partial tool_call/tool_result pairs that truncation might leave behind are
// repaired by sanitizeToolPairs/reconcileDedupStubs in the caller, so pairing
// stays valid even after trimming.
const RECALL_TAIL_USER_MAX = 2;
const RECALL_TAIL_TOKEN_CAP = DEFAULT_COMPACTION_KEEP_TOKENS; // 8k
// A caller may request a cap smaller than one structurally valid message. Keep
// the cap strict above this unavoidable floor while retaining a real anchor.
const RECALL_TAIL_MIN_STRUCTURAL_TOKENS = estimateMessagesTokens([{
    role: 'user',
    content: RECALL_TAIL_SHORT_TRUNCATION_MARKER,
}]);

function truncateMessageForRecallTail(text, maxChars) {
    const marker = RECALL_TAIL_TRUNCATION_MARKER;
    const value = String(text ?? '').replace(/\r\n/g, '\n');
    if (value.length <= maxChars) return value;
    if (maxChars <= 0) return RECALL_TAIL_SHORT_TRUNCATION_MARKER;
    if (maxChars < marker.length) return RECALL_TAIL_SHORT_TRUNCATION_MARKER;
    const room = maxChars - marker.length;
    const head = Math.ceil(room * 0.35);
    const tailPart = Math.floor(room * 0.65);
    return `${value.slice(0, head)}${marker}${value.slice(value.length - tailPart)}`;
}

function withoutRecallReplayMetadata(message) {
    const copy = { ...(message || {}) };
    delete copy.providerMetadata;
    delete copy.thinkingBlocks;
    delete copy.reasoningItems;
    delete copy.reasoningContent;
    delete copy.assistantBlocks;
    return copy;
}

function fitRecallMessageToCap(message, cap, rawText = null) {
    const text = rawText == null
        ? (typeof message?.content === 'string' ? message.content : extractText(message))
        : String(rawText);
    for (const base of [message, withoutRecallReplayMetadata(message)]) {
        if (!base || typeof base !== 'object') continue;
        if (estimateMessagesTokens([{ ...base, content: text }]) <= cap) {
            return { ...base, content: text };
        }
        let lo = 0;
        let hi = text.length;
        let best = null;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const candidate = {
                ...base,
                content: truncateMessageForRecallTail(text, mid),
            };
            if (estimateMessagesTokens([candidate]) <= cap) {
                best = candidate;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if (best) return best;
    }
    return null;
}

function fitRecallUserMessageToCap(userMsg, cap) {
    return fitRecallMessageToCap(userMsg, cap);
}

function fitSingleRecallTurnToCap(turn, cap) {
    const userIdx = turn.findIndex((m) => m?.role === 'user');
    if (userIdx < 0) {
        return truncateTailToCap(turn, cap);
    }
    const userMsg = turn[userIdx];
    const following = turn.slice(userIdx + 1);
    const fittedUser = fitRecallUserMessageToCap(userMsg, cap);
    if (!fittedUser) return truncateTailToCap(following, cap);
    let out = [fittedUser];
    for (const m of following) {
        const candidate = [...out, m];
        if (estimateMessagesTokens(candidate) <= cap) out.push(m);
    }
    return reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(out)));
}

function truncateTailToCap(messages, cap) {
    const turn = Array.isArray(messages) ? messages : [];
    if (turn.length === 0) return [];
    // No user anchor in this turn: keep the NEWEST messages that fit `cap`,
    // walking backward. (Previously this delegated back to
    // fitSingleRecallTurnToCap, which re-entered here on a no-user turn —
    // infinite mutual recursion. Unreachable while a no-user tail threw upstream;
    // now that a no-user tail is allowed, this path must terminate on its own.)
    let out = [];
    let startIdx = turn.length; // index in `turn` where `out` begins
    for (let i = turn.length - 1; i >= 0; i -= 1) {
        const candidate = [turn[i], ...out];
        if (estimateMessagesTokens(candidate) <= cap) {
            out = candidate;
            startIdx = i;
            continue;
        }
        if (out.length === 0) {
            // Even the newest single message exceeds cap: middle-truncate its
            // string content so at least one message survives.
            const fitted = fitRecallMessageToCap(turn[i], cap);
            if (fitted) {
                out = [fitted];
                startIdx = i;
            }
        }
        break;
    }
    // A leading tool_result with no preceding assistant tool_call is an orphan
    // that sanitizeToolPairs drops — which could empty the whole tail. Extend the
    // window backward to swallow the preceding non-tool boundary (the assistant
    // that owns the tool_call), so the pair survives sanitize. Bounded by
    // startIdx so it always terminates.
    while (startIdx > 0 && out[0]?.role === 'tool') {
        startIdx -= 1;
        out = [turn[startIdx], ...out];
    }
    let sanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(out)));
    // Final guard: if sanitize still emptied the tail but the turn has a non-tool
    // message, rebuild from the newest non-tool message forward so the tail is
    // never empty when preservable content exists.
    if (sanitized.length === 0) {
        let nt = -1;
        for (let i = turn.length - 1; i >= 0; i -= 1) {
            if (turn[i]?.role !== 'tool') { nt = i; break; }
        }
        if (nt >= 0) {
            sanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(turn.slice(nt))));
        }
    }
    return estimateMessagesTokens(sanitized) <= cap ? sanitized : [];
}

function splitRecallFitInputs(recallText, previousSummary) {
    return {
        recall: String(recallText || '').trim(),
        prior: previousSummary ? stripNestedSummaryHeaderLines(previousSummary) : '',
    };
}

function recallTailStartIndex(live, tail) {
    if (!tail.length) return live.length;
    const first = tail[0];
    const idx = live.indexOf(first);
    if (idx >= 0) return idx;
    return Math.max(0, live.length - tail.length);
}

function selectRecallPreservedTail(live, opts = {}) {
    const msgs = (Array.isArray(live) ? live : []).filter((m) => m && !isSummaryMessage(m));
    if (msgs.length === 0) return { tail: [], head: [], tailStartIdx: 0 };
    const maxTurns = Math.max(1, Number(opts.maxUsers) || RECALL_TAIL_USER_MAX);
    const cap = Math.max(
        RECALL_TAIL_MIN_STRUCTURAL_TOKENS,
        Number(opts.tokenCap) || RECALL_TAIL_TOKEN_CAP,
    );
    const turns = splitTailIntoTurns(msgs);
    if (turns.length === 0) return { tail: [], head: msgs, tailStartIdx: 0 };

    let kept = turns.slice(-maxTurns);
    while (kept.length > 1 && estimateMessagesTokens(kept.flat()) > cap) {
        kept = kept.slice(1);
    }

    let tail;
    if (estimateMessagesTokens(kept.flat()) <= cap) {
        tail = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(kept.flat())));
    } else {
        tail = fitSingleRecallTurnToCap(kept[kept.length - 1], cap);
    }
    if (estimateMessagesTokens(tail) > cap) tail = truncateTailToCap(tail, cap);

    // A no-user tail is valid: a single-turn agent session may keep only
    // assistant/tool structure recently. Mirror the semantic cut-point model —
    // preserve the recent structured turn(s) verbatim without demanding a user
    // anchor rather than throwing. tool-pairing is already reconciled above.
    const tailStartIdx = recallTailStartIndex(msgs, tail);
    const head = msgs.slice(0, tailStartIdx);
    return { tail, head, tailStartIdx };
}

function _recallFastTrackCompactMessages(messages, budgetTokens, opts = {}) {
    const startedAt = Date.now();
    let budget = effectiveBudget(budgetTokens, opts);
    const baseSanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    const baseTokens = safeEstimateMessagesTokens(baseSanitized);
    if (baseTokens != null && baseTokens <= budget && opts.force !== true) {
        return {
            messages: baseSanitized,
            recallFastTrack: false,
            compactType: COMPACT_TYPE_RECALL_FASTTRACK,
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
    const sanitized = redactToolCallSecretsInMessages(baseSanitized);

    const { system: safeSystem, live, previousSummary } = splitLiveCompactionContext(sanitized);
    const recallTailOpts = {
        maxUsers: opts.recallTailMaxUsers ?? opts.tailTurns ?? RECALL_TAIL_USER_MAX,
        tokenCap: opts.recallTailTokenCap ?? preserveRecentBudget(budget, opts),
    };
    const { tail: recallTail, head: recallHead } = selectRecallPreservedTail(live, recallTailOpts);
    const recallFit = splitRecallFitInputs(opts.recallText, previousSummary);
    if (recallHead.length === 0 && !previousSummary
        && !(recallFit.recall || recallFit.prior || opts.allowEmptyRecall === true)) {
        throw new Error('recallFastTrackCompactMessages: no compactable prior history before preserved tail');
    }

    const mandatory = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs([...safeSystem, ...recallTail])));
    const mandatoryCost = estimateMessagesTokens(mandatory);
    const originalBudget = budget;
    if (mandatoryCost + COMPACT_SUMMARY_MIN_ROOM_TOKENS > budget) {
        budget = mandatoryCost + COMPACT_SUMMARY_MIN_ROOM_TOKENS;
    }
    const budgetRaisedBy = Math.max(0, budget - originalBudget);

    if (!recallFit.recall && !recallFit.prior && opts.allowEmptyRecall !== true) {
        throw new Error('recallFastTrackCompactMessages: recall text is empty');
    }
    const oldHistory = recallHead;
    const recallMeta = {
        querySha: opts.querySha || null,
    };
    // Recall injection room is capped separately from the mandatory
    // (system + preserved tail) budget: recall text never gets more than
    // opts.recallTokenCap (10% of context window, floor 2048 tokens, set by
    // the caller); the remaining budget stays reserved for live
    // conversation. Only applied when the cap is a positive finite number,
    // preserving current uncapped behavior otherwise.
    const recallRoomUncapped = budget - mandatoryCost;
    const recallTokenCap = Number(opts.recallTokenCap);
    const recallRoom = (Number.isFinite(recallTokenCap) && recallTokenCap > 0)
        ? Math.min(recallRoomUncapped, recallTokenCap)
        : recallRoomUncapped;
    const summaryMessage = fitRecallFastTrackSummaryMessage(
        oldHistory,
        recallFit.recall,
        recallRoom,
        recallMeta,
        recallFit.prior,
    );
    if (!summaryMessage) {
        throw new Error(`recallFastTrackCompactMessages: summary cannot fit remaining budget=${recallRoom}`);
    }

    let result = sanitizeToolPairs([...safeSystem, summaryMessage, ...recallTail]);
    result = reconcileDedupStubs(dedupToolResultBodies(result));
    let finalTokens = estimateMessagesTokens(result);
    if (finalTokens > budget) {
        throw new Error(`recallFastTrackCompactMessages: compacted result exceeds budget=${budget} (result=${finalTokens})`);
    }
    const reattach = withFileReattachment(result, finalTokens, budget, recallHead, recallTail, opts.cwd);
    result = reattach.result;
    finalTokens = reattach.finalTokens;
    const summaryContent = String(summaryMessage?.content || '');
    const diagnostics = {
        noOp: false,
        inputMessages: Array.isArray(messages) ? messages.length : 0,
        baseMessages: baseSanitized.length,
        baseTokens,
        systemMessages: safeSystem.length,
        liveMessages: live.length,
        headMessages: recallHead.length,
        tailMessages: recallTail.length,
        mandatoryMessages: mandatory.length,
        finalMessages: result.length,
        systemTokens: safeEstimateMessagesTokens(safeSystem),
        liveTokens: safeEstimateMessagesTokens(live),
        headTokens: safeEstimateMessagesTokens(recallHead),
        tailTokens: safeEstimateMessagesTokens(recallTail),
        mandatoryCost,
        finalTokens,
        originalBudgetTokens: originalBudget,
        budgetTokens: budget,
        budgetRaised: budgetRaisedBy > 0,
        budgetRaisedBy,
        remainingTokens: budget - mandatoryCost,
        recallTokenCap: (Number.isFinite(recallTokenCap) && recallTokenCap > 0) ? recallTokenCap : null,
        recallRoom,
        recallChars: recallFit.recall.length,
        recallBytes: textByteLength(recallFit.recall),
        priorChars: recallFit.prior.length,
        priorBytes: textByteLength(recallFit.prior),
        summaryMessageChars: summaryContent.length,
        summaryMessageBytes: textByteLength(summaryContent),
        recallEmpty: !recallFit.recall,
        priorEmpty: !recallFit.prior,
        recallTruncatedInSummary: !!recallFit.recall && !summaryContent.includes(recallFit.recall),
        priorTruncatedInSummary: !!recallFit.prior && !summaryContent.includes(recallFit.prior),
        tailTruncated: recallTail.some((m) => messageContentHasMarker(m, RECALL_TAIL_TRUNCATION_MARKER) || messageContentHasMarker(m, RECALL_TAIL_SHORT_TRUNCATION_MARKER)),
        fileReattached: reattach.reattached,
        tailOptions: recallTailOpts,
        previousSummary: !!previousSummary,
        durationMs: Date.now() - startedAt,
    };
    compactDebugLog('recall-fasttrack result', diagnostics);
    return {
        messages: result,
        recallFastTrack: true,
        compactType: COMPACT_TYPE_RECALL_FASTTRACK,
        query: opts.query || '',
        diagnostics,
    };
}
