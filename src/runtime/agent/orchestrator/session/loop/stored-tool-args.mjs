// Stored tool-call argument compaction/restoration, extracted from loop.mjs.
// Long body/command args are truncated with a sha256-tagged head/tail preview
// when persisted into assistant history. A FAILED call restores its full text
// (command/script AND mutation bodies): the failed mutation rolled back, so its
// patch text is the model's own draft, and leaving only the marker made models
// copy `[mixdog compacted …]` back as literal patch input.
//
// Mutation bodies (patch / old_string / new_string / content / rewrite) are
// never collapsed after the fact. The sweep that used to do it (deferBodies
// plus a settled-body pass on the next push) rewrote a prefix the provider had
// already cached, and every rewrite re-billed that whole request at the
// uncached rate. Measured over one 89-task run: $1.20 lost to recover $0.16,
// because the collapsed tokens only come back at the cached rate over the
// REMAINING turns, and a task rarely has enough of them left. Bodies now stay
// verbatim in history, so the prefix — and its cache — survives the session.
import { createHash } from 'crypto';

const STORED_TOOL_ARG_BODY_KEY_RE = /^(?:content|old_string|new_string|patch|rewrite)$/i;
const STORED_TOOL_ARG_LONG_KEY_RE = /^(?:command|script)$/i;
// Marker-alone value produced by compactStoredToolArgString for body keys.
const STORED_TOOL_ARG_MARKER_RE = /^\[mixdog compacted\b[^\]\n]*\]$/;
// One shared budget for stored bodies AND long commands, matching the codex
// reference truncation budget (TruncationPolicyConfig::bytes(10_000)). Below
// this, the model always sees its own recent patch text verbatim — the 2 KB
// body cut made every mid-size successful patch render as a marker and Opus
// mimicked the marker as literal patch input on the next call.
const STORED_TOOL_ARG_LIMIT = 10_000;
const STORED_TOOL_ARG_PREVIEW_HEAD = 360;
const STORED_TOOL_ARG_PREVIEW_TAIL = 160;

// File paths a compacted patch touched, so the marker identifies the already
// applied mutation without exposing copyable patch fragments (measured:
// compacted-placeholder resubmission was 39% of apply_patch failures). Marker
// contract: the returned text may not contain ']' or a
// newline, so bracket characters are stripped from paths.
function _compactedPatchTargets(value) {
    const seen = new Set();
    const add = (raw) => {
        const p = String(raw || '').trim().replace(/[\[\]\r\n]/g, '');
        if (p && p !== '/dev/null' && !seen.has(p)) seen.add(p);
    };
    const v4a = /^\*\*\*\s*(?:Update|Add|Delete) File:\s*(.+)$/gim;
    for (let m; seen.size < 12 && (m = v4a.exec(value));) add(m[1]);
    if (!seen.size) {
        const uni = /^(?:\+\+\+|---)\s+(?:[ab]\/)?(\S+)/gm;
        for (let m; seen.size < 12 && (m = uni.exec(value));) add(m[1]);
    }
    const all = [...seen];
    const shown = all.slice(0, 4).map((p) => (p.length > 70 ? `…${p.slice(-70)}` : p));
    if (!shown.length) return '';
    const more = all.length > shown.length ? ` +${all.length - shown.length} more` : '';
    return `${shown.join(', ')}${more}`;
}

