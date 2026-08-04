// Summarization system prompt, schema validation/repair, semantic + recall
// fast-track summary-message construction and fitting, root-block fitting, and
// the recall query builder. Extracted verbatim from compact.mjs
// (behavior-preserving).
import { estimateMessagesTokens } from '../context-utils.mjs';
import {
    SUMMARY_PREFIX,
    COMPACT_TYPE_SEMANTIC,
    COMPACT_TYPE_RECALL_FASTTRACK,
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
    repairSemanticSummary,
    minimalSchemaSummary,
    truncateSummaryBySections,
} from './summary-schema.mjs';

export { repairSemanticSummary } from './summary-schema.mjs';

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
    return repairSemanticSummary(text, { head: [], tail: [] });
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
export function enforceSemanticSummarySchema(summary, ctx = {}) {
    const text = String(summary || '').trim();
    if (!text) return { summary: text, repaired: false };
    if (summaryIsSchemaValid(text)) {
        return { summary: text, repaired: false };
    }
    return { summary: repairSemanticSummary(text, ctx), repaired: true };
}

function makeSemanticSummaryMessage(oldHistory, summary, semanticMeta = {}, preservedFacts = '') {
    const header = compactHeader(oldHistory);
    header.push(`compact_type=${COMPACT_TYPE_SEMANTIC}`);
    header.push(`semantic=true provider=${semanticMeta.provider || 'unknown'} model=${semanticMeta.model || 'unknown'}`);
    const facts = String(preservedFacts || '').trim();
    const body = String(summary || '').trim();
    const parts = [header.join('\n')];
    if (facts) parts.push(facts);
    if (body) parts.push(body);
    return makeSummaryMessage(parts.join('\n\n'));
}

export function buildRecallFastTrackQuery(messages, opts = {}) {
    const maxChars = Math.max(200, Number(opts.maxChars) || 2_000);
    const hints = String(opts.hints || 'current task decisions constraints file paths changed files verification failures next steps').trim();
    let latestUser = '';
    const recent = [];
    const input = Array.isArray(messages) ? messages : [];
    for (let i = input.length - 1; i >= 0; i -= 1) {
        const m = input[i];
        const text = extractText(m).trim();
        if (!text) continue;
        if (recent.length < 6) recent.unshift(text);
        if (!latestUser && m?.role === 'user' && !isProtectedContextUserMessage(m) && !isInjectedSkillBodyMessage(m)) {
            latestUser = text;
        }
        if (latestUser && recent.length >= 6) break;
    }
    const parts = [latestUser, hints, recent.join('\n')]
        .map((s) => String(s || '').trim())
        .filter(Boolean);
    return truncateMiddle([...new Set(parts)].join('\n'), maxChars);
}

