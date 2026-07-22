// Stored tool-call argument compaction/restoration, extracted from loop.mjs.
// Long body/command args are truncated with a sha256-tagged head/tail preview
// when persisted into assistant history. Failed command/script calls may
// restore their full text, but mutation bodies stay compacted so stale patches
// cannot be replayed from history.
import { createHash } from 'crypto';

const STORED_TOOL_ARG_BODY_KEY_RE = /^(?:content|old_string|new_string|patch|rewrite)$/i;
const STORED_TOOL_ARG_LONG_KEY_RE = /^(?:command|script)$/i;
const STORED_TOOL_ARG_BODY_LIMIT = 2_000;
const STORED_TOOL_ARG_LONG_LIMIT = 8_000;
const STORED_TOOL_ARG_PREVIEW_HEAD = 360;
const STORED_TOOL_ARG_PREVIEW_TAIL = 160;

function compactStoredToolArgString(value, key = '') {
    if (typeof value !== 'string') return value;
    const isBody = STORED_TOOL_ARG_BODY_KEY_RE.test(key);
    const isLong = isBody || STORED_TOOL_ARG_LONG_KEY_RE.test(key);
    const limit = isBody ? STORED_TOOL_ARG_BODY_LIMIT : (isLong ? STORED_TOOL_ARG_LONG_LIMIT : Infinity);
    if (value.length <= limit) return value;
    const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
    const marker = `[mixdog compacted ${key || 'string'}: ${value.length} chars, sha256:${hash}]`;
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

function compactStoredToolArgValue(value, key = '', depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return compactStoredToolArgString(value, key);
    if (typeof value !== 'object') return value;
    if (depth >= 6) return Array.isArray(value) ? `[${value.length} items]` : '{...}';
    if (Array.isArray(value)) {
        return value.map((item) => compactStoredToolArgValue(item, key, depth + 1));
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = compactStoredToolArgValue(v, k, depth + 1);
    }
    return out;
}

export function compactToolCallsForHistory(calls) {
    if (!Array.isArray(calls)) return calls;
    return calls.map((call) => {
        if (!call || typeof call !== 'object') return call;
        return {
            ...call,
            arguments: compactStoredToolArgValue(call.arguments),
        };
    });
}

// Restore retry-safe long command/script text for ONE failed tool call inside a
// history assistant message whose toolCalls were compacted at push time.
// Mutation bodies (patch, old_string, new_string, content, rewrite) deliberately
// remain compacted: replaying their stale pre-failure text can repeat partial
// writes or overwrite newer state. Must run BEFORE the message is first
// transmitted so it never mutates an already-cached prefix.
//
// Only command/script keys are restored, at ANY depth. Every body key and every
// other field is taken from the compacted snapshot captured at push time.
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

// Recursively rebuild a compacted args tree: replace ONLY retry-safe long
// command/script fields with their full originals and keep mutation bodies plus
// every other field from the compacted snapshot.
function _restoreCompactedBodies(tcVal, origVal, key) {
    if (STORED_TOOL_ARG_BODY_KEY_RE.test(key)) return tcVal;
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