function compactStoredToolArgString(value, key = '', opts = {}) {
    if (typeof value !== 'string') return value;
    const isBody = STORED_TOOL_ARG_BODY_KEY_RE.test(key);
    if (isBody && opts.deferBodies === true) return value;
    const isLong = isBody || STORED_TOOL_ARG_LONG_KEY_RE.test(key);
    const limit = isLong ? STORED_TOOL_ARG_LIMIT : Infinity;
    if (value.length <= limit) return value;
    // A marker is about to replace verbatim text — report the mutation so
    // sweep callers can tag the resulting prefix-cache break.
    try { opts.onCompacted?.(); } catch { /* observability only */ }
    const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
    // Body markers are status-only. Recovery policy belongs to the shared
    // rules; embedding an action here made models re-read successful edits.
    const targets = /^patch$/i.test(key) ? _compactedPatchTargets(value) : '';
    const marker = isBody
        ? (targets
            ? `[mixdog compacted ${key}: ${value.length} chars, sha256:${hash}; already applied to ${targets}; do not copy or repeat]`
            : `[mixdog compacted ${key}: ${value.length} chars, sha256:${hash}; already applied; do not copy or repeat]`)
        : `[mixdog compacted ${key || 'string'}: ${value.length} chars, sha256:${hash}; do not copy]`;
    // Body args (patch / old_string / new_string / content / rewrite) are
    // apply_patch / edit inputs. Keeping a head/tail preview leaves real patch
    // fragments (a "*** Begin Patch" opening, diff lines) inside a SUCCESSFUL
    // history entry that the model can copy back verbatim as new tool input.
    // Emit the marker ALONE for these keys so nothing copyable survives,
    // including after a failed call.
    if (isBody) return marker;
    const head = value.slice(0, STORED_TOOL_ARG_PREVIEW_HEAD).replace(/\r\n/g, '\n');
    const tail = value.slice(-STORED_TOOL_ARG_PREVIEW_TAIL).replace(/\r\n/g, '\n');
    return `${marker}\n${head}\n... [middle omitted from stored tool-call args] ...\n${tail}`;
}

function compactStoredToolArgValue(value, key = '', depth = 0, opts = {}) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return compactStoredToolArgString(value, key, opts);
    if (typeof value !== 'object') return value;
    if (depth >= 6) return Array.isArray(value) ? `[${value.length} items]` : '{...}';
    if (Array.isArray(value)) {
        return value.map((item) => compactStoredToolArgValue(item, key, depth + 1, opts));
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = compactStoredToolArgValue(v, k, depth + 1, opts);
    }
    return out;
}

export function compactToolCallsForHistory(calls, opts = {}) {
    if (!Array.isArray(calls)) return calls;
    return calls.map((call) => {
        if (!call || typeof call !== 'object') return call;
        return {
            ...call,
            arguments: compactStoredToolArgValue(call.arguments, '', 0, opts),
        };
    });
}

// Restore retry-safe long command/script text for ONE failed tool call inside a
// history assistant message whose toolCalls were compacted at push time.
// Mutation bodies (patch, old_string, new_string, content, rewrite) are restored
// too: this call failed, so nothing it described is on disk (sections roll back)
// and the body is the model's own draft to correct. Only a value that is still
// the marker is replaced, so a body already carrying real text is never
// overwritten. Must run BEFORE the message is first transmitted so it never
// mutates an already-cached prefix.
//
// Restoration reaches command/script and body keys at ANY depth. Every other
// field is taken from the compacted snapshot captured at push time.
export function restoreToolCallBodyForId(assistantMsg, originalCalls, callId) {
    if (!assistantMsg || !Array.isArray(assistantMsg.toolCalls) || !callId) return;
    if (!Array.isArray(originalCalls)) return;
    const tc = assistantMsg.toolCalls.find((t) => t && t.id === callId);
    const orig = originalCalls.find((c) => c && c.id === callId);
    if (!tc || !orig) return;
    if (!tc.arguments || typeof tc.arguments !== 'object'
        || !orig.arguments || typeof orig.arguments !== 'object') return;
    tc.arguments = _restoreCompactedBodies(tc.arguments, orig.arguments, '');
}

// Recursively rebuild a compacted args tree: replace retry-safe long
// command/script fields and still-compacted mutation bodies with their full
// originals; every other field stays as captured in the compacted snapshot.
function _restoreCompactedBodies(tcVal, origVal, key) {
    if (STORED_TOOL_ARG_BODY_KEY_RE.test(key)) {
        if (typeof tcVal === 'string' && typeof origVal === 'string'
            && STORED_TOOL_ARG_MARKER_RE.test(tcVal.trim())) {
            return origVal;
        }
        return tcVal;
    }
    if (STORED_TOOL_ARG_LONG_KEY_RE.test(key) && typeof origVal === 'string') {
        return origVal;
    }
    if (Array.isArray(tcVal) && Array.isArray(origVal)) {
        return tcVal.map((item, i) => _restoreCompactedBodies(item, origVal[i], key));
    }
    if (tcVal && typeof tcVal === 'object' && origVal && typeof origVal === 'object') {
        const out = {};
        for (const k of Object.keys(tcVal)) {
            out[k] = (k in origVal) ? _restoreCompactedBodies(tcVal[k], origVal[k], k) : tcVal[k];
        }
        return out;
    }
    return tcVal;
}
