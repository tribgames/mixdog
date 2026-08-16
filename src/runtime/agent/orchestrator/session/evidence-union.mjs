/**
 * Provider-only deterministic evidence union.
 *
 * The durable transcript remains untouched. Later tool_result envelopes keep
 * their toolCallId but omit exact file lines already visible in an earlier
 * result, replacing them with references to the earlier tool call and source
 * location. Exact repeated list/glob/find results use a whole-result reference.
 * Any apply_patch/shell batch starts a fresh evidence epoch.
 */

import { tokenizeDirectArgv } from '../tools/builtin/shell-direct-exe.mjs';

const EXACT_RESULT_TOOLS = new Set(['find', 'find_files', 'glob', 'list']);

function normalizeToolName(name) {
    const raw = String(name || '');
    const withoutMcp = raw.startsWith('mcp__') ? raw.slice('mcp__'.length) : raw;
    return withoutMcp.toLowerCase();
}

function parsedArguments(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function normalizeEvidencePath(value) {
    let path = String(value || '').trim().replaceAll('\\', '/');
    if (path.startsWith('./')) path = path.slice(2);
    if (/^[A-Z]:\//.test(path)) path = path[0].toLowerCase() + path.slice(1);
    return path;
}

function singleReadPath(args) {
    for (const value of [args?.file_path, args?.path, args?.file]) {
        if (typeof value === 'string' && value.trim()) return normalizeEvidencePath(value);
    }
    return '';
}

function extractReadRows(text, args) {
    const lines = text.split('\n');
    const rows = [];
    let currentPath = singleReadPath(args);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const source = /^(\d+)[\t│→](.*)$/.exec(line);
        if (source && currentPath) {
            rows.push({
                index,
                path: currentPath,
                line: Number(source[1]),
                content: source[2],
            });
            continue;
        }
        const batchHeader = /^(.+?)(?: \[[^\]]+\])? \[(?:ok|error)\](?: .*)?$/.exec(line);
        if (batchHeader) currentPath = normalizeEvidencePath(batchHeader[1]);
    }
    return rows;
}

function extractGrepRows(text) {
    const lines = text.split('\n');
    const rows = [];
    let block = null;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const header = /^# (.+):(\d+) \[lines (\d+)-(\d+)\]$/.exec(line);
        if (header) {
            block = {
                path: normalizeEvidencePath(header[1]),
                nextLine: Number(header[3]),
                endLine: Number(header[4]),
            };
            continue;
        }
        if (block && block.nextLine <= block.endLine) {
            rows.push({
                index,
                path: block.path,
                line: block.nextLine,
                content: line,
            });
            block.nextLine += 1;
            if (block.nextLine > block.endLine) block = null;
            continue;
        }
        block = null;
        const plain = /^(.+):(\d+):(.*)$/.exec(line);
        if (!plain || /^\s*#/.test(plain[1])) continue;
        const path = normalizeEvidencePath(plain[1]);
        if (!path || !/[./\\]/.test(path)) continue;
        rows.push({
            index,
            path,
            line: Number(plain[2]),
            content: plain[3],
        });
    }
    return rows;
}

function extractCodeGraphRows(text) {
    const lines = text.split('\n');
    const rows = [];
    let body = null;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const header = /^(.+):(\d+)-(\d+):\d+ \([^)]+\)$/.exec(line);
        if (header) {
            body = {
                path: normalizeEvidencePath(header[1]),
                startLine: Number(header[2]),
                endLine: Number(header[3]),
            };
            continue;
        }
        if (!body) continue;
        const source = /^(\d+):\s?(.*)$/.exec(line);
        const lineNo = Number(source?.[1]);
        if (!source || lineNo < body.startLine || lineNo > body.endLine) {
            if (line && !line.startsWith('#')) body = null;
            continue;
        }
        rows.push({
            index,
            path: body.path,
            line: lineNo,
            content: source[2],
        });
    }
    return rows;
}

function extractEvidenceRows(toolName, text, args) {
    if (typeof text !== 'string' || !text) return [];
    switch (normalizeToolName(toolName)) {
        case 'read':
            return extractReadRows(text, args);
        case 'grep':
            return extractGrepRows(text);
        case 'code_graph':
            return extractCodeGraphRows(text);
        default:
            return [];
    }
}

function evidenceKey(row) {
    return `${row.path}\0${row.line}\0${row.content}`;
}

