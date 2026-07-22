/**
 * Tool Result Compression — lossless-only chained passes.
 *
 * Pass order (each strictly reduce-only or self-guarded):
 *   1. stripAnsi                 — remove CSI / OSC escape sequences
 *   2. collapseCarriageReturns   — terminal `\r(?!\n)` is a cursor reset;
 *                                  bytes before the last \r on a line
 *                                  were overwritten and never visible.
 *                                  CRLF preserved.
 *   3. stripNulBytes             — NUL has no meaning in UTF-8 text;
 *                                  only present from binary-leak outputs
 *                                  already malformed.
 *   4. stripUtf8Bom              — leading U+FEFF is a metadata marker,
 *                                  not content. Only the leading BOM is
 *                                  stripped (interior FEFF kept).
 *   5. normalizeTrailingNewlines — trailing \n+ collapsed to single \n.
 *
 * All five passes are LOSSLESS w.r.t. semantically-relevant content:
 * each removes bytes that the terminal/file reader would have ignored
 * anyway (terminal-overwritten, binary garbage, BOM marker, trailing
 * blank lines). No dedup / separator collapse / whitespace rewrite /
 * middle-elision / long-line truncation is applied — those are lossy
 * and have been removed. Oversize results route to the recoverable
 * offload sidecar in session/tool-result-offload.mjs instead.
 *
 * Final expand guard: if the chained output is not strictly shorter
 * than the input, return the input unchanged.
 *
 * Compression is opt-in per tool: tools whose definition carries
 * `annotations.compressible: true` OR `annotations.compressibleLossless: true`
 * are processed. Both annotations now resolve to the same lossless
 * chain — there is no separate lossy tier.
 */

import * as nodeUtil from 'node:util';
import { traceAgentCompress, traceAgentBatch } from '../agent-trace.mjs';
import { BUILTIN_TOOLS } from './builtin.mjs';
import { PATCH_TOOL_DEFS } from './patch-tool-defs.mjs';
import { CODE_GRAPH_TOOL_DEFS } from './code-graph-tool-defs.mjs';

const ANSI_FALLBACK_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\|\x9c))/g;

const ALL_TOOL_DEFS = [...BUILTIN_TOOLS, ...PATCH_TOOL_DEFS, ...CODE_GRAPH_TOOL_DEFS];
const _stripAnsiImpl = typeof globalThis.Bun?.stripANSI === 'function'
    ? (s) => globalThis.Bun.stripANSI(s)
    : (typeof nodeUtil.stripVTControlCharacters === 'function'
        ? (s) => nodeUtil.stripVTControlCharacters(s)
        : (s) => String(s).replace(ANSI_FALLBACK_RE, () => ''));

function bareToolName(name) {
    if (typeof name !== 'string' || !name) return name;
    const m = name.match(/^mcp__.+?__(.+)$/);
    return m ? m[1] : name;
}

function isCompressionEligible(name) {
    const bare = bareToolName(name);
    const def = ALL_TOOL_DEFS.find(t => t.name === bare);
    if (!def) return false;
    return def.annotations?.compressible === true
        || def.annotations?.compressibleLossless === true;
}

// Grep (and read, if ever compressed) carry file bytes that may include literal
// `\r` in source; terminal-style CR collapse would delete content.
function skipCarriageReturnCollapse(toolName) {
    const bare = bareToolName(toolName);
    return bare === 'grep' || bare === 'read';
}

export function stripAnsi(text) {
    if (typeof text !== 'string') return text;
    return _stripAnsiImpl(text);
}

// Carriage-return overwrite collapse. In a terminal, `\r` not followed
// by `\n` resets the cursor to column 0; the next print overwrites the
// line. Anything between the previous `\n` (or string start) and the
// last `\r(?!\n)` on the same line was visually overwritten before the
// user ever saw it. Lossless w.r.t. terminal display. CRLF (`\r\n`) is
// the standard Windows line ending and is preserved by the negative
// lookahead. JSON/text outputs that contain literal `\r` escape
// sequences (`\\r`) are NOT affected because those decode to two
// characters (`\` + `r`), not a real `\r`.
function collapseCarriageReturns(text) {
    if (typeof text !== 'string') return text;
    if (text.indexOf('\r') === -1) return text;
    let out = '';
    let lineStart = 0;
    let keepStart = 0;
    let changed = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        if (ch === 13) {
            if (text.charCodeAt(i + 1) === 10) continue;
            if (!changed) {
                out = text.slice(0, lineStart);
                changed = true;
            }
            keepStart = i + 1;
        } else if (ch === 10) {
            if (changed) out += text.slice(keepStart, i + 1);
            lineStart = i + 1;
            keepStart = lineStart;
        }
    }
    if (!changed) return text;
    return out + text.slice(keepStart);
}

// NUL byte strip. UTF-8 text has no semantic use for NUL (\x00); the
// only way it appears in a tool result is from a binary-leak output
// (e.g. cat on a binary, ill-formed log). The result is already
// malformed for the LLM context; removing the NUL bytes neither helps
// nor harms semantics, just trims noise.
function stripNulBytes(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/\x00/g, '');
}

// UTF-8 BOM strip (leading only). U+FEFF at the start of a text stream
// is a byte-order marker / encoding hint, not content; some editors and
// the Windows powershell pipeline insert it. Interior FEFF is left
// alone (it could be intentional in the data).
function stripUtf8Bom(text) {
    if (typeof text !== 'string') return text;
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

// Trailing-newline normalize. Tool outputs frequently end with several
// blank lines (shell prompts, redirected stdout buffer flush) that
// carry no information. Collapsing the tail to a single trailing
// newline preserves the file-ends-with-newline convention while
// stripping the visually-empty padding.
function normalizeTrailingNewlines(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/\n+$/, '\n');
}

