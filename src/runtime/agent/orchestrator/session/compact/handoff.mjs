import { estimateTokens } from '../context-utils.mjs';

const TOOL_OUTCOME_CHARS = 80;

function textOf(m) {
    if (typeof m?.content === 'string') return m.content;
    if (Array.isArray(m?.content)) {
        return m.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
    }
    return '';
}

function toolName(tc) {
    return String(tc?.name || tc?.function?.name || '').toLowerCase();
}

function parseArgs(tc) {
    let args = tc?.arguments ?? tc?.function?.arguments;
    if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { return {}; }
    }
    return args && typeof args === 'object' ? args : {};
}

function isFilePath(value) {
    const text = String(value || '').trim();
    if (!text || /[\\/]$/.test(text)) return false;
    return /\.[A-Za-z0-9]+$/.test(text);
}

function normalizeWorkingPath(value, cwd) {
    const slashed = String(value || '').trim().replace(/\\/g, '/');
    if (!slashed) return '';
    const root = String(cwd || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (root && slashed.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
        return slashed.slice(root.length + 1);
    }
    return slashed;
}

function pathsFromTool(name, args) {
    const out = [];
    const rawPaths = [args.path, name === 'code_graph' ? args.files : null];
    for (const rawPath of rawPaths) {
        const candidates = Array.isArray(rawPath)
            ? rawPath
            : String(rawPath || '').split(',');
        for (const item of candidates) {
            const value = typeof item === 'string' ? item.trim() : '';
            if (isFilePath(value)) out.push(value);
        }
    }
    if (name === 'apply_patch' && typeof args.patch === 'string') {
        for (const line of args.patch.split('\n')) {
            const hit = /^\*\*\* (?:Add File|Update File|Delete File): (.+)$/.exec(line);
            if (hit && isFilePath(hit[1])) out.push(hit[1].trim());
        }
    }
    return out;
}

function normalizeEventTime(value) {
    if (value == null || value === '') return null;
    const millis = typeof value === 'number' ? value : Date.parse(String(value));
    if (!Number.isFinite(millis) || millis <= 0) return null;
    return new Date(millis).toISOString();
}

function newerEventTime(left, right) {
    const leftMs = left ? Date.parse(left) : 0;
    const rightMs = right ? Date.parse(right) : 0;
    return rightMs > leftMs ? right : left;
}

function toolEventTime(message, toolCall, resultMessage, fallback) {
    const candidates = [
        resultMessage?.createdAt,
        resultMessage?.timestamp,
        toolCall?.createdAt,
        toolCall?.timestamp,
        message?.createdAt,
        message?.timestamp,
        message?.meta?.createdAt,
        fallback,
    ];
    for (const candidate of candidates) {
        const normalized = normalizeEventTime(candidate);
        if (normalized) return normalized;
    }
    return null;
}

function parseWorkingEntry(value) {
    const raw = String(value || '').trim();
    const metadata = /\s+\[([^\]]+)\]\s*$/.exec(raw);
    const path = metadata ? raw.slice(0, metadata.index).trim() : raw;
    const fields = {};
    for (const part of String(metadata?.[1] || '').split(';')) {
        const hit = /^\s*(editedAt|seenAt)=(.+?)\s*$/.exec(part);
        if (hit) fields[hit[1]] = normalizeEventTime(hit[2]);
    }
    return {
        path,
        editedAt: fields.editedAt || null,
        seenAt: fields.seenAt || null,
    };
}

function priorWorkingFileGroups(text, cwd) {
    const modified = [];
    const referenced = [];
    let section = null;
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (line === '## Working files') {
            section = 'referenced';
            continue;
        }
        if (!section) continue;
        if (line === '### Modified') {
            section = 'modified';
            continue;
        }
        if (line === '### Referenced') {
            section = 'referenced';
            continue;
        }
        if (/^##\s+/.test(line) || /^<\/?prior-compacted-context>$/.test(line)) {
            section = null;
            continue;
        }
        const hit = /^-\s+(.+)$/.exec(line);
        if (!hit || hit[1] === '(none)' || /^\+\d+\s+omitted$/.test(hit[1])) continue;
        const entry = parseWorkingEntry(hit[1]);
        entry.path = normalizeWorkingPath(entry.path, cwd);
        if (!isFilePath(entry.path)) continue;
        if (section === 'modified') {
            modified.push(entry);
        } else {
            referenced.push(entry);
        }
    }
    return { modified, referenced };
}