// Fit the structured semantic summary into the remaining token budget WITHOUT
// dropping any required section. The incoming `summary` is already schema-valid
// (enforceSemanticSummarySchema ran upstream); here we shrink section bodies via
// section-aware truncation, fall back to a headings-only schema-valid summary,
// and finally revalidate so the injected SUMMARY_PREFIX message always carries
// every required anchor. Returns null only when even the minimal schema-valid
// summary cannot fit (caller throws).
export function fitSemanticSummaryMessage(oldHistory, summary, remainingTokens, semanticMeta, preservedFacts = '') {
    const tryFit = (factsText) => {
        const text = String(summary || '').trim();
        // Minimal schema-valid body (headings + "(none)"). If even this does
        // not fit, this facts variant cannot produce a valid message.
        const minimalBody = text ? minimalSchemaSummary() : '';
        const minimal = makeSemanticSummaryMessage(oldHistory, minimalBody, semanticMeta, factsText);
        if (estimateMessagesTokens([minimal]) > remainingTokens) return null;
        if (!text) return minimal;
        // Binary search the per-section body budget; keep all anchors intact.
        let lo = 0;
        let hi = text.length;
        let best = minimal;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const body = truncateSummaryBySections(text, mid);
            const candidate = makeSemanticSummaryMessage(oldHistory, body, semanticMeta, factsText);
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

export const RECALL_TAIL_TRUNCATION_MARKER = '[... truncated during recall tail preservation ...]';
export const RECALL_TAIL_SHORT_TRUNCATION_MARKER = '[truncated]';

const PRIOR_COMPACTED_CONTEXT_OPEN = '<prior-compacted-context>';
const PRIOR_COMPACTED_CONTEXT_CLOSE = '</prior-compacted-context>';
// Matches ONLY a structural wrapper BOUNDARY line — a line whose sole content is
// the open or close tag (optionally surrounded by whitespace). It deliberately
// does NOT match an inline occurrence embedded in real content (e.g. a user note
// like "keep <prior-compacted-context> literal here"), so flattening the wrapper
// can never splice words together or corrupt marker-like text. The production
// wrapper is always emitted on its own line, so boundary-line stripping removes
// every real wrapper while leaving inline literals verbatim.
const PRIOR_COMPACTED_CONTEXT_BOUNDARY_RE = /^[ \t]*<\/?prior-compacted-context>[ \t]*$/;

// Strip the STRUCTURAL <prior-compacted-context> / </prior-compacted-context>
// boundary lines from prior text so re-wrapping never nests, while preserving
// any inline marker-like text inside real content exactly as written. Returns
// the bare inner content with the blank lines the removed boundary lines leave
// behind collapsed.
export function stripPriorCompactedContextWrappers(text) {
    const raw = String(text ?? '');
    if (!raw) return '';
    // Keep every non-structural byte, including leading/trailing and repeated
    // newlines.  Removing only the structural line itself (not trim/collapse)
    // preserves the layout of all remaining content.
    return raw
        .split('\n')
        .filter((line) => !PRIOR_COMPACTED_CONTEXT_BOUNDARY_RE.test(line))
        .join('\n');
}

// Remove only STRUCTURALLY IDENTICAL blank-line-separated blocks (byte-for-byte
// repeats) so a prior context re-fed across many compaction cycles keeps every
// distinct requirement/fact and cannot grow without bound. The dedupe is
// content-preserving: the key is the block's EXACT text — internal whitespace is
// never collapsed and meaningful block content is never trimmed — so distinct
// strings such as `printf 'a  b'` and `printf 'a b'` are BOTH kept verbatim.
// Only an exact repeat of a previously emitted block is dropped; blank
// separators (whitespace-only splits) are skipped, never real content.
function dedupePriorCompactedBlocks(text) {
    const raw = String(text ?? '');
    if (!raw.trim()) return '';
    const seen = new Set();
    const parts = raw.split(/(\n{2,})/);
    const out = [];
    let separator = '';
    for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        if (i % 2 === 1) {
            separator += part;
            continue;
        }
        // Whitespace-only parts are layout, not a duplicate candidate.
        if (!part.trim()) {
            out.push(separator, part);
            separator = '';
            continue;
        }
        if (seen.has(part)) {
            // Drop only the exact repeated structural block and its preceding
            // separator; all retained text and whitespace stay byte-for-byte.
            separator = '';
            continue;
        }
        out.push(separator, part);
        separator = '';
        seen.add(part);
    }
    out.push(separator);
    return out.join('');
}

// Canonicalize prior compacted context to AT MOST ONE wrapper: flatten any
// nested/duplicated wrappers accumulated by earlier cycles, dedupe repeated
// blocks, then wrap the surviving content exactly once. Repeated compaction can
// therefore never nest or duplicate the prior context, each distinct
// requirement/fact is preserved exactly once, and repeated-cycle token size
// stays bounded.
//
// Optimization-safe empty-prior interpretation: when there is NO prior content
// (empty / blank / boundary-tag-only input) this returns '' so the generated
// summary carries ZERO wrappers instead of an empty
// <prior-compacted-context></prior-compacted-context> pair. The production
// summary body joins only non-empty parts (makeRecall*SummaryMessageParts), so
// an empty wrapper cannot be carried and would only waste tokens. "Exactly one
// wrapper" is thus realized as: exactly one when prior content exists, none when
// it does not — and never more than one, never nested.
export function formatPriorCompactedContextBlock(priorText) {
    const flattened = dedupePriorCompactedBlocks(stripPriorCompactedContextWrappers(priorText));
    if (!flattened) return '';
    return `${PRIOR_COMPACTED_CONTEXT_OPEN}\n${flattened}\n${PRIOR_COMPACTED_CONTEXT_CLOSE}`;
}

export function stripNestedSummaryHeaderLines(text) {
    const raw = String(text ?? '');
    // A generated recall summary has a canonical, provenance-bearing shape:
    //   header + "\n\n" + OPEN + "\n" + prior + "\n" + CLOSE + "\n\n" + recall
    // Extracting it as lines loses ownership of a run of newlines: in
    // `X\n` + join + live `X`, generic block dedupe cannot know that one
    // newline belongs to X and must survive dropping the duplicate live X.
    // Peel only the emitted wrapper/header/join bytes and retain the inner
    // prior slice verbatim. The live recall is dropped only when it is the
    // same payload the wrapper already carries.
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
        if (line.startsWith(SUMMARY_PREFIX)) {
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
        // Summary parts are joined with "\n\n".  The first empty line after
        // stripped summary metadata is that join's structural separator, not
        // prior content; retaining it makes every refeed gain a newline when
        // formatPriorCompactedContextBlock wraps the result again.
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

function makeRecallFastTrackSummaryMessageParts(oldHistory, recallPart, priorPart, recallMeta = {}) {
    const header = compactHeader(oldHistory);
    header.push(`compact_type=${COMPACT_TYPE_RECALL_FASTTRACK} source=recall-fasttrack query_sha=${recallMeta.querySha || 'none'}`);
    const parts = [header.join('\n')];
    const priorBlock = formatPriorCompactedContextBlock(priorPart);
    if (priorBlock) parts.push(priorBlock);
    const recall = String(recallPart || '').trim();
    if (recall) parts.push(recall);
    return makeSummaryMessage(parts.join('\n\n'));
}

export function fitRecallFastTrackSummaryMessage(oldHistory, recallText, remainingTokens, recallMeta = {}, priorPart = '') {
    const recall = String(recallText || '').trim();
    const prior = String(priorPart || '');

    let fittedPrior = prior;
    if (prior) {
        let lo = 0;
        let hi = prior.length;
        let bestPriorLen = 0;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const candidate = makeRecallFastTrackSummaryMessageParts(oldHistory, '', prior.slice(0, mid), recallMeta);
            if (estimateMessagesTokens([candidate]) <= remainingTokens) {
                bestPriorLen = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        fittedPrior = prior.slice(0, bestPriorLen);
        if (!fittedPrior && prior) {
            const markerOnly = makeRecallFastTrackSummaryMessageParts(oldHistory, '', RECALL_TAIL_TRUNCATION_MARKER, recallMeta);
            if (estimateMessagesTokens([markerOnly]) <= remainingTokens) {
                fittedPrior = RECALL_TAIL_TRUNCATION_MARKER;
            }
        }
    }

    const minimal = makeRecallFastTrackSummaryMessageParts(oldHistory, '', fittedPrior, recallMeta);
    if (estimateMessagesTokens([minimal]) > remainingTokens) return null;
    if (!recall) return minimal;

    const { preamble, blocks } = splitRecallRootBlocks(recall);
    if (blocks.length > 0) {
        // Root-block granularity fit: drop the OLDEST blocks WHOLE (never cut
        // a `# chunk` / `# raw_pending` / `# raw_terminal` block mid-entry);
        // dropping more leading blocks only shrinks the body, so binary-search
        // the minimal drop count (mirrors fitRecallRootsMessage).
        let loB = 0;
        let hiB = blocks.length;
        let bestLo = -1;
        while (loB <= hiB) {
            const midB = Math.floor((loB + hiB) / 2);
            const body = [preamble, ...blocks.slice(midB)].filter(Boolean).join('\n\n');
            const candidate = makeRecallFastTrackSummaryMessageParts(oldHistory, body, fittedPrior, recallMeta);
            if (estimateMessagesTokens([candidate]) <= remainingTokens) {
                bestLo = midB;
                hiB = midB - 1;
            } else {
                loB = midB + 1;
            }
        }
        if (bestLo >= 0) {
            const body = [preamble, ...blocks.slice(bestLo)].filter(Boolean).join('\n\n');
            return makeRecallFastTrackSummaryMessageParts(oldHistory, body, fittedPrior, recallMeta);
        }
        // Even zero blocks (preamble alone) overflows alongside the fitted
        // prior - try preamble alone, else the no-recall minimal message.
        if (preamble) {
            const preambleOnly = makeRecallFastTrackSummaryMessageParts(oldHistory, preamble, fittedPrior, recallMeta);
            if (estimateMessagesTokens([preambleOnly]) <= remainingTokens) return preambleOnly;
        }
        return minimal;
    }

    // No parseable root-block boundaries (plain recall text): fall back to the
    // character-slice binary search below.

    let lo = 0;
    let hi = recall.length;
    let best = minimal;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = makeRecallFastTrackSummaryMessageParts(oldHistory, recall.slice(0, mid), fittedPrior, recallMeta);
        if (estimateMessagesTokens([candidate]) <= remainingTokens) {
            best = candidate;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best;
}

// --- Smart-compact root-based fitting (arrival-time replacement) -----------
//
// dump_session_roots (memory/index.mjs dumpSessionRootChunks) renders chunks
// TIME-ORDERED (oldest first; chunks.sort by sourceTurn/ts/id ascending),
// each root/raw block starting with one of:
//   # chunk N root=ID[ category=X]
//   # raw_pending N id=ID
//   # raw_terminal N id=ID
// and blocks joined by "\n\n". runRecallFastTrackForSession additionally
// prepends a "session_id=..." / cycle1-drain-status preamble before the dump
// text (also "\n\n"-joined) — preserved verbatim as a non-block segment.
//
// Unlike fitRecallFastTrackSummaryMessage (character-slice binary search,
// used by the LLM-summary-free but still-mid-turn recall-fasttrack compact
// path), the smart-compact arrival path must never cut a root block
// mid-entry — losing half a root's content silently corrupts that entry.
// This splitter finds block boundaries by the label pattern (robust to
// blank lines inside member/raw content, since it anchors on the distinctive
// "# chunk /raw_pending/raw_terminal" line rather than a blank-line split).
const RECALL_ROOT_BLOCK_HEADER_RE = /^# (?:chunk \d+ root=\d+(?: category=\S+)?|raw_pending \d+ id=\d+|raw_terminal \d+ id=\d+)[ \t]*$/;

export function splitRecallRootBlocks(text) {
    const value = String(text || '');
    if (!value.trim()) return { preamble: '', blocks: [] };
    const re = new RegExp(RECALL_ROOT_BLOCK_HEADER_RE.source, 'gm');
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

// Minimal-header summary-message wrapper for the smart-compact roots path.
// Keeps the SUMMARY_PREFIX anchor (isSummaryMessage / selectCompactionWindow
// / clear-preserve / TUI all key off startsWith(SUMMARY_PREFIX)) but skips the
// full sha256/roleCounts header line that fitRecallFastTrackSummaryMessage
// computes — smart-arrival replacement is a lightweight prefix swap, not the
// anchored LLM-summary compact, so a heavy per-call header is unneeded cost.
function makeRecallRootsSummaryMessageParts(oldHistory, rootsPart, priorPart, recallMeta = {}) {
    const header = `${SUMMARY_PREFIX}\nmessages=${(oldHistory || []).length} compact_type=${COMPACT_TYPE_RECALL_FASTTRACK} source=smart-arrival query_sha=${recallMeta.querySha || 'none'}`;
    const parts = [header];
    const priorBlock = formatPriorCompactedContextBlock(priorPart);
    if (priorBlock) parts.push(priorBlock);
    const roots = String(rootsPart || '').trim();
    if (roots) parts.push(roots);
    return makeSummaryMessage(parts.join('\n\n'));
}

// Root-block-aware fit for the smart-compact arrival path (Step1). Mirrors
// fitRecallFastTrackSummaryMessage's prior-block binary-search fit, but the
// recall body is fit at ROOT-BLOCK granularity: when the full set of root
// blocks (kept in original time order) exceeds remainingTokens, the OLDEST
// blocks are dropped WHOLE (never character-truncated mid-block) until the
// remaining (newest-biased) suffix fits. Because dropping more leading
// blocks can only shrink (never grow) the serialized size, the minimal-drop
// threshold is found via binary search on the drop count.
export function fitRecallRootsMessage(oldHistory, recallText, remainingTokens, recallMeta = {}, priorPart = '') {
    const prior = String(priorPart || '');

    let fittedPrior = prior;
    if (prior) {
        let lo = 0;
        let hi = prior.length;
        let bestPriorLen = 0;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const candidate = makeRecallRootsSummaryMessageParts(oldHistory, '', prior.slice(0, mid), recallMeta);
            if (estimateMessagesTokens([candidate]) <= remainingTokens) {
                bestPriorLen = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        fittedPrior = prior.slice(0, bestPriorLen);
        if (!fittedPrior && prior) {
            const markerOnly = makeRecallRootsSummaryMessageParts(oldHistory, '', RECALL_TAIL_TRUNCATION_MARKER, recallMeta);
            if (estimateMessagesTokens([markerOnly]) <= remainingTokens) {
                fittedPrior = RECALL_TAIL_TRUNCATION_MARKER;
            }
        }
    }

    const minimal = makeRecallRootsSummaryMessageParts(oldHistory, '', fittedPrior, recallMeta);
    if (estimateMessagesTokens([minimal]) > remainingTokens) return null;

    const { preamble, blocks } = splitRecallRootBlocks(recallText);
    if (blocks.length === 0) {
        // No parseable root-block boundaries (empty / non-dump recallText) —
        // degrade to keep-whole-if-it-fits, else drop entirely. Never
        // mid-truncates: a non-block body is treated as a single atomic unit.
        const whole = String(recallText || '').trim();
        if (!whole) return minimal;
        const full = makeRecallRootsSummaryMessageParts(oldHistory, whole, fittedPrior, recallMeta);
        if (estimateMessagesTokens([full]) <= remainingTokens) return full;
        return minimal;
    }

    let loB = 0;
    let hiB = blocks.length;
    let bestLo = -1;
    while (loB <= hiB) {
        const mid = Math.floor((loB + hiB) / 2);
        const kept = blocks.slice(mid);
        const body = [preamble, ...kept].filter(Boolean).join('\n\n');
        const candidate = makeRecallRootsSummaryMessageParts(oldHistory, body, fittedPrior, recallMeta);
        if (estimateMessagesTokens([candidate]) <= remainingTokens) {
            bestLo = mid;
            hiB = mid - 1;
        } else {
            loB = mid + 1;
        }
    }
    if (bestLo >= 0) {
        const kept = blocks.slice(bestLo);
        const body = [preamble, ...kept].filter(Boolean).join('\n\n');
        return makeRecallRootsSummaryMessageParts(oldHistory, body, fittedPrior, recallMeta);
    }
    // Even zero root blocks (preamble alone) overflows alongside the fitted
    // prior — try preamble alone, else the no-recall minimal header.
    if (preamble) {
        const preambleOnly = makeRecallRootsSummaryMessageParts(oldHistory, preamble, fittedPrior, recallMeta);
        if (estimateMessagesTokens([preambleOnly]) <= remainingTokens) return preambleOnly;
    }
    return minimal;
}
