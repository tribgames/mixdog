// Semantic-summary schema machinery: required-section anchors, heading
// matching, schema validation, deterministic repair/backfill, minimal
// schema-valid scaffold, and section-aware truncation. Extracted verbatim
// from summary.mjs (behavior-preserving) — summary.mjs re-exports the
// public entry points so the compact/ facade surface is unchanged.
import {
    extractText,
    truncateMiddle,
} from './text-utils.mjs';
import {
    isProtectedContextUserMessage,
    isInjectedSkillBodyMessage,
} from './messages.mjs';

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
    let inFence = false;
    for (const rawLine of String(summary || '').split('\n')) {
        const line = rawLine.trim();
        if (/^(?:```|~~~)/.test(line)) { inFence = !inFence; continue; }
        if (inFence) continue;
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
export function summaryIsSchemaValid(summary) {
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
    let inFence = false;
    for (const rawLine of String(text || '').split('\n')) {
        const trimmed = rawLine.trim();
        const line = rawLine.replace(/\s+$/, '');
        if (/^(?:```|~~~)/.test(trimmed)) {
            inFence = !inFence;
            if (current) map.get(current).push(line);
            continue;
        }
        if (!inFence && /^##\s+/.test(trimmed) && !/^###\s+/.test(trimmed)) {
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

export function summaryHasUnrecognizedHeadings(summary) {
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
        let found = null;
        for (const [heading, body] of present) {
            if (headingMatchesAnchor(heading, anchor)) {
                if (!found) found = [];
                found.push(...(body || []));
            }
        }
        return found;
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

// A headings-only structured summary: every required `## ` (and Progress `### `)
// anchor present with `- (none)` bodies. This is the minimal schema-valid shape
// the fitter can fall back to when token pressure cannot hold real section
// bodies — it still passes summaryIsSchemaValid so the injected message is
// never partial.
export function minimalSchemaSummary() {
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
export function truncateSummaryBySections(summary, perSectionChars) {
    const sections = parseSummarySections(summary);
    const out = [];
    for (const section of SUMMARY_SECTION_LAYOUT) {
        if (out.length) out.push('');
        out.push(section.heading);
        let body = null;
        for (const [heading, lines] of sections) {
            if (headingMatchesAnchor(heading, section.anchor)) {
                if (!body) body = [];
                body.push(...(lines || []));
            }
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
