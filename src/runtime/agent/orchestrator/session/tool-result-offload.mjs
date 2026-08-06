import { existsSync, mkdirSync } from 'fs';
import { readdir, rmdir, stat, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { getPluginData } from '../config.mjs';
import { normalizeOutputPath } from '../tools/builtin/path-utils.mjs';
import { classifyResultKind } from './result-classification.mjs';

const TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS = 50_000;
const TOOL_RESULT_PREVIEW_CHARS = 2_000;
const TOOL_RESULT_SHELL_THRESHOLD_CHARS = 30_000;
const TOOL_RESULT_SEARCH_THRESHOLD_CHARS = 50_000;
const TOOL_RESULT_GREP_THRESHOLD_CHARS = 20_000;
export const TOOL_RESULT_MESSAGE_MAX_CHARS = 200_000;
const TOOL_RESULT_OFFLOAD_PREFIX = '[tool output offloaded:';
const OFFLOAD_PRUNE_MIN_AGE_MS = 10 * 60 * 1000;
// clearOffloadSession only runs on a CLEAN session close, so every killed
// process leaves its tool-results/<session>/ sidecars behind forever. Sweep
// directories whose NEWEST file is past the TTL (a session still writing must
// survive), at most once per interval per process.
const OFFLOAD_SESSION_STALE_MS = 24 * 60 * 60 * 1000;
const OFFLOAD_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let _offloadSweptAt = 0;

async function sweepStaleOffloadDirs() {
    const root = join(getPluginData(), 'tool-results');
    let names;
    try { names = await readdir(root); } catch { return; }
    const cutoff = Date.now() - OFFLOAD_SESSION_STALE_MS;
    await Promise.all(names.map(async (name) => {
        const dir = join(root, name);
        try {
            const dirStat = await stat(dir);
            if (!dirStat.isDirectory()) return;
            const entries = await readdir(dir);
            let newest = dirStat.mtimeMs;
            await Promise.all(entries.map(async (entry) => {
                try {
                    const fileStat = await stat(join(dir, entry));
                    if (fileStat.mtimeMs > newest) newest = fileStat.mtimeMs;
                } catch { /* vanished mid-sweep */ }
            }));
            if (newest >= cutoff) return;
            await Promise.all(entries.map((entry) => unlink(join(dir, entry)).catch(() => {})));
            await rmdir(dir).catch(() => { /* raced a live writer */ });
        } catch { /* best-effort */ }
    }));
}

function maybeSweepStaleOffloadDirs() {
    if (Date.now() - _offloadSweptAt < OFFLOAD_SWEEP_INTERVAL_MS) return;
    _offloadSweptAt = Date.now();
    void sweepStaleOffloadDirs();
}

// Per-tool persistence limits mirror reference per-tool maxResultSizeChars
// rather than a single global value: Grep persists at 20k (CC GrepTool), Glob
// and list/find_* at the 50k system default (CC DEFAULT_MAX_RESULT_SIZE_CHARS;
// tighter than CC Glob's 100k by design), and shell/bash_session/task at 30k
// (CC BASH_MAX_OUTPUT_LENGTH default). Read/head/tail/diff stay inline
// (Infinity) — they are self-bound by FileRead semantics and the upstream
// READ_MAX_SIZE_BYTES cap, so persisting to a sidecar to be re-read would be
// circular. These values keep context-rich IO tools from turning into "read
// saved output" loops while bounding the per-call inline footprint per CC.
// Skill / skill_view bodies stay inline for the same reason — offloading a
// loaded SKILL.md would force a read loop and defeat the loaded-skill guard.
const INLINE_THRESHOLD_BY_TOOL = new Map([
    ['read', Infinity],
    ['head', Infinity],
    ['tail', Infinity],
    ['diff', Infinity],
    ['skill', Infinity],
    ['skill_view', Infinity],
    ['skills_list', Infinity],
    ['grep', TOOL_RESULT_GREP_THRESHOLD_CHARS],
    ['glob', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['list', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['tree', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['find_files', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['code_graph', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['shell', TOOL_RESULT_SHELL_THRESHOLD_CHARS],
    ['bash_session', TOOL_RESULT_SHELL_THRESHOLD_CHARS],
    ['task', TOOL_RESULT_SHELL_THRESHOLD_CHARS],
]);

function getOffloadThreshold(toolName) {
    const key = String(toolName || '').toLowerCase();
    return INLINE_THRESHOLD_BY_TOOL.get(key) ?? TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS;
}

const AGGREGATE_OFFLOAD_EXCLUDED_TOOLS = new Set([
    'read',
    'head',
    'tail',
    'diff',
    'skill',
    'skill_view',
    'skills_list',
]);

export function isAggregateOffloadEligible(toolName, result) {
    if (typeof result !== 'string') return false;
    const key = String(toolName || '').toLowerCase();
    return !AGGREGATE_OFFLOAD_EXCLUDED_TOOLS.has(key);
}

export function rankAggregateOffloadCandidates(entries) {
    return entries
        .map((entry, index) => ({
            index,
            length: typeof entry?.result === 'string' ? entry.result.length : 0,
            eligible: isAggregateOffloadEligible(entry?.toolName, entry?.result)
                && !String(entry?.result || '').startsWith(TOOL_RESULT_OFFLOAD_PREFIX),
        }))
        .filter((entry) => entry.eligible)
        .sort((a, b) => b.length - a.length || b.index - a.index)
        .map((entry) => entry.index);
}

// Sanitize sessionId before using it as a path segment. A raw `..` or slash
// would let the sidecar dir — and clearOffloadSession's readdir+unlink — escape
// the tool-results root (arbitrary .txt deletion). Strip to [A-Za-z0-9_-];
// dropping '.' collapses '..' to '__'. Real ids are sess_<digits>, unaffected.
function safeSessionSegment(sessionId) {
    return String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200) || '_invalid';
}

function ensureToolResultsDir(sessionId) {
    const dir = join(getPluginData(), 'tool-results', safeSessionSegment(sessionId));
    // Fire-and-forget GC on the first offload of each interval — never awaited,
    // so an offload write is not delayed by the reclaim walk.
    maybeSweepStaleOffloadDirs();
    // R4 data-at-rest: offloaded tool output may contain secrets / file
    // contents; clamp dir to owner-only on POSIX (advisory on Windows).
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

// Map tool-call IDs to safe generated filenames. toolCallId arrives from
// the provider and may contain path-unsafe characters (slashes, dots, etc.).
// Use a monotonic counter keyed by sessionId so the sidecar path is
// deterministic-ish within a session but never tainted by provider input.
const _offloadCounters = new Map();

function buildPreview(text, maxChars = TOOL_RESULT_PREVIEW_CHARS) {
    if (text.length <= maxChars) {
        return { preview: text, truncated: false };
    }
    const headBudget = Math.floor(maxChars * 0.6);
    const tailBudget = maxChars - headBudget;
    let head = text.slice(0, headBudget);
    const headCut = head.lastIndexOf('\n');
    if (headCut > Math.floor(headBudget * 0.6)) head = head.slice(0, headCut);
    let tail = text.slice(Math.max(0, text.length - tailBudget));
    const tailCut = tail.indexOf('\n');
    if (tailCut !== -1 && tailCut < Math.floor(tailBudget * 0.4)) tail = tail.slice(tailCut + 1);
    const omittedKb = Math.max(1, Math.round((text.length - head.length - tail.length) / 1024));
    return {
        preview: `${head}\n\n... [preview middle omitted — ${omittedKb} KB] ...\n\n${tail}`,
        truncated: true,
    };
}

function countLines(text) {
    if (!text) return 0;
    let lines = 1;
    for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) === 10) lines += 1;
    }
    return lines;
}

export async function maybeOffloadToolResult(sessionId, toolCallId, toolName, result, options = {}) {
    if (!sessionId || !toolCallId) return result;
    if (typeof result !== 'string') return result;
    if (result.startsWith(TOOL_RESULT_OFFLOAD_PREFIX)) return result;
    const force = options?.force === true;
    if (!force && result.length <= getOffloadThreshold(toolName)) return result;
    // Keep error surfaces inline so the model can self-correct without an
    // extra read turn — but only up to the global default. A giant error
    // (e.g. a megabyte of stack/diff/dump) still offloads so it can't blow up
    // context; small errors (the overwhelming majority) stay inline.
    if (!force && classifyResultKind(result) === 'error'
        && result.length <= TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS) return result;

    // Generate a safe filename — never trust toolCallId as a path component.
    const count = (_offloadCounters.get(sessionId) ?? 0) + 1;
    _offloadCounters.set(sessionId, count);
    const safeId = `r${count}`;

    const dir = ensureToolResultsDir(sessionId);
    const filePath = join(dir, `${safeId}.txt`);

    // Count lines while the string is in hand — single pass, no re-read.
    const lines = countLines(result);
    await writeFile(filePath, result, { encoding: 'utf-8', mode: 0o600 });

    const { preview, truncated } = buildPreview(result);
    const sizeKb = Math.max(1, Math.round(result.length / 1024));
    const displayPath = normalizeOutputPath(filePath);
    const header = `${TOOL_RESULT_OFFLOAD_PREFIX} ${toolName} → ${displayPath} (${sizeKb} KB, ${lines} lines)]`;
    const suffix = truncated ? '\n... [preview truncated — use read on the saved path for full output]' : '';
    return `${header}\n\n${preview}${suffix}`;
}

// Apply per-tool persistence first, then enforce the message-level
// budget across the remaining non-Read text results. Selection is
// largest-first; ties prefer the latest result in the assistant tool batch.
export async function maybeOffloadToolResultBatch(sessionId, entries, options = {}) {
    const source = Array.isArray(entries) ? entries : [];
    const maxChars = Number(options.maxAggregateChars) > 0
        ? Math.trunc(Number(options.maxAggregateChars))
        : TOOL_RESULT_MESSAGE_MAX_CHARS;
    const applyPerToolLimits = options.applyPerToolLimits !== false;
    const offloadResult = typeof options.offloadResult === 'function'
        ? options.offloadResult
        : maybeOffloadToolResult;
    const states = source.map((entry) => ({ result: entry?.result, error: null }));

    if (applyPerToolLimits) {
        await Promise.all(source.map(async (entry, index) => {
            try {
                states[index].result = await offloadResult(
                    sessionId,
                    entry?.toolCallId,
                    entry?.toolName,
                    entry?.result,
                    { force: false },
                );
            } catch (error) {
                states[index].error = error;
            }
        }));
    }

    const inlineChars = () => states.reduce((total, state, index) => (
        state.error || !isAggregateOffloadEligible(source[index]?.toolName, state.result)
            ? total
            : total + state.result.length
    ), 0);
    let total = inlineChars();
    const attempted = new Set();
    while (total > maxChars) {
        const ranked = rankAggregateOffloadCandidates(source.map((entry, index) => ({
            toolName: entry?.toolName,
            result: states[index].error || attempted.has(index) ? null : states[index].result,
        })));
        if (ranked.length === 0) break;
        const index = ranked[0];
        attempted.add(index);
        const before = states[index].result;
        try {
            states[index].result = await offloadResult(
                sessionId,
                source[index]?.toolCallId,
                source[index]?.toolName,
                before,
                { force: true },
            );
            total += String(states[index].result || '').length - before.length;
        } catch (error) {
            states[index].error = error;
            total -= before.length;
        }
    }
    return states;
}

// Drop a session's offload sidecars on session close. Unlinks every
// tool-results/<sessionId>/*.txt entry, rmdirs the directory, and drops
// the sessionId entry from the module-level counter Map so a long-running
// mcp-server process doesn't accumulate per-session state across the
// lifetime of the agent runtime.
export async function clearOffloadSession(sessionId) {
    if (!sessionId) return;
    _offloadCounters.delete(sessionId);
    const dir = join(getPluginData(), 'tool-results', safeSessionSegment(sessionId));
    if (!existsSync(dir)) return;
    try {
        const entries = await readdir(dir);
        await Promise.all(entries
            .filter((name) => name.endsWith('.txt'))
            .map((name) => unlink(join(dir, name)).catch(() => { /* best-effort */ })));
        await rmdir(dir).catch(() => { /* best-effort: non-empty / already gone */ });
    } catch { /* best-effort */ }
}

// Remove sidecars that no longer occur in the live transcript. A serialized
// path match is conservative: if messages cannot be serialized, or a path is
// mentioned anywhere in a message, retain the file rather than risk deleting
// one that can still be read by the model.
export async function pruneOffloadSession(sessionId, getMessages) {
    if (!sessionId || typeof getMessages !== 'function') return;
    const dir = join(getPluginData(), 'tool-results', safeSessionSegment(sessionId));
    if (!existsSync(dir)) return;
    let candidates;
    try {
        const entries = await readdir(dir);
        candidates = (await Promise.all(entries
            .filter((name) => name.endsWith('.txt'))
            .map(async (name) => {
                const filePath = join(dir, name);
                try {
                    const fileStat = await stat(filePath);
                    if (Date.now() - fileStat.mtimeMs < OFFLOAD_PRUNE_MIN_AGE_MS) return null;
                    return { name, filePath };
                } catch {
                    return null;
                }
            })
        )).filter(Boolean);
    } catch { /* best-effort */ }
    if (!candidates) return;
    let serialized;
    try { serialized = JSON.stringify(getMessages()); } catch { return; }
    const haystack = process.platform === 'win32' ? serialized.toLowerCase() : serialized;
    await Promise.all(candidates
        .filter(({ name, filePath }) => {
            const normalizedPath = normalizeOutputPath(filePath);
            const needles = [normalizedPath, name];
            return !needles.some((needle) => {
                const value = process.platform === 'win32' ? needle.toLowerCase() : needle;
                return haystack.includes(value);
            });
        })
        .map(({ filePath }) => unlink(filePath).catch(() => { /* best-effort */ })));
}

export function isOffloadedToolResultText(text) {
    return typeof text === 'string' && text.startsWith(TOOL_RESULT_OFFLOAD_PREFIX);
}

function compactOffloadedToolResultText(text) {
    if (!isOffloadedToolResultText(text)) return text;
    const value = String(text);
    const lineEnd = value.indexOf('\n');
    const firstLine = lineEnd === -1 ? value : value.slice(0, lineEnd);
    return `${firstLine}\n[preview omitted — use read on the saved path if needed]`;
}

export const _internals = {
    TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS,
    TOOL_RESULT_SHELL_THRESHOLD_CHARS,
    TOOL_RESULT_SEARCH_THRESHOLD_CHARS,
    TOOL_RESULT_GREP_THRESHOLD_CHARS,
    getOffloadThreshold,
    TOOL_RESULT_PREVIEW_CHARS,
    buildPreview,
    countLines,
};
