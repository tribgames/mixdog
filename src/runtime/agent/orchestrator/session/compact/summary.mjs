// Handoff summarization, schema validation/repair, and fresh-context
// summary-message fitting.
import { estimateMessagesTokens } from '../context-utils.mjs';
import {
    SUMMARY_PREFIX,
    SUMMARY_PREFIX_ANCHOR,
} from './constants.mjs';
import {
    extractText,
    truncateMiddle,
    toolCallSummary,
    toolCallArgBudget,
    toolResultId,
} from './text-utils.mjs';
import {
    compactHeader,
    makeSummaryMessage,
    isProtectedContextUserMessage,
    isInjectedSkillBodyMessage,
} from './messages.mjs';
import {
    summaryIsSchemaValid,
    summaryHasUnrecognizedHeadings,
    repairCompactSummary,
    minimalSchemaSummary,
    truncateSummaryBySections,
} from './summary-schema.mjs';

export { repairCompactSummary } from './summary-schema.mjs';

const COMPACTION_INPUT_MAX_CHARS = 2_000;

export const COMPACTION_SYSTEM_PROMPT = [
    'You are an anchored context summarization assistant for coding sessions.',
    '',
    'Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.',
    '',
    'If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it with the new history by preserving still-true details, removing stale details, and merging in new facts.',
    '',
    'Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.',
    '',
    'Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.',
].join('\n');
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Use the same language as the active user thread when it is clear.
- Do not mention the summary process or that context was compacted.`;

function transcriptLineForCompaction(m, index, perMessageChars) {
    const role = m?.role || 'unknown';
    const text = truncateMiddle(extractText(m).trim(), perMessageChars);
    const meta = `${toolCallSummary(m, toolCallArgBudget(perMessageChars))}${toolResultId(m)}`;
    if (!text) return `${index + 1}. ${role}${meta}`;
    return `${index + 1}. ${role}${meta}:\n${text}`;
}

function buildCompactionPrompt({ head, previousSummary, preservedFacts }, perMessageChars) {
    const lines = [
        previousSummary
            ? 'Update the anchored summary below using the conversation history that follows. Preserve still-true details, remove stale details, and merge in the new facts.'
            : 'Create a new anchored summary from the conversation history below.',
        SUMMARY_TEMPLATE,
    ];
    if (previousSummary) {
        lines.push('', '<previous-summary>', previousSummary, '</previous-summary>');
    }
    if (preservedFacts) {
        lines.push('', '<preserved-facts>', preservedFacts, '</preserved-facts>');
    }
    lines.push('', '<conversation-history>');
    if (head.length === 0) {
        lines.push('[No additional older messages before the preserved recent tail.]');
    } else {
        for (let i = 0; i < head.length; i += 1) {
            lines.push(transcriptLineForCompaction(head[i], i, perMessageChars));
        }
    }
    lines.push('</conversation-history>');
    return lines.join('\n');
}

function estimateCompactionPromptTokens(input, perMessageChars) {
    const prompt = buildCompactionPrompt(input, perMessageChars);
    return estimateMessagesTokens([
        { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
    ]);
}

function previousSummaryBodyForCompactionPrompt(previousSummary) {
    const text = String(previousSummary || '');
    if (!text.trim()) return '';
    return stripNestedSummaryHeaderLines(text);
}

function priorSummaryNeedsNormalization(text) {
    const body = String(text || '');
    if (!body.trim()) return false;
    if (!/^##\s+/m.test(body)) return true;
    if (!summaryIsSchemaValid(body)) return true;
    return summaryHasUnrecognizedHeadings(body);
}

function normalizePriorSummaryForCompactionPrompt(fullBody) {
    const text = String(fullBody || '');
    if (!text.trim()) return '';
    if (!priorSummaryNeedsNormalization(text)) return text;
    return repairCompactSummary(text, { head: [], tail: [] });
}

// Shrink or drop a prior anchored summary so the compaction provider prompt fits
// the call budget. Unstructured/legacy priors are repaired first; section
// anchors are preserved via truncateSummaryBySections;
// the last resort is omitting <previous-summary> entirely.
function fitPreviousSummaryForCompactionPrompt(input, perMessageChars, targetTokens) {
    if (!input?.previousSummary) return input;
    const fullBody = normalizePriorSummaryForCompactionPrompt(
        previousSummaryBodyForCompactionPrompt(input.previousSummary),
    );
    const withSummary = (summaryText) => {
        const value = String(summaryText || '');
        if (!value.trim()) return { ...input, previousSummary: null };
        return { ...input, previousSummary: value };
    };

    if (estimateCompactionPromptTokens(withSummary(fullBody), perMessageChars) <= targetTokens) {
        return withSummary(fullBody);
    }

    if (fullBody) {
        let lo = 0;
        let hi = fullBody.length;
        let bestChars = -1;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const truncated = truncateSummaryBySections(fullBody, mid);
            const candidate = withSummary(truncated);
            if (estimateCompactionPromptTokens(candidate, perMessageChars) <= targetTokens) {
                bestChars = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if (bestChars >= 0) {
            return withSummary(truncateSummaryBySections(fullBody, bestChars));
        }
    }

    const minimalPrior = minimalSchemaSummary();
    if (estimateCompactionPromptTokens(withSummary(minimalPrior), perMessageChars) <= targetTokens) {
        return withSummary(minimalPrior);
    }

    const withoutPrior = withSummary(null);
    if (estimateCompactionPromptTokens(withoutPrior, perMessageChars) <= targetTokens) {
        return withoutPrior;
    }

    return null;
}

export function fitCompactionPrompt(input, targetTokens) {
    const tryFit = (withFacts) => {
        const baseInp = withFacts ? input : { ...input, preservedFacts: null };

        const fitAt = (perMessageChars) => {
            let inp = baseInp;
            if (estimateCompactionPromptTokens(inp, perMessageChars) > targetTokens) {
                const fitted = fitPreviousSummaryForCompactionPrompt(inp, perMessageChars, targetTokens);
                if (!fitted) return null;
                inp = fitted;
                if (estimateCompactionPromptTokens(inp, perMessageChars) > targetTokens) return null;
            }
            return buildCompactionPrompt(inp, perMessageChars);
        };

        const minimalPrompt = fitAt(0);
        if (!minimalPrompt) return null;

        let maxText = 0;
        for (const m of baseInp.head) maxText = Math.max(maxText, extractText(m).length);
        let lo = 0;
        let hi = Math.min(COMPACTION_INPUT_MAX_CHARS, Math.max(maxText, 0));
        let best = minimalPrompt;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const candidate = fitAt(mid);
            if (candidate) {
                best = candidate;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return best;
    };
    if (input.preservedFacts) {
        const withFacts = tryFit(true);
        if (withFacts && estimateMessagesTokens([
            { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
            { role: 'user', content: withFacts },
        ]) <= targetTokens) return withFacts;
    }
    const fitted = tryFit(false);
    if (fitted) return fitted;

    // Emergency deterministic reduction: even at perMessageChars=0 the prompt can
    // overflow when the head carries a very large NUMBER of messages (each still
    // emits a `N. role` line). Keep only the newest K head messages and collapse
    // the rest into a single `[K older messages omitted]` stub line, binary
    // searching the largest K that fits. This bounds the head by COUNT, not just
    // per-message chars, so a huge-head transcript still yields a minimal prompt
    // instead of null (which surfaced as a hard compaction throw).
    const head = Array.isArray(input.head) ? input.head : [];
    const baseNoFacts = { ...input, preservedFacts: null };
    const buildReduced = (k) => {
        const kept = k > 0 ? head.slice(head.length - k) : [];
        const omitted = head.length - kept.length;
        const finalize = (stubHead) => {
            let inp = { ...baseNoFacts, head: stubHead };
            // Also shrink/drop a prior <previous-summary> (same as the normal
            // fitAt path) — a large prior summary can keep the prompt over
            // budget even at K=0. fitPreviousSummaryForCompactionPrompt is a
            // no-op when there is no previousSummary, so this is safe for the
            // summary-less case.
            if (estimateCompactionPromptTokens(inp, 0) > targetTokens) {
                const fitted = fitPreviousSummaryForCompactionPrompt(inp, 0, targetTokens);
                if (!fitted) return null;
                inp = fitted;
                if (estimateCompactionPromptTokens(inp, 0) > targetTokens) return null;
            }
            return buildCompactionPrompt(inp, 0);
        };
        if (omitted <= 0) return finalize(kept);
        // The omitted head messages never reappear in the session afterward
        // (the caller replaces the whole head with the produced summary), so
        // a bare "[N older messages omitted]" stub used to discard their
        // content with zero trace. Prefer a compact per-message digest line
        // for each omitted message so at least a sliver of detail survives
        // into the summary input; only fall back to the count-only stub if
        // even the digest cannot fit the emergency budget, preserving the
        // original guarantee that this reduction always finds a fit.
        const digestLines = head.slice(0, omitted).map((m, i) => {
            const role = m?.role || 'unknown';
            const text = truncateMiddle(extractText(m).trim(), 30);
            return text ? `${i + 1}. ${role}: ${text}` : `${i + 1}. ${role}`;
        });
        const digestStub = {
            role: 'user',
            content: [`[${omitted} older messages compacted to a digest below]`, ...digestLines].join('\n'),
        };
        const withDigest = finalize([digestStub, ...kept]);
        if (withDigest) return withDigest;
        const countStub = { role: 'user', content: `[${omitted} older messages omitted]` };
        return finalize([countStub, ...kept]);
    };
    let lo = 0;
    let hi = head.length;
    let best = null;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = buildReduced(mid);
        if (candidate) { best = candidate; lo = mid + 1; }
        else hi = mid - 1;
    }
    return best;
}

export function extractResponseText(response) {
    if (!response) return '';
    if (typeof response.content === 'string') return response.content.trim();
    if (Array.isArray(response.content)) {
        return response.content
            .map((item) => {
                if (typeof item === 'string') return item;
                if (typeof item?.text === 'string') return item.text;
                if (typeof item?.content === 'string') return item.content;
                return '';
            })
            .filter(Boolean)
            .join('\n')
            .trim();
    }
    return '';
}

// Validate the provider summary against the required template sections; when it
// is missing ANY required section anchor (fully or partially malformed) repair
// it deterministically so a non-empty-but-broken response is never injected as
// the sole summary. Returns { summary, repaired }.
export function enforceCompactSummarySchema(summary, ctx = {}) {
    const text = String(summary || '').trim();
    if (!text) return { summary: text, repaired: false };
    if (summaryIsSchemaValid(text)) {
        return { summary: text, repaired: false };
    }
    return { summary: repairCompactSummary(text, ctx), repaired: true };
}

function makeGeneratedHandoffMessage(oldHistory, summary, handoffMeta = {}, preservedFacts = '') {
    const header = compactHeader(oldHistory);
    header.push(`generated_handoff=true provider=${handoffMeta.provider || 'unknown'} model=${handoffMeta.model || 'unknown'}`);
    const facts = String(preservedFacts || '').trim();
    const body = String(summary || '').trim();
    const parts = [header.join('\n')];
    if (facts) parts.push(facts);
    if (body) parts.push(body);
    return makeSummaryMessage(parts.join('\n\n'));
}

// Fit the structured handoff summary into the remaining token budget WITHOUT
// dropping any required section. The incoming `summary` is already schema-valid
// (enforceCompactSummarySchema ran upstream); here we shrink section bodies via
// section-aware truncation, fall back to a headings-only schema-valid summary,
// and finally revalidate so the injected SUMMARY_PREFIX message always carries
// every required anchor. Returns null only when even the minimal schema-valid
// summary cannot fit (caller throws).
export function fitGeneratedHandoffMessage(oldHistory, summary, remainingTokens, handoffMeta, preservedFacts = '') {
    const tryFit = (factsText) => {
        const text = String(summary || '').trim();
        // Minimal schema-valid body (headings + "(none)"). If even this does
        // not fit, this facts variant cannot produce a valid message.
        const minimalBody = text ? minimalSchemaSummary() : '';
        const minimal = makeGeneratedHandoffMessage(oldHistory, minimalBody, handoffMeta, factsText);
        if (estimateMessagesTokens([minimal]) > remainingTokens) return null;
        if (!text) return minimal;
        // Binary search the per-section body budget; keep all anchors intact.
        let lo = 0;
        let hi = text.length;
        let best = minimal;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const body = truncateSummaryBySections(text, mid);
            const candidate = makeGeneratedHandoffMessage(oldHistory, body, handoffMeta, factsText);
            if (estimateMessagesTokens([candidate]) <= remainingTokens && summaryIsSchemaValid(body)) {
                best = candidate;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return best;
    };
    let result = null;
    if (preservedFacts) result = tryFit(preservedFacts);
    if (!result) result = tryFit('');
    return result;
}

// Peel the structural summary header off a prior summary body so handoff
// generation can feed bare text into its <previous-summary> block. Old sessions may still carry a
// <prior-compacted-context> wrapper, so those boundary lines are dropped too.
export function stripNestedSummaryHeaderLines(text) {
    const raw = String(text ?? '');
    // Peel only the emitted wrapper/header/join bytes and keep the inner slice
    // verbatim: splitting into lines would lose ownership of a run of newlines,
    // where one newline belongs to the content and must survive.
    const openMatch = /^[ \t]*<prior-compacted-context>[ \t]*\n/m.exec(raw);
    if (openMatch) {
        const closeRe = /\n[ \t]*<\/prior-compacted-context>[ \t]*(?=\n|$)/g;
        closeRe.lastIndex = openMatch.index + openMatch[0].length;
        const closeMatch = closeRe.exec(raw);
        if (closeMatch) {
            const prior = raw.slice(openMatch.index + openMatch[0].length, closeMatch.index);
            const remainder = raw.slice(closeMatch.index + closeMatch[0].length);
            // The only bytes between generated wrapper and live recall are
            // this part-join's two newlines. Do not consume any other newline:
            // those belong to either prior or live content.
            const live = remainder.startsWith('\n\n') ? remainder.slice(2) : remainder;
            if (!live || prior.trim() === live) return prior;
            if (!prior) return live;
            return `${prior}\n\n${live}`;
        }
    }

    const lines = raw.split('\n');
    const out = [];
    let followsStructuralHeader = false;
    for (const line of lines) {
        if (line.startsWith(SUMMARY_PREFIX_ANCHOR)) {
            followsStructuralHeader = true;
            continue;
        }
        if (/^messages=\d+\s+(?:sha256=|compact_type=)/.test(line.trim())) {
            followsStructuralHeader = true;
            continue;
        }
        if (/^compact_type=/.test(line.trim())) {
            followsStructuralHeader = true;
            continue;
        }
        if (/^(?:generated_handoff|semantic)=/.test(line.trim())) {
            followsStructuralHeader = true;
            continue;
        }
        // Summary parts are joined with "\n\n". The first empty line after
        // stripped summary metadata is that join's structural separator, not
        // content.
        if (followsStructuralHeader && line === '') {
            followsStructuralHeader = false;
            continue;
        }
        followsStructuralHeader = false;
        // A prior summary re-fed as <previous-summary>/prior may still carry
        // the canonical <prior-compacted-context> wrapper from an earlier
        // cycle; drop those tag-only lines so the caller re-wraps exactly once
        // (or treats the body as bare prior) instead of nesting.
        if (/^<prior-compacted-context>$/.test(line.trim())) {
            // The immediately preceding blank is the header→wrapper join from
            // a generated summary. Remove only that wrapper-owned separator;
            // blank lines inside the wrapper body remain untouched.
            if (out.length > 0 && out[out.length - 1] === '') out.pop();
            continue;
        }
        if (/^<\/prior-compacted-context>$/.test(line.trim())) continue;
        out.push(line);
    }
    return out.join('\n');
}

function makeFreshContextSummaryMessageParts(oldHistory, handoffPart) {
    const header = compactHeader(oldHistory);
    const parts = [header.join('\n')];
    const handoff = String(handoffPart || '').trim();
    if (handoff) parts.push(handoff);
    return makeSummaryMessage(parts.join('\n\n'));
}

export function fitFreshContextSummaryMessage(oldHistory, handoffText, remainingTokens) {
    const handoff = String(handoffText || '').trim();

    const minimal = makeFreshContextSummaryMessageParts(oldHistory, '');
    if (estimateMessagesTokens([minimal]) > remainingTokens) return null;
    if (!handoff) return minimal;

    const { preamble, blocks } = splitMemoryHandoffRootBlocks(handoff);
    if (blocks.length > 0) {
        // Root-block granularity fit: drop the OLDEST blocks WHOLE (never cut
        // a `# chunk` / `# raw_pending` / `# raw_terminal` block mid-entry);
        // dropping more leading blocks only shrinks the body, so binary-search
        // the minimal drop count.
        let loB = 0;
        let hiB = blocks.length;
        let bestLo = -1;
        while (loB <= hiB) {
            const midB = Math.floor((loB + hiB) / 2);
            const body = [preamble, ...blocks.slice(midB)].filter(Boolean).join('\n\n');
            const candidate = makeFreshContextSummaryMessageParts(oldHistory, body);
            if (estimateMessagesTokens([candidate]) <= remainingTokens) {
                bestLo = midB;
                hiB = midB - 1;
            } else {
                loB = midB + 1;
            }
        }
        if (bestLo >= 0) {
            const body = [preamble, ...blocks.slice(bestLo)].filter(Boolean).join('\n\n');
            return makeFreshContextSummaryMessageParts(oldHistory, body);
        }
        // Even the preamble alone overflows: try it, else the minimal message.
        if (preamble) {
            const preambleOnly = makeFreshContextSummaryMessageParts(oldHistory, preamble);
            if (estimateMessagesTokens([preambleOnly]) <= remainingTokens) return preambleOnly;
        }
        return minimal;
    }

    // Plain newest-first handoff: preserve complete lines whenever possible,
    // dropping only the oldest trailing lines. A single oversized line falls
    // through to the character fit below.
    const lines = handoff.split('\n');
    if (lines.length > 1) {
        let loL = 1;
        let hiL = lines.length;
        let bestLines = 0;
        while (loL <= hiL) {
            const midL = Math.floor((loL + hiL) / 2);
            const candidate = makeFreshContextSummaryMessageParts(
                oldHistory,
                lines.slice(0, midL).join('\n'),
            );
            if (estimateMessagesTokens([candidate]) <= remainingTokens) {
                bestLines = midL;
                loL = midL + 1;
            } else {
                hiL = midL - 1;
            }
        }
        if (bestLines > 0) {
            return makeFreshContextSummaryMessageParts(
                oldHistory,
                lines.slice(0, bestLines).join('\n'),
            );
        }
    }

    let lo = 0;
    let hi = handoff.length;
    let best = minimal;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = makeFreshContextSummaryMessageParts(oldHistory, handoff.slice(0, mid));
        if (estimateMessagesTokens([candidate]) <= remainingTokens) {
            best = candidate;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best;
}

