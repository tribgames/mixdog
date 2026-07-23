/**
 * Read-only session summary catalog for cold desktop startup.
 *
 * This module intentionally avoids store.mjs, config/provider loading, workers,
 * and atomic-lock writers. The full runtime remains authoritative after it is
 * loaded; cold startup only needs enough metadata to paint the session list.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SESSION_SUMMARY_INDEX_VERSION = 2;

// Mirror of lifecycle-api.mjs listLeadSessions visibility: the cold catalog
// must never surface worker/agent dispatches (memory ingest chunks, judges,
// spawned agents) — the authoritative engine excludes them, so a click on
// such a row dead-ends in "Session is not available." (user report).
const LEAD_OWNERS = new Set(['cli', 'user', 'mixdog', 'legacy']);

function isLeadVisibleRow(row) {
    const owner = String(row.owner || 'user').trim().toLowerCase();
    if (owner && !LEAD_OWNERS.has(owner)) return false;
    // Mirror listLeadSessions: a previewless zero-message row is an unusable
    // scratch (desktop boot leftovers, crashed first turns) — resuming it
    // shows an empty conversation, so the catalog hides it.
    if (!row.preview && row.messageCount === 0) return false;
    const sourceType = String(row.sourceType || '').trim().toLowerCase();
    const sourceName = String(row.sourceName || '').trim().toLowerCase();
    const agent = String(row.agent || '').trim().toLowerCase();
    return agent === 'lead'
        || sourceType === 'lead'
        || sourceType === 'cli'
        || sourceType === 'schedule'
        || sourceType === 'webhook'
        || (!sourceType && !sourceName && owner !== 'agent');
}

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
        // Session-context envelope (mirror of session-text.mjs
        // stripSessionDisplayEnvelope): the "# Session / Cwd / Model /
        // Workflow" header must never become a Recent title.
        .replace(/^\s*# Session\r?\n(?:(?:Cwd|Model|Workflow):[^\r\n]*(?:\r?\n|$))+(?:\r?\n)?/i, ' ')
        .replace(/^\s*#\s*Session\s+Cwd:\s+\S+(?:\s+Model:[^\r\n]*?)?(?:\s+Workflow:\s+\S+)?\s*/i, ' ')
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

function normalizedRow(row, heartbeatAt = 0) {
    if (!row || typeof row.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(row.id)) return null;
    return {
        id: row.id,
        updatedAt: positiveNumber(row.updatedAt, 0),
        // Conversation-activity timestamp (mirror of listLeadSessions):
        // detach/resume bookkeeping bumps updatedAt in bulk on restarts, so
        // Recent must order by lastUsedAt or every restart reshuffles rows.
        lastUsedAt: positiveNumber(row.lastUsedAt, 0),
        createdAt: positiveNumber(row.createdAt, 0),
        lastHeartbeatAt: positiveNumber(row.lastHeartbeatAt, 0),
        // Liveness comes from the .hb sidecar mtime alone: stored row fields
        // (summary index / final session save) survive completion and must not
        // keep the desktop working indicator on after the sidecar is deleted.
        heartbeatAt: positiveNumber(heartbeatAt, 0),
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
        detachedReason: row.detachedReason || null,
    };
}

function rowFromSession(session, heartbeatAt = 0) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const preview = messages
        .filter((message) => message?.role === 'user')
        // Cold-path mirror of isSessionPreviewNoise's synthetic skips: compact
        // handoffs and runtime notices must not become session titles.
        .filter((message) => !/^\s*(?:a previous model worked on this task|re-attached after compaction\b|reference files:\s|\[mixdog-runtime\]|the async (?:agent|shell) task\b)/i
            .test(messageText(message.content)))
        .map((message) => cleanText(messageText(message.content)))
        .find(Boolean) || '';
    return normalizedRow({
        ...session,
        messageCount: messages.filter((message) =>
            message?.role === 'user' || message?.role === 'assistant').length,
        preview,
    }, heartbeatAt);
}

function sessionHeartbeatMtimes() {
    const directory = join(dataDir(), 'sessions');
    const result = new Map();
    if (!existsSync(directory)) return result;
    for (const filename of readdirSync(directory)) {
        if (!filename.endsWith('.hb')) continue;
        const id = filename.slice(0, -3);
        if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
        try {
            const mtime = statSync(join(directory, filename)).mtimeMs || 0;
            if (mtime > 0) result.set(id, mtime);
        } catch { /* sidecar disappeared after readdir */ }
    }
    return result;
}

function scanSessionFiles(heartbeatMtimes = sessionHeartbeatMtimes()) {
    const directory = join(dataDir(), 'sessions');
    if (!existsSync(directory)) return [];
    const rows = [];
    for (const filename of readdirSync(directory)) {
        if (!filename.endsWith('.json')) continue;
        try {
            const session = JSON.parse(readFileSync(join(directory, filename), 'utf8'));
            const row = rowFromSession(session, heartbeatMtimes.get(session?.id) || 0);
            if (row && isLeadVisibleRow(row)) rows.push(row);
        } catch {
            // A corrupt or concurrently replaced session is omitted from the
            // cold catalog; the authoritative runtime can reconcile it later.
        }
    }
    return rows.sort((left, right) =>
        (right.lastUsedAt || right.updatedAt || 0) - (left.lastUsedAt || left.updatedAt || 0));
}

export function listStoredSessionSummaries(options = {}) {
    const heartbeatMtimes = sessionHeartbeatMtimes();
    if (options.refreshFromStorage === true) return scanSessionFiles(heartbeatMtimes);
    const indexPath = join(dataDir(), 'session-summaries.json');
    try {
        const index = JSON.parse(readFileSync(indexPath, 'utf8'));
        if (Number(index?.version) === SESSION_SUMMARY_INDEX_VERSION) {
            const rows = (Array.isArray(index.rows) ? index.rows : [])
                .map((row) => normalizedRow(row, heartbeatMtimes.get(row?.id) || 0))
                .filter((row) => row && isLeadVisibleRow(row))
                .sort((left, right) =>
                    (right.lastUsedAt || right.updatedAt || 0) - (left.lastUsedAt || left.updatedAt || 0));
            if (rows.length > 0 || options.rebuildIfMissing === false) return rows;
        }
    } catch {
        // Missing/malformed sidecars fall through to the read-only scan.
    }
    return options.rebuildIfMissing === false ? [] : scanSessionFiles(heartbeatMtimes);
}
