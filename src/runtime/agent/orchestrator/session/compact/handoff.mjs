import { estimateTokens } from '../context-utils.mjs';

const CONVERSATION_LINE_CHARS = 240;
const WORKING_FILE_CAP = 20;
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
    const rawPath = args.path;
    const candidates = Array.isArray(rawPath)
        ? rawPath
        : String(rawPath || '').split(',');
    for (const item of candidates) {
        const value = typeof item === 'string' ? item.trim() : '';
        if (isFilePath(value)) out.push(value);
    }
    if (name === 'apply_patch' && typeof args.patch === 'string') {
        for (const line of args.patch.split('\n')) {
            const hit = /^\*\*\* (?:Add File|Update File|Delete File): (.+)$/.exec(line);
            if (hit && isFilePath(hit[1])) out.push(hit[1].trim());
        }
    }
    return out;
}

export function collectWorkingFiles(messages, cap = WORKING_FILE_CAP, { cwd } = {}) {
    const limit = Math.max(1, Math.floor(Number(cap) || WORKING_FILE_CAP));
    const seen = new Set();
    const out = [];
    for (let i = (messages || []).length - 1; i >= 0 && out.length < limit; i -= 1) {
        const m = messages[i];
        if (m?.role !== 'assistant' || !Array.isArray(m.toolCalls)) continue;
        for (let j = m.toolCalls.length - 1; j >= 0 && out.length < limit; j -= 1) {
            const tc = m.toolCalls[j];
            const name = toolName(tc);
            if (!['read', 'apply_patch', 'grep', 'glob', 'find'].includes(name)) continue;
            for (const p of pathsFromTool(name, parseArgs(tc))) {
                const normalized = normalizeWorkingPath(p, cwd);
                const key = normalized.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(normalized);
                if (out.length >= limit) break;
            }
        }
    }
    return out;
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
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line || line === '(no results)') continue;
        const stamped = /^\[.*?\]\s+(u|a|user|assistant|\?):?\s+(.*)$/i.exec(line);
        const bare = /^(u|a):\s+(.*)$/i.exec(line);
        const hit = stamped || bare;
        if (!hit) continue;
        const roleRaw = String(hit[1] || '').toLowerCase();
        if (roleRaw === '?' ) continue;
        const role = roleRaw === 'a' || roleRaw === 'assistant' ? 'a' : 'u';
        let body = String(hit[2] || '').replace(/\s+#\d+\s*$/, '').replace(/\s+/g, ' ').trim();
        if (!body) continue;
        if (body === '.' || body === '…') continue;
        body = body.slice(0, CONVERSATION_LINE_CHARS);
        rows.push(`${role}: ${body}`);
    }
    return rows.reverse();
}

export function excludeTailFromConversation(lines, tailMessages) {
    const tails = [];
    for (const m of tailMessages || []) {
        if (m?.role !== 'user' && m?.role !== 'assistant') continue;
        const body = String(typeof m.content === 'string' ? m.content : '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, CONVERSATION_LINE_CHARS);
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
    parts.push(...(workingFiles.length ? workingFiles.map((p) => `- ${p}`) : ['- (none)']));
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
        const withoutTools = candidate.replace(/\n## Tool results\n[\s\S]*?(?=\n## Working files)/, '\n');
        if (estimateTokens(withoutTools) <= cap) return withoutTools;
    }
    return candidate;
}
