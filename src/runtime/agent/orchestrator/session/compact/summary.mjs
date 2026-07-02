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

export function buildCompactionPrompt({ head, previousSummary, preservedFacts }, perMessageChars) {
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
    const text = String(previousSummary || '').trim();
    if (!text) return '';
    return stripNestedSummaryHeaderLines(text);
}

function priorSummaryNeedsNormalization(text) {
    const body = String(text || '').trim();
    if (!body) return false;
    if (!/^##\s+/m.test(body)) return true;
    if (!summaryIsSchemaValid(body)) return true;
    return summaryHasUnrecognizedHeadings(body);
}

function normalizePriorSummaryForCompactionPrompt(fullBody) {
    const text = String(fullBody || '').trim();
    if (!text) return '';
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
        const trimmed = String(summaryText || '').trim();
        if (!trimmed) return { ...input, previousSummary: null };
        return { ...input, previousSummary: trimmed };
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
        const stubHead = omitted > 0
            ? [{ role: 'user', content: `[${omitted} older messages omitted]` }, ...kept]
            : kept;
        let inp = { ...baseNoFacts, head: stubHead };
        // Also shrink/drop a prior <previous-summary> (same as the normal fitAt
        // path) — a large prior summary can keep the prompt over budget even at
        // K=0. fitPreviousSummaryForCompactionPrompt is a no-op when there is no
        // previousSummary, so this is safe for the summary-less case.
        if (estimateCompactionPromptTokens(inp, 0) > targetTokens) {
            const fitted = fitPreviousSummaryForCompactionPrompt(inp, 0, targetTokens);
            if (!fitted) return null;
            inp = fitted;
            if (estimateCompactionPromptTokens(inp, 0) > targetTokens) return null;
        }
        return buildCompactionPrompt(inp, 0);
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

// Canonical section anchors the semantic summary template (SUMMARY_TEMPLATE)
// must contain. Used for lightweight schema validation of provider output.
const REQUIRED_SUMMARY_SECTIONS = Object.freeze([
    '## Goal',
    '## Constraints',
    '## Progress',
    '## Key Decisions',
    '## Next Steps',
    '## Critical Context',
    '## Relevant Files',
]);

// Collect actual top-level (`## `, not `### `) heading lines from a summary.
// Validation is heading-anchor based (not substring includes) so prose or code
// that merely mentions "## Relevant Files" inside a bullet body cannot satisfy
// a section anchor.
function summaryHeadingLines(summary) {
    const out = [];
    for (const rawLine of String(summary || '').split('\n')) {
        const line = rawLine.trim();
        if (/^##\s+\S/.test(line) && !/^###\s+/.test(line)) out.push(line);
    }
    return out;
}

// An anchor matches a heading when the heading title equals the anchor title or
// extends it at a word/punctuation boundary. This lets `## Constraints &
// Preferences` satisfy the `## Constraints` anchor while NOT letting an
// unrelated `## Goalkeeper` heading satisfy `## Goal`. Requires a real `## `
// heading line (not a substring buried in prose).
function headingMatchesAnchor(heading, anchor) {
    const anchorTitle = anchor.replace(/^##\s+/, '').trim().toLowerCase();
    const headingTitle = heading.replace(/^##\s+/, '').trim().toLowerCase();
    if (headingTitle === anchorTitle) return true;
    if (!headingTitle.startsWith(anchorTitle)) return false;
    // Next char after the anchor title must be a boundary (space or &/punct),
    // not a continuation letter/digit.
    const nextChar = headingTitle.charAt(anchorTitle.length);
    return /[\s&:(-]/.test(nextChar);
}

function summarySchemaScore(summary) {
    const headings = summaryHeadingLines(summary);
    let hits = 0;
    for (const anchor of REQUIRED_SUMMARY_SECTIONS) {
        if (headings.some((h) => headingMatchesAnchor(h, anchor))) hits += 1;
    }
    return hits;
}

// A summary is schema-valid only when EVERY required section anchor is present
// as a real heading. A partial summary (e.g. missing Critical Context /
// Relevant Files) must be repaired rather than injected unchanged.
function summaryIsSchemaValid(summary) {
    if (summarySchemaScore(summary) !== REQUIRED_SUMMARY_SECTIONS.length) return false;
    return !summaryHasUnrecognizedHeadings(summary);
}

function deriveRelevantFilesBullets(head) {
    const seen = new Set();
    const out = [];
    const fileRe = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\w$.-]+[\\/])?[\w$.-]+\.(?:mjs|cjs|js|jsx|ts|tsx|json|md|rs|go|py|java|kt|cs|cpp|c|h|hpp|css|html|yml|yaml|toml|lock|sh|ps1)\b/gi;
    for (const m of Array.isArray(head) ? head : []) {
        const text = extractText(m);
        if (!text) continue;
        let match;
        while ((match = fileRe.exec(text)) && out.length < 8) {
            const file = match[0];
            const key = file.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(`- ${file}`);
        }
        if (out.length >= 8) break;
    }
    return out;
}

function deriveCurrentRequest(messages) {
    for (let i = (Array.isArray(messages) ? messages.length : 0) - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m?.role === 'user' && !isProtectedContextUserMessage(m) && !isInjectedSkillBodyMessage(m)) {
            const text = truncateMiddle(extractText(m).trim(), 400);
            if (text) return text;
        }
    }
    return '';
}

// Canonical ordered section headings the structured summary scaffold emits.
// Each `## ` heading maps to one REQUIRED_SUMMARY_SECTIONS anchor; Progress
// additionally carries its three `### ` sub-headings.
const SUMMARY_SECTION_LAYOUT = Object.freeze([
    { heading: '## Goal', anchor: '## Goal' },
    { heading: '## Constraints & Preferences', anchor: '## Constraints' },
    { heading: '## Progress', anchor: '## Progress', sub: ['### Done', '### In Progress', '### Blocked'] },
    { heading: '## Key Decisions', anchor: '## Key Decisions' },
    { heading: '## Next Steps', anchor: '## Next Steps' },
    { heading: '## Critical Context', anchor: '## Critical Context' },
    { heading: '## Relevant Files', anchor: '## Relevant Files' },
]);

// Split a markdown summary into a map of top-level `## ` heading -> body lines.
function parseSummarySections(text) {
    const map = new Map();
    let current = null;
    for (const rawLine of String(text || '').split('\n')) {
        const trimmed = rawLine.trim();
        const line = rawLine.replace(/\s+$/, '');
        if (/^##\s+/.test(trimmed) && !/^###\s+/.test(trimmed)) {
            current = trimmed;
            if (!map.has(current)) map.set(current, []);
            continue;
        }
        if (current) map.get(current).push(line);
    }
    return map;
}

function summarySectionIsRecognized(heading) {
    for (const section of SUMMARY_SECTION_LAYOUT) {
        if (headingMatchesAnchor(heading, section.anchor)) return true;
    }
    return false;
}

function summaryHasUnrecognizedHeadings(summary) {
    for (const heading of parseSummarySections(summary).keys()) {
        if (!summarySectionIsRecognized(heading)) return true;
    }
    return false;
}

function summaryLinesToBullets(text) {
    return String(text || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => (l.startsWith('-') ? l : `- ${l}`));
}

function unrecognizedSummarySectionText(present) {
    const chunks = [];
    for (const [heading, body] of present) {
        if (summarySectionIsRecognized(heading)) continue;
        const lines = [heading];
        for (const line of body || []) {
            const trimmed = String(line).trim();
            if (trimmed) lines.push(line);
        }
        chunks.push(lines.join('\n'));
    }
    return chunks.join('\n\n').trim();
}

// Deterministic schema repair for a non-empty but malformed/partial semantic
// summary. Preserve every section the provider DID supply (matched by anchor),
// and scaffold the missing required sections so downstream consumers always
// receive the full structured anchored shape. Content that lives outside any
// recognized section is routed into Critical Context so nothing is dropped.
// Lightly backfill Goal / Relevant Files from the transcript when empty.
export function repairSemanticSummary(summary, { head = [], tail = [] } = {}) {
    const raw = String(summary || '').trim();
    const present = parseSummarySections(raw);
    // Capture any leading content before the first recognized `## ` heading so
    // an entirely unstructured blob is preserved rather than silently dropped.
    let preamble = '';
    if (raw) {
        const firstHeading = raw.search(/(^|\n)\s*##\s+/);
        preamble = firstHeading === -1 ? raw : raw.slice(0, firstHeading);
        preamble = preamble.trim();
    }
    const orphanText = unrecognizedSummarySectionText(present);
    const extraContextParts = [];
    if (preamble) extraContextParts.push(preamble);
    if (orphanText) extraContextParts.push(orphanText);
    const extraContext = extraContextParts.join('\n\n').trim();
    const bulletize = (lines) => {
        const cleaned = (Array.isArray(lines) ? lines : [])
            .map((l) => String(l).trim())
            .filter(Boolean);
        return cleaned.length ? cleaned : null;
    };
    const findPresent = (anchor) => {
        for (const [heading, body] of present) {
            if (headingMatchesAnchor(heading, anchor)) return body;
        }
        return null;
    };
    const goal = deriveCurrentRequest(tail) || deriveCurrentRequest(head);
    const files = deriveRelevantFilesBullets(head);
    const out = [];
    for (const section of SUMMARY_SECTION_LAYOUT) {
        if (out.length) out.push('');
        out.push(section.heading);
        const body = bulletize(findPresent(section.anchor));
        if (section.sub) {
            // Progress: keep provider sub-bodies when present, else scaffold.
            if (body) {
                out.push(...body);
            } else {
                for (const sub of section.sub) {
                    out.push(sub, '- (none)');
                }
            }
            continue;
        }
        if (section.anchor === '## Critical Context') {
            const ccLines = [];
            if (body) ccLines.push(...body);
            for (const line of summaryLinesToBullets(extraContext)) {
                if (!ccLines.some((existing) => existing.trim() === line.trim())) ccLines.push(line);
            }
            if (ccLines.some((line) => line.trim() !== '- (none)')) {
                const withoutPlaceholder = ccLines.filter((line) => line.trim() !== '- (none)');
                out.push(...(withoutPlaceholder.length ? withoutPlaceholder : ccLines));
            } else {
                out.push(...(ccLines.length ? ccLines : ['- (none)']));
            }
            continue;
        }
        if (body) {
            out.push(...body);
            continue;
        }
        if (section.anchor === '## Goal') {
            out.push(goal ? `- ${goal}` : '- (none)');
        } else if (section.anchor === '## Relevant Files') {
            out.push(...(files.length ? files : ['- (none)']));
        } else {
            out.push('- (none)');
        }
    }
    return out.join('\n');
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

// A headings-only structured summary: every required `## ` (and Progress `### `)
// anchor present with `- (none)` bodies. This is the minimal schema-valid shape
// the fitter can fall back to when token pressure cannot hold real section
// bodies — it still passes summaryIsSchemaValid so the injected message is
// never partial.
function minimalSchemaSummary() {
    const out = [];
    for (const section of SUMMARY_SECTION_LAYOUT) {
        if (out.length) out.push('');
        out.push(section.heading);
        if (section.sub) {
            for (const sub of section.sub) out.push(sub, '- (none)');
        } else {
            out.push('- (none)');
        }
    }
    return out.join('\n');
}

// Section-aware truncation: keep EVERY `## ` heading and Progress `### `
// sub-heading intact, trimming only section bodies to `perSectionChars`. Unlike
// a raw text.slice(0, n) this never drops a trailing required section, so the
// result stays schema-valid (all anchors present) at any budget.
function truncateSummaryBySections(summary, perSectionChars) {
    const sections = parseSummarySections(summary);
    const out = [];
    for (const section of SUMMARY_SECTION_LAYOUT) {
        if (out.length) out.push('');
        out.push(section.heading);
        let body = null;
        for (const [heading, lines] of sections) {
            if (headingMatchesAnchor(heading, section.anchor)) { body = lines; break; }
        }
        const bodyText = (Array.isArray(body) ? body : [])
            .map((l) => String(l).trim())
            .filter(Boolean)
            .join('\n');
        if (!bodyText) {
            if (section.sub) for (const sub of section.sub) out.push(sub, '- (none)');
            else out.push('- (none)');
            continue;
        }
        const trimmed = perSectionChars > 0 ? truncateMiddle(bodyText, perSectionChars) : '';
        if (trimmed) out.push(trimmed);
        else if (section.sub) for (const sub of section.sub) out.push(sub, '- (none)');
        else out.push('- (none)');
    }
    return out.join('\n');
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

function formatPriorCompactedContextBlock(priorText) {
    const prior = String(priorText || '').trim();
    if (!prior) return '';
    return `${PRIOR_COMPACTED_CONTEXT_OPEN}\n${prior}\n${PRIOR_COMPACTED_CONTEXT_CLOSE}`;
}

export function stripNestedSummaryHeaderLines(text) {
    const lines = String(text ?? '').split('\n');
    const out = [];
    for (const line of lines) {
        if (line.startsWith(SUMMARY_PREFIX)) continue;
        if (/^messages=\d+\s+sha256=/.test(line.trim())) continue;
        out.push(line);
    }
    return out.join('\n').trim();
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
    const prior = String(priorPart || '').trim();

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
    const prior = String(priorPart || '').trim();

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
