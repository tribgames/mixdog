// Post-compact file re-attachment (claude-code createPostCompactFileAttachments
// parity). Files the summarized-away head had `read` are re-read FRESH from
// disk and re-injected right after the summary message, so the model does not
// burn a turn (and tokens) re-reading files it was actively working with.
//  - newest-first, capped at MAX_REATTACH_FILES and per-file/total token caps
//  - files whose `read` tool_call survives in the preserved tail are skipped
//    (the model can already see that content — re-injecting is pure waste)
//  - message shape reuses the existing `Reference files:` user-row convention
//    (session-lifecycle.mjs), which memory ingest already excludes.
// Best-effort: any fs/parse failure skips the file, never fails the compact.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { estimateTokens } from '../context-utils.mjs';

export const MAX_REATTACH_FILES = 3;
const REATTACH_MAX_TOKENS_PER_FILE = 5_000;
export const REATTACH_MAX_TOTAL_TOKENS = 8_000;
const REATTACH_MIN_ROOM_TOKENS = 1_024;
const REATTACH_MAX_FILE_BYTES = 512 * 1024;

function reattachDisabled() {
    return String(process.env.MIXDOG_COMPACT_FILE_REATTACH || '').trim() === '0';
}

function pathsFromReadArgs(rawArgs) {
    let args = rawArgs;
    if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { return []; }
    }
    if (!args || typeof args !== 'object') return [];
    const value = args.path;
    const entries = Array.isArray(value) ? value : [value];
    const out = [];
    for (const entry of entries) {
        if (typeof entry === 'string' && entry.trim()) out.push(entry.trim());
        else if (entry && typeof entry === 'object' && typeof entry.path === 'string' && entry.path.trim()) {
            out.push(entry.path.trim());
        }
    }
    return out;
}

// Ordered (oldest -> newest) file paths read via the `read` tool in `messages`.
function collectReadToolPaths(messages) {
    const out = [];
    for (const m of Array.isArray(messages) ? messages : []) {
        if (m?.role !== 'assistant' || !Array.isArray(m.toolCalls)) continue;
        for (const tc of m.toolCalls) {
            const name = String(tc?.name || tc?.function?.name || '').toLowerCase();
            if (name !== 'read') continue;
            out.push(...pathsFromReadArgs(tc?.arguments ?? tc?.function?.arguments));
        }
    }
    return out;
}

function truncateToTokenCap(content, cap) {
    if (estimateTokens(content) <= cap) return content;
    const marker = '\n[truncated after compaction — Read the full file if needed]';
    // ~4 chars/token head-keep; iterate down until the estimate fits.
    let chars = Math.max(0, cap * 4);
    let out = content.slice(0, chars) + marker;
    while (chars > 256 && estimateTokens(out) > cap) {
        chars = Math.floor(chars * 0.8);
        out = content.slice(0, chars) + marker;
    }
    return out;
}

/**
 * Build ONE `Reference files:` user message re-attaching the freshest files the
 * compacted-away head had read, or null when nothing qualifies/fits.
 * `roomTokens` is the remaining post-compact budget the attachment may use.
 */
export function buildPostCompactFileAttachment(headMessages, tailMessages, roomTokens, { cwd } = {}) {
    if (reattachDisabled()) return null;
    const room = Math.min(Number(roomTokens) || 0, REATTACH_MAX_TOTAL_TOKENS);
    if (room < REATTACH_MIN_ROOM_TOKENS) return null;
    const headPaths = collectReadToolPaths(headMessages);
    if (headPaths.length === 0) return null;
    const tailPaths = new Set(collectReadToolPaths(tailMessages));
    // newest-first unique selection
    const selected = [];
    const seen = new Set();
    for (let i = headPaths.length - 1; i >= 0 && selected.length < MAX_REATTACH_FILES; i -= 1) {
        const p = headPaths[i];
        if (seen.has(p) || tailPaths.has(p)) continue;
        seen.add(p);
        selected.push(p);
    }
    if (selected.length === 0) return null;
    const sections = [];
    const prefix = 'Reference files:\n\nRe-attached after compaction (fresh reads of files the summarized history was working with):\n\n';
    for (const p of selected) {
        try {
            const abs = isAbsolute(p) ? p : (cwd ? resolvePath(cwd, p) : null);
            if (!abs) continue;
            const stat = statSync(abs);
            if (!stat.isFile() || stat.size > REATTACH_MAX_FILE_BYTES) continue;
            const body = truncateToTokenCap(readFileSync(abs, 'utf8'), REATTACH_MAX_TOKENS_PER_FILE);
            const section = `### ${p}\n\`\`\`\n${body}\n\`\`\``;
            const candidate = `${prefix}${[...sections, section].join('\n\n')}`;
            if (estimateTokens(candidate) > room) continue;
            sections.push(section);
        } catch { /* unreadable/missing file — skip, never fail the compact */ }
    }
    if (sections.length === 0) return null;
    return {
        role: 'user',
        content: `${prefix}${sections.join('\n\n')}`,
    };
}
