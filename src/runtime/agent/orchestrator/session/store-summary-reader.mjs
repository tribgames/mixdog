/**
 * Read-only session summary catalog for cold desktop startup.
 *
 * This module intentionally avoids store.mjs, config/provider loading, workers,
 * and atomic-lock writers. The full runtime remains authoritative after it is
 * loaded; cold startup only needs enough metadata to paint the session list.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SESSION_SUMMARY_INDEX_VERSION = 2;

function dataDir() {
    if (process.env.MIXDOG_DATA_DIR) return process.env.MIXDOG_DATA_DIR;
    const home = process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
    return join(home, 'data');
}

function positiveNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function cleanText(value, maximum = 240) {
    return String(value || '')
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
        .replace(/<mcp-instructions>[\s\S]*?<\/mcp-instructions>/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maximum);
}

function messageText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => typeof part === 'string' ? part : String(part?.text || part?.content || ''))
        .filter(Boolean)
        .join(' ');
}

function desktopSession(value, cwd = '') {
    if (!value || typeof value !== 'object') return null;
    if (value.classification === 'task') return { classification: 'task', projectPath: null };
    if (value.classification !== 'project') return null;
    const projectPath = typeof value.projectPath === 'string' && value.projectPath.trim()
        ? value.projectPath.trim()
        : String(cwd || '').trim();
    return projectPath ? { classification: 'project', projectPath } : null;
}

function normalizedRow(row) {
    if (!row || typeof row.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(row.id)) return null;
    return {
        id: row.id,
        updatedAt: positiveNumber(row.updatedAt, 0),
        createdAt: positiveNumber(row.createdAt, 0),
        lastHeartbeatAt: positiveNumber(row.lastHeartbeatAt, 0),
        closed: row.closed === true,
        status: String(row.status || (row.closed === true ? 'closed' : 'idle')),
        owner: row.owner || 'user',
        agent: row.agent || null,
        sourceType: row.sourceType || null,
        sourceName: row.sourceName || null,
        scopeKey: row.scopeKey || null,
        ownerSessionId: row.ownerSessionId || null,
        clientHostPid: positiveNumber(row.clientHostPid, 0) || null,
        cwd: row.cwd || '',
        desktopSession: desktopSession(row.desktopSession, row.cwd),
        provider: row.provider || null,
        model: row.model || null,
        agentTag: row.agentTag || null,
        task_id: row.task_id || row.taskId || null,
        permission: row.permission || null,
        toolPermission: row.toolPermission || null,
        messageCount: Math.max(0, Math.floor(Number(row.messageCount) || 0)),
        preview: cleanText(row.preview),
        generation: typeof row.generation === 'number' ? row.generation : 0,
        implicitBashSessionId: row.implicitBashSessionId || null,
    };
}

function rowFromSession(session) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const preview = messages
        .filter((message) => message?.role === 'user')
        .map((message) => cleanText(messageText(message.content)))
        .find(Boolean) || '';
    return normalizedRow({
        ...session,
        messageCount: messages.filter((message) =>
            message?.role === 'user' || message?.role === 'assistant').length,
        preview,
    });
}

function scanSessionFiles() {
    const directory = join(dataDir(), 'sessions');
    if (!existsSync(directory)) return [];
    const rows = [];
    for (const filename of readdirSync(directory)) {
        if (!filename.endsWith('.json')) continue;
        try {
            const session = JSON.parse(readFileSync(join(directory, filename), 'utf8'));
            const row = rowFromSession(session);
            if (row) rows.push(row);
        } catch {
            // A corrupt or concurrently replaced session is omitted from the
            // cold catalog; the authoritative runtime can reconcile it later.
        }
    }
    return rows.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
}

export function listStoredSessionSummaries(options = {}) {
    if (options.refreshFromStorage === true) return scanSessionFiles();
    const indexPath = join(dataDir(), 'session-summaries.json');
    try {
        const index = JSON.parse(readFileSync(indexPath, 'utf8'));
        if (Number(index?.version) === SESSION_SUMMARY_INDEX_VERSION) {
            const rows = (Array.isArray(index.rows) ? index.rows : [])
                .map(normalizedRow)
                .filter(Boolean)
                .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
            if (rows.length > 0 || options.rebuildIfMissing === false) return rows;
        }
    } catch {
        // Missing/malformed sidecars fall through to the read-only scan.
    }
    return options.rebuildIfMissing === false ? [] : scanSessionFiles();
}