// --- Root-block splitting for the Memory handoff ---------------------------
//
// A memory digest renders chunks TIME-ORDERED (oldest first), each root/raw
// block starting with one of:
//   # chunk N root=ID[ category=X]
//   # raw_pending N id=ID
//   # raw_terminal N id=ID
// and blocks joined by "\n\n", after an optional preamble that is kept verbatim
// as a non-block segment.
//
// fitFreshContextSummaryMessage drops whole blocks instead of cutting one
// mid-entry, since losing half a root's content silently corrupts that entry.
// Boundaries come from the label pattern, which stays robust to blank lines
// inside member/raw content.
const MEMORY_ROOT_BLOCK_HEADER_RE = /^# (?:chunk \d+ root=\d+(?: category=\S+)?|raw_pending \d+ id=\d+|raw_terminal \d+ id=\d+)[ \t]*$/;

function splitMemoryHandoffRootBlocks(text) {
    const value = String(text || '');
    if (!value.trim()) return { preamble: '', blocks: [] };
    const re = new RegExp(MEMORY_ROOT_BLOCK_HEADER_RE.source, 'gm');
    const starts = [];
    let m;
    while ((m = re.exec(value)) !== null) {
        starts.push(m.index);
        if (re.lastIndex === m.index) re.lastIndex += 1; // zero-width guard, defensive
    }
    if (starts.length === 0) return { preamble: value.trim(), blocks: [] };
    const preamble = value.slice(0, starts[0]).trim();
    const blocks = [];
    for (let i = 0; i < starts.length; i += 1) {
        const start = starts[i];
        const end = i + 1 < starts.length ? starts[i + 1] : value.length;
        const raw = value.slice(start, end).trim();
        if (raw) blocks.push(raw);
    }
    return { preamble, blocks };
}