const READ_ONLY_GIT_COMMANDS = new Set([
    'blame', 'cat-file', 'check-attr', 'check-ignore', 'check-ref-format',
    'cherry', 'count-objects', 'describe', 'diff', 'diff-files', 'diff-index',
    'diff-tree', 'for-each-ref', 'fsck', 'grep', 'help', 'log', 'ls-files',
    'ls-remote', 'ls-tree', 'merge-base', 'merge-tree', 'name-rev',
    'range-diff', 'rev-list', 'rev-parse', 'shortlog', 'show', 'show-branch',
    'show-ref', 'status', 'verify-commit', 'verify-pack', 'verify-tag',
    'whatchanged',
]);

function parsedGitCommand(command) {
    const tokens = tokenizeDirectArgv(command);
    if (!tokens?.length || !/(^|[\\/])git(?:\.exe)?$/i.test(tokens[0])) return null;
    let index = 1;
    while (index < tokens.length) {
        const token = tokens[index];
        if (token === '-C' || token === '-c' || token === '--git-dir' || token === '--work-tree' || token === '--namespace') {
            index += 2;
            continue;
        }
        if (/^-C.+/.test(token) || /^--(?:git-dir|work-tree|namespace)=/.test(token)
            || ['--no-pager', '--paginate', '--bare', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs'].includes(token)) {
            index++;
            continue;
        }
        break;
    }
    return index < tokens.length ? { command: tokens[index], args: tokens.slice(index + 1) } : null;
}

function firstGitArg(args) {
    return args.find((value) => value !== '--' && !value.startsWith('-')) || '';
}

function gitCallMutates(call) {
    let args = call?.arguments ?? call?.function?.arguments ?? {};
    if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { return true; }
    }
    const parsed = parsedGitCommand(args?.command);
    if (!parsed) return true;
    const operation = parsed.command;
    const action = firstGitArg(parsed.args);
    if (READ_ONLY_GIT_COMMANDS.has(operation)) return false;
    if (operation === 'reflog') return ['delete', 'expire'].includes(action);
    if (operation === 'branch' || operation === 'tag') {
        return parsed.args.length > 0 && !parsed.args.some((value) => ['--list', '-l', '-a', '--all', '-r', '--remotes', '--show-current'].includes(value));
    }
    if (operation === 'worktree') return !['', 'list'].includes(action);
    if (operation === 'stash') return !['list', 'show'].includes(action);
    if (operation === 'remote') return !['', 'show', 'get-url'].includes(action);
    if (operation === 'config') {
        return !parsed.args.some((value) => ['--list', '-l', '--get', '--get-all', '--get-regexp', '--show-origin', '--show-scope'].includes(value))
            && parsed.args.filter((value) => !value.startsWith('-')).length > 1;
    }
    if (operation === 'clean') return !parsed.args.some((value) => value === '-n' || value === '--dry-run');
    if (operation === 'bundle') return !['list-heads', 'verify'].includes(action);
    if (operation === 'notes') return !['', 'list', 'show'].includes(action);
    if (operation === 'replace') return parsed.args.length > 0 && !parsed.args.includes('--list');
    if (operation === 'sparse-checkout') return action !== 'list';
    if (operation === 'submodule') return !['', 'status', 'summary'].includes(action);
    if (operation === 'symbolic-ref') return parsed.args.filter((value) => !value.startsWith('-')).length > 1;
    if (operation === 'hash-object') return parsed.args.includes('-w') || parsed.args.includes('--stdin-paths');
    return true;
}

function mutationBatch(toolCalls) {
    return toolCalls.some((call) => {
        const name = normalizeToolName(call?.name || call?.function?.name);
        return name === 'apply_patch'
            || name === 'shell'
            || name === 'bash_session'
            || (name === 'git' && gitCallMutates(call));
    });
}

function groupReferences(rows) {
    const groups = [];
    for (const row of rows) {
        const previous = groups.at(-1);
        if (previous
            && previous.toolCallId === row.prior.toolCallId
            && previous.path === row.path
            && previous.endLine + 1 === row.line
            && previous.endIndex + 1 === row.index) {
            previous.endLine = row.line;
            previous.endIndex = row.index;
            continue;
        }
        groups.push({
            toolCallId: row.prior.toolCallId,
            path: row.path,
            startLine: row.line,
            endLine: row.line,
            endIndex: row.index,
        });
    }
    return groups;
}

function renderReference(group) {
    const range = group.startLine === group.endLine
        ? String(group.startLine)
        : `${group.startLine}-${group.endLine}`;
    return `[evidence-ref tool_call_id=${JSON.stringify(group.toolCallId)} location=${group.path}:${range}]`;
}

function renderExactResultReference(prior, bytes) {
    return `[tool-result-ref tool_call_id=${JSON.stringify(prior.toolCallId)} exact_bytes=${bytes}]`;
}