// Retained as named exports for non-tool-result consumers (agent
// aggregated worker bodies in ai-wrapped-dispatch). These functions are
// NO LONGER part of the tool-result compression chain — that chain is
// lossless-only.
function normalizeWhitespace(text) {
    if (typeof text !== 'string') return text;
    return text
        .split('\n')
        .map(line => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');
}

function dedupRepeatedLines(text) {
    if (typeof text !== 'string') return text;
    const lines = text.split('\n');
    const out = [];
    let prev = null;
    let dupRun = 0;
    const flush = () => {
        if (dupRun === 0) return;
        if (dupRun < 5) {
            for (let i = 0; i < dupRun; i++) out.push(prev);
        } else {
            out.push(`  (×${dupRun + 1} identical lines collapsed)`);
        }
        dupRun = 0;
    };
    for (const line of lines) {
        if (prev !== null && line === prev) {
            dupRun += 1;
        } else {
            flush();
            out.push(line);
            prev = line;
            dupRun = 0;
        }
    }
    flush();
    return out.join('\n');
}

export function compressToolResult(toolName, args, result, ctx) {
    if (typeof result !== 'string') return result;
    if (!isCompressionEligible(toolName)) return result;
    const before = result.length;
    let out = stripAnsi(result);
    if (!skipCarriageReturnCollapse(toolName)) {
        out = collapseCarriageReturns(out);
    }
    out = stripNulBytes(out);
    out = stripUtf8Bom(out);
    out = normalizeTrailingNewlines(out);
    if (out.length >= before) return result;
    if (ctx?.sessionId) {
        try { traceAgentCompress({ sessionId: ctx.sessionId, toolName, before, after: out.length }); } catch { /* trace best-effort */ }
    }
    return out;
}

// Per-turn batch shape recorder. Called once per assistant turn (right
// after the model returns toolCalls) with the count. Trace consumers
// can compute multi-tool adoption ratio (calls > 1 / total turns)
// directly from these rows instead of re-parsing every assistant
// message body.
export function recordToolBatch(sessionId, toolCallCount) {
    const n = Number(toolCallCount);
    if (!sessionId || !Number.isFinite(n) || n <= 0) return;
    try { traceAgentBatch({ sessionId, toolCallCount: n }); } catch { /* trace best-effort */ }
}

export const _internals = {
    collapseCarriageReturns,
    normalizeTrailingNewlines,
    stripNulBytes,
    stripUtf8Bom,
};

// R17 — structural tail-trim for verbose tool outputs (Lead-direct / loop paths).
const TAIL_TRIM_MIN_LINES = 300;
const TAIL_TRIM_MIN_BYTES = 8192;
const TAIL_TRIM_HEAD = 30;
const TAIL_TRIM_TAIL = 80;
const TAIL_TRIM_MAX_LINE_CHARS = 2_000;

function _trimLongLines(content) {
    const lines = content.split('\n');
    let changed = false;
    const out = lines.map((line) => {
        if (line.length <= TAIL_TRIM_MAX_LINE_CHARS) return line;
        changed = true;
        const cps = [...line];
        const head = cps.slice(0, 1_500).join('');
        const tail = cps.slice(-300).join('');
        return `${head} ... [line truncated: ${line.length} chars total] ... ${tail}`;
    });
    return changed ? out.join('\n') : content;
}

/**
 * @param {string} content
 * @param {{ trimLongLines?: boolean, fullOutputPath?: string, sequential?: boolean }} [opts]
 */
function tailTrimLargeOutput(content, opts = {}) {
    if (typeof content !== 'string') return content;
    let text = content;
    if (opts.trimLongLines) {
        const trimmed = _trimLongLines(text);
        // Apply long-line trimming, then FALL THROUGH to the byte/line tail-trim
        // so a still-oversized (many-line) result is also capped. Returning here
        // skipped tail-trim and the full-output marker for such output.
        if (trimmed !== text) text = trimmed;
    }
    if (Buffer.byteLength(text, 'utf8') <= TAIL_TRIM_MIN_BYTES) return text;
    const lines = text.split('\n');
    if (lines.length <= TAIL_TRIM_MIN_LINES) return text;
    const elided = lines.length - TAIL_TRIM_HEAD - TAIL_TRIM_TAIL;
    if (elided <= 0) return text;
    const totalBytes = Buffer.byteLength(text, 'utf8');
    // Sequential outputs (e.g. a windowed `read`) are consumed front-to-back:
    // a head+tail keep destroys the middle the caller explicitly asked for.
    // Keep the head intact within the same line budget and tell the caller
    // how to continue instead.
    if (opts.sequential) {
        const kept = TAIL_TRIM_HEAD + TAIL_TRIM_TAIL;
        const head = lines.slice(0, kept);
        let marker = `\n... ${lines.length - kept} lines elided of ${lines.length} total (${totalBytes} bytes) — head kept intact; sequential output: re-run with offset advanced past the last line above ...\n`;
        if (opts.fullOutputPath) {
            marker += `[full output saved: ${opts.fullOutputPath}]\n`;
        }
        return head.join('\n') + marker;
    }
    const head = lines.slice(0, TAIL_TRIM_HEAD);
    const tail = lines.slice(lines.length - TAIL_TRIM_TAIL);
    let marker = `\n... ${elided} lines elided, total ${totalBytes} bytes — head ${TAIL_TRIM_HEAD} + tail ${TAIL_TRIM_TAIL} lines kept ...\n`;
    if (opts.fullOutputPath) {
        marker += `[full output saved: ${opts.fullOutputPath}]\n`;
    }
    return head.join('\n') + marker + tail.join('\n');
}
