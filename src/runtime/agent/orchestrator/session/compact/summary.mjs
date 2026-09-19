// Handoff summarization, schema validation/repair, and fresh-context
// summary-message fitting.
import { estimateMessagesTokens } from '../context-utils.mjs';
import { extractText, truncateMiddle, toolCallSummary, toolCallArgBudget, toolResultId } from './text-utils.mjs';
import { compactHeader, makeSummaryMessage } from './messages.mjs';
import {
  summaryIsSchemaValid,
  repairCompactSummary,
  minimalSchemaSummary,
  truncateSummaryBySections,
} from './summary-schema.mjs';

export { repairCompactSummary } from './summary-schema.mjs';

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

// Rolling compaction batches complete source fragments instead of silently
// clipping every message or discarding the oldest input to make a request fit.
export function fitCompleteCompactionPrompt(input, targetTokens) {
  const prompt = buildCompactionPrompt(input, Number.MAX_SAFE_INTEGER);
  return estimateMessagesTokens([
    { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]) <= targetTokens
    ? prompt
    : null;
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
  header.push(
    `generated_handoff=true provider=${handoffMeta.provider || 'unknown'} model=${handoffMeta.model || 'unknown'}`
  );
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

function makeFreshContextSummaryMessageParts(oldHistory, handoffPart) {
  const header = compactHeader(oldHistory);
  const parts = [header.join('\n')];
  const handoff = String(handoffPart || '').trim();
  if (handoff) parts.push(handoff);
  return makeSummaryMessage(parts.join('\n\n'));
}

// The largest `size` in [lo, hi] whose candidate fits; `build` grows with
// `size`, so the fit is monotone and binary search finds the edge.
function largestFitting(lo, hi, build, fits) {
  let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = build(mid);
    if (fits(candidate)) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// Root-block granularity fit: drop the OLDEST blocks WHOLE (never cut a
// `# chunk` / `# raw_pending` / `# raw_terminal` block mid-entry); dropping
// more leading blocks only shrinks the body, so binary-search the most
// blocks that still fit. When even the preamble alone overflows, nothing fits.
function fitHandoffBlocks({ preamble, blocks, build, fits }) {
  const body = (kept) => [preamble, ...blocks.slice(blocks.length - kept)].filter(Boolean).join('\n\n');
  const best = largestFitting(0, blocks.length, (kept) => build(body(kept)), fits);
  if (best) return best;
  if (preamble) {
    const preambleOnly = build(preamble);
    if (fits(preambleOnly)) return preambleOnly;
  }
  return null;
}

// Plain newest-first handoff: preserve complete lines whenever possible,
// dropping only the oldest trailing lines. A single oversized line falls
// through to the character fit.
function fitHandoffLines(handoff, build, fits) {
  const lines = handoff.split('\n');
  if (lines.length <= 1) return null;
  return largestFitting(1, lines.length, (count) => build(lines.slice(0, count).join('\n')), fits);
}

function fitHandoffChars(handoff, build, fits) {
  return largestFitting(0, handoff.length, (length) => build(handoff.slice(0, length)), fits);
}

export function fitFreshContextSummaryMessage(oldHistory, handoffText, remainingTokens) {
  const handoff = String(handoffText || '').trim();
  const build = (body) => makeFreshContextSummaryMessageParts(oldHistory, body);
  const fits = (candidate) => estimateMessagesTokens([candidate]) <= remainingTokens;
  const minimal = build('');
  if (!fits(minimal)) return null;
  if (!handoff) return minimal;
  const { preamble, blocks } = splitMemoryHandoffRootBlocks(handoff);
  if (blocks.length > 0) return fitHandoffBlocks({ preamble, blocks, build, fits }) || minimal;
  return fitHandoffLines(handoff, build, fits) || fitHandoffChars(handoff, build, fits) || minimal;
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
const MEMORY_ROOT_BLOCK_HEADER_RE =
  /^# (?:chunk \d+ root=\d+(?: category=\S+)?|raw_pending \d+ id=\d+|raw_terminal \d+ id=\d+)[ \t]*$/;

function splitMemoryHandoffRootBlocks(text) {
  const value = String(text || '');
  if (!value.trim()) return { preamble: '', blocks: [] };
  const re = new RegExp(MEMORY_ROOT_BLOCK_HEADER_RE.source, 'gm');
  const starts = [];
  for (const m of value.matchAll(re)) starts.push(m.index);
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