function mergeWorkingEntries(current, prior, limit, cwd) {
    const entries = new Map();
    let order = 0;
    const touch = (raw, kind) => {
        const path = normalizeWorkingPath(raw?.path, cwd);
        if (!isFilePath(path)) return;
        const key = path.toLowerCase();
        let entry = entries.get(key);
        if (!entry) {
            entry = {
                path,
                editedAt: null,
                seenAt: null,
                modified: false,
                order: order++,
            };
            entries.set(key, entry);
        }
        entry.seenAt = newerEventTime(entry.seenAt, normalizeEventTime(raw?.seenAt));
        if (kind === 'modified') {
            entry.modified = true;
            entry.editedAt = newerEventTime(entry.editedAt, normalizeEventTime(raw?.editedAt));
        }
    };
    for (const entry of current.modified) touch(entry, 'modified');
    for (const entry of current.referenced) touch(entry, 'referenced');
    for (const entry of prior.modified) touch(entry, 'modified');
    for (const entry of prior.referenced) touch(entry, 'referenced');
    const sorted = [...entries.values()].sort((left, right) => {
        const leftTime = Date.parse(left.editedAt || left.seenAt || '') || 0;
        const rightTime = Date.parse(right.editedAt || right.seenAt || '') || 0;
        return rightTime - leftTime || left.order - right.order;
    });
    const modified = sorted.filter((entry) => entry.modified);
    const referenced = sorted.filter((entry) => !entry.modified);
    if (!Number.isFinite(limit)) return { modified, referenced };
    const keptModified = modified.slice(0, limit);
    return {
        modified: keptModified,
        referenced: referenced.slice(0, Math.max(0, limit - keptModified.length)),
    };
}

export function collectWorkingFileGroups(messages, cap = Number.POSITIVE_INFINITY, {
    cwd,
    previousSummary,
    now = Date.now(),
} = {}) {
    const numericCap = Number(cap);
    const limit = Number.isFinite(numericCap) && numericCap > 0
        ? Math.floor(numericCap)
        : Number.POSITIVE_INFINITY;
    const results = indexToolResults(messages);
    const resultMessages = indexToolResultMessages(messages);
    const currentModified = [];
    const currentReferenced = [];
    const supported = new Set(['read', 'apply_patch', 'grep', 'glob', 'find', 'code_graph', 'list']);
    for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m?.role !== 'assistant' || !Array.isArray(m.toolCalls)) continue;
        for (let j = m.toolCalls.length - 1; j >= 0; j -= 1) {
            const tc = m.toolCalls[j];
            const name = toolName(tc);
            if (!supported.has(name)) continue;
            const resultMessage = resultMessages.get(String(tc.id || tc.toolCallId || ''));
            if (name === 'apply_patch') {
                const output = results.get(String(tc.id || tc.toolCallId || ''));
                if (/Error:|failed|rejected/i.test(String(output || ''))) continue;
            }
            const eventTime = toolEventTime(m, tc, resultMessage, now);
            for (const p of pathsFromTool(name, parseArgs(tc))) {
                const path = normalizeWorkingPath(p, cwd);
                if (!path) continue;
                if (name === 'apply_patch') {
                    currentModified.push({
                        path,
                        editedAt: eventTime,
                        seenAt: eventTime,
                    });
                } else {
                    currentReferenced.push({
                        path,
                        editedAt: null,
                        seenAt: eventTime,
                    });
                }
            }
        }
    }
    const prior = priorWorkingFileGroups(previousSummary, cwd);
    return mergeWorkingEntries({
        modified: currentModified,
        referenced: currentReferenced,
    }, prior, limit, cwd);
}

function indexToolResults(messages) {
    const map = new Map();
    for (const m of messages || []) {
        if (m?.role !== 'tool') continue;
        const id = String(m.toolCallId || m.tool_call_id || '');
        if (id) map.set(id, textOf(m));
    }
    return map;
}

function indexToolResultMessages(messages) {
    const map = new Map();
    for (const message of messages || []) {
        if (message?.role !== 'tool') continue;
        const id = String(message.toolCallId || message.tool_call_id || '');
        if (id) map.set(id, message);
    }
    return map;
}

