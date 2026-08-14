/**
 * Provider-only deterministic evidence union.
 *
 * The durable transcript remains untouched. Later tool_result envelopes keep
 * their toolCallId but omit exact file lines already visible in an earlier
 * result, replacing them with references to the earlier tool call and source
 * location. Exact repeated list/glob/find results use a whole-result reference.
 * Any apply_patch/shell batch starts a fresh evidence epoch.
 */

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

function mutationBatch(toolCalls) {
    return toolCalls.some((call) => {
        const name = normalizeToolName(call?.name || call?.function?.name);
        return name === 'apply_patch' || name === 'shell' || name === 'bash_session';
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