function byteLength(value) {
    return Buffer.byteLength(String(value || ''), 'utf8');
}

export function projectProviderEvidence(messages, options = {}) {
    if (!Array.isArray(messages) || options.enabled === false) {
        return {
            messages,
            stats: {
                beforeBytes: 0,
                afterBytes: 0,
                evidenceRows: 0,
                reusedRows: 0,
                referenceGroups: 0,
                changedToolResults: 0,
                exactResultRefs: 0,
                exactResultBytesSaved: 0,
            },
        };
    }

    const apply = options.apply !== false;
    const callById = new Map();
    const seen = new Map();
    const seenExactResults = new Map();
    let projected = null;
    const stats = {
        beforeBytes: 0,
        afterBytes: 0,
        evidenceRows: 0,
        reusedRows: 0,
        referenceGroups: 0,
        changedToolResults: 0,
        exactResultRefs: 0,
        exactResultBytesSaved: 0,
    };

    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message || typeof message !== 'object') continue;
        if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
            if (mutationBatch(message.toolCalls)) {
                seen.clear();
                seenExactResults.clear();
            }
            for (const call of message.toolCalls) {
                const id = call?.id || call?.toolCallId;
                if (!id) continue;
                callById.set(id, {
                    name: call?.name || call?.function?.name,
                    arguments: parsedArguments(call?.arguments ?? call?.function?.arguments),
                });
            }
            continue;
        }
        if (message.role !== 'tool' || typeof message.content !== 'string') continue;
        stats.beforeBytes += byteLength(message.content);
        const call = callById.get(message.toolCallId);
        if (!call || message.toolKind === 'error' || message.isError === true) {
            stats.afterBytes += byteLength(message.content);
            continue;
        }
        const originalBytes = byteLength(message.content);
        if (EXACT_RESULT_TOOLS.has(normalizeToolName(call.name))) {
            const prior = seenExactResults.get(message.content);
            if (!prior && message.toolCallId) {
                seenExactResults.set(message.content, { toolCallId: message.toolCallId });
            } else if (prior?.toolCallId && prior.toolCallId !== message.toolCallId) {
                const nextContent = renderExactResultReference(prior, originalBytes);
                const nextBytes = byteLength(nextContent);
                if (nextBytes < originalBytes) {
                    stats.exactResultRefs += 1;
                    stats.exactResultBytesSaved += originalBytes - nextBytes;
                    stats.changedToolResults += 1;
                    stats.afterBytes += nextBytes;
                    if (apply) {
                        if (!projected) projected = messages.slice();
                        projected[index] = { ...message, content: nextContent };
                    }
                    continue;
                }
            }
        }
        const rows = extractEvidenceRows(call.name, message.content, call.arguments);
        stats.evidenceRows += rows.length;
        const duplicates = [];
        for (const row of rows) {
            const prior = seen.get(evidenceKey(row));
            if (prior && prior.toolCallId !== message.toolCallId) {
                duplicates.push({ ...row, prior });
            }
        }
        for (const row of rows) {
            const key = evidenceKey(row);
            if (!seen.has(key) && message.toolCallId) {
                seen.set(key, {
                    toolCallId: message.toolCallId,
                    path: row.path,
                    line: row.line,
                });
            }
        }
        if (duplicates.length === 0) {
            stats.afterBytes += byteLength(message.content);
            continue;
        }
        const duplicateIndexes = new Set(duplicates.map((row) => row.index));
        const references = groupReferences(duplicates);
        const remaining = message.content
            .split('\n')
            .filter((_line, lineIndex) => !duplicateIndexes.has(lineIndex))
            .join('\n');
        const nextContent = [
            ...references.map(renderReference),
            ...(remaining ? [remaining] : ['[no new file evidence]']),
        ].join('\n');
        const nextBytes = byteLength(nextContent);
        // A reference envelope is an optimization, not a tax. Tiny repeated
        // rows can cost more to point at than to replay verbatim; retain the
        // original result unless this exact projection is byte-smaller.
        if (nextBytes >= originalBytes) {
            stats.afterBytes += originalBytes;
            continue;
        }
        stats.reusedRows += duplicates.length;
        stats.referenceGroups += references.length;
        stats.changedToolResults += 1;
        stats.afterBytes += nextBytes;
        if (apply) {
            if (!projected) projected = messages.slice();
            projected[index] = { ...message, content: nextContent };
        }
    }

    return { messages: projected || messages, stats };
}

export const _evidenceUnionInternals = {
    extractReadRows,
    extractGrepRows,
    extractCodeGraphRows,
};