function patchTarget(args) {
    if (isFilePath(args.path)) return String(args.path).trim();
    if (typeof args.patch === 'string') {
        const hit = /^\*\*\* (?:Add File|Update File|Delete File): (.+)$/m.exec(args.patch);
        if (hit) return hit[1].trim();
    }
    return '';
}

function shellOutcome(command, output) {
    const text = String(output || '').replace(/\s+/g, ' ').trim();
    const code = /\[exit code:\s*(-?\d+)\]/i.exec(text) || /exit code:\s*(-?\d+)/i.exec(text);
    const tests = /# tests\s+(\d+)[\s\S]*# fail\s+(\d+)/i.exec(String(output || ''))
        || /(\d+)\/(\d+)\s+pass/i.exec(text);
    if (/node --test|--test /.test(String(command || '')) || tests) {
        if (tests) return `tests ${tests[1]}/${tests[2] || tests[1]}`;
        if (/# fail 0|# pass /.test(String(output || ''))) return 'tests pass';
    }
    if (code) return `exit ${code[1]}`;
    if (/Error:|failed/i.test(text)) return `err ${text.slice(0, TOOL_OUTCOME_CHARS)}`;
    return text ? text.slice(0, TOOL_OUTCOME_CHARS) : 'ok';
}

export function collectToolOutcomeLines(messages) {
    const results = indexToolResults(messages);
    const lines = [];
    for (const m of messages || []) {
        if (m?.role !== 'assistant' || !Array.isArray(m.toolCalls)) continue;
        for (const tc of m.toolCalls) {
            const name = toolName(tc);
            if (name !== 'apply_patch' && name !== 'shell') continue;
            const args = parseArgs(tc);
            const output = results.get(String(tc.id || tc.toolCallId || ''));
            if (name === 'apply_patch') {
                const dest = patchTarget(args);
                const failed = /Error:|failed|rejected/i.test(String(output || ''));
                lines.push(`t: apply_patch${dest ? ` ${dest}` : ''} → ${failed ? 'err' : 'ok'}`);
                continue;
            }
            const command = String(args.command || '').replace(/\s+/g, ' ').slice(0, 60);
            lines.push(`t: shell${command ? ` ${command}` : ''} → ${shellOutcome(args.command, output)}`);
        }
    }
    return lines;
}

export function conversationLinesFromMemoryText(text) {
    const rows = [];
    let current = null;
    const flush = () => {
        if (!current) return;
        let body = current.parts.join(' ').replace(/\s+/g, ' ').trim();
        body = body
            .replace(/\s+\[time=(?:unknown|collected)\]\s*#\d+\s*$/, '')
            .replace(/\s+#\d+\s*$/, '')
            .trim();
        if (body && body !== '.' && body !== '…') {
            rows.push(`${current.role}: ${body}`);
        }
        current = null;
    };
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line || line === '(no results)') continue;
        const stamped = /^\[.*?\]\s+(u|a|user|assistant|\?):?\s+(.*)$/i.exec(line);
        const bare = /^(u|a):\s+(.*)$/i.exec(line);
        const stampedRoot = /^\[.*?\]\s+(.*)$/i.exec(line);
        const hit = stamped || bare || (stampedRoot ? ['', 'a', stampedRoot[1]] : null);
        if (!hit) {
            if (current) current.parts.push(line);
            continue;
        }
        flush();
        const roleRaw = String(hit[1] || '').toLowerCase();
        if (roleRaw === '?' ) continue;
        const role = roleRaw === 'a' || roleRaw === 'assistant' ? 'a' : 'u';
        const body = String(hit[2] || '').trim();
        if (!body) continue;
        current = { role, parts: [body] };
    }
    flush();
    return rows.reverse();
}

export function excludeTailFromConversation(lines, tailMessages) {
    const tails = [];
    for (const m of tailMessages || []) {
        if (m?.role !== 'user' && m?.role !== 'assistant') continue;
        const body = String(typeof m.content === 'string' ? m.content : '')
            .replace(/\s+/g, ' ')
            .trim();
        if (body) tails.push(body);
    }
    if (!tails.length) return Array.isArray(lines) ? lines : [];
    return (lines || []).filter((line) => {
        const body = String(line || '').replace(/^[ua]:\s*/i, '').trim();
        if (!body) return false;
        return !tails.some((tail) => tail === body || tail.startsWith(body) || body.startsWith(tail));
    });
}

export function composeRecallHandoff({
    sessionId,
    conversationText = '',
    conversationLines = null,
    toolLines = [],
    workingFiles = [],
} = {}) {
    const lines = Array.isArray(conversationLines)
        ? conversationLines
        : conversationLinesFromMemoryText(conversationText);
    const parts = [
        sessionId ? `[context compacted — session ${sessionId}]` : '[context compacted]',
        '',
        '## Previous conversation',
        ...(lines.length ? lines : ['(none)']),
    ];
    if (toolLines.length) {
        parts.push('', '## Tool results', ...toolLines);
    }
    parts.push('', '## Working files');
    const groups = Array.isArray(workingFiles)
        ? {
            modified: [],
            referenced: workingFiles.map((entry) => (
                typeof entry === 'string' ? { path: entry, seenAt: null } : entry
            )),
        }
        : {
            modified: Array.isArray(workingFiles?.modified) ? workingFiles.modified : [],
            referenced: Array.isArray(workingFiles?.referenced) ? workingFiles.referenced : [],
        };
    const formatEntry = (entry, modified) => {
        const normalized = typeof entry === 'string' ? { path: entry } : entry;
        const fields = [];
        if (modified) fields.push(`editedAt=${normalized?.editedAt || 'unknown'}`);
        fields.push(`seenAt=${normalized?.seenAt || normalized?.editedAt || 'unknown'}`);
        return `- ${normalized?.path || ''} [${fields.join('; ')}]`;
    };
    if (groups.modified.length) {
        parts.push('### Modified', ...groups.modified.map((entry) => formatEntry(entry, true)));
    }
    if (groups.referenced.length) {
        parts.push('### Referenced', ...groups.referenced.map((entry) => formatEntry(entry, false)));
    }
    if (!groups.modified.length && !groups.referenced.length) parts.push('- (none)');
    return parts.join('\n');
}

export function fitRecallHandoffText(text, maxTokens) {
    const cap = Math.max(1, Math.floor(Number(maxTokens) || 0));
    if (!cap || estimateTokens(text) <= cap) return String(text || '');
    const raw = String(text || '');
    const convHeader = '## Previous conversation\n';
    const convAt = raw.indexOf(convHeader);
    if (convAt < 0) return raw.slice(0, cap * 4);
    const afterConv = raw.slice(convAt + convHeader.length);
    const nextHeader = afterConv.search(/\n## /);
    const convBody = nextHeader < 0 ? afterConv : afterConv.slice(0, nextHeader);
    const suffix = nextHeader < 0 ? '' : afterConv.slice(nextHeader);
    const prefix = raw.slice(0, convAt + convHeader.length);
    const lines = convBody.split('\n').filter((line) => line.length > 0);
    let start = 0;
    let candidate = raw;
    while (start < lines.length && estimateTokens(candidate) > cap) {
        start += 1;
        const kept = lines.slice(start);
        candidate = `${prefix}${kept.join('\n')}${suffix}`;
    }
    if (estimateTokens(candidate) > cap && start >= lines.length) {
        candidate = candidate.replace(/\n## Tool results\n[\s\S]*?(?=\n## Working files)/, '\n');
    }
    if (estimateTokens(candidate) <= cap) return candidate;
    const rows = candidate.split('\n');
    const referencedAt = rows.findIndex((line) => line.trim() === '### Referenced');
    if (referencedAt < 0) return candidate;
    let referencedEnd = referencedAt + 1;
    while (referencedEnd < rows.length && !/^#{2,3}\s+/.test(rows[referencedEnd].trim())) {
        referencedEnd += 1;
    }
    const references = rows
        .slice(referencedAt + 1, referencedEnd)
        .filter((line) => /^-\s+/.test(line) && !/^\-\s+\+\d+\s+omitted$/.test(line));
    const prefixRows = rows.slice(0, referencedAt + 1);
    const suffixRows = rows.slice(referencedEnd);
    let lo = 0;
    let hi = references.length;
    let best = -1;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const omitted = references.length - mid;
        const next = [
            ...prefixRows,
            ...references.slice(0, mid),
            ...(omitted > 0 ? [`- +${omitted} omitted`] : []),
            ...suffixRows,
        ].join('\n');
        if (estimateTokens(next) <= cap) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (best >= 0) {
        const omitted = references.length - best;
        return [
            ...prefixRows,
            ...references.slice(0, best),
            ...(omitted > 0 ? [`- +${omitted} omitted`] : []),
            ...suffixRows,
        ].join('\n');
    }
    return candidate;
}
