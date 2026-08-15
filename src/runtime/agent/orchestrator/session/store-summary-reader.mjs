/**
 * Read-only session summary catalog for cold desktop startup.
 *
 * The summary path intentionally avoids store.mjs, config/provider loading,
 * workers, and atomic-lock writers. A transcript read stays lightweight too
 * unless a durable turn checkpoint exists; only then does it lazily enter the
 * reconnect recovery boundary so restored panes never paint a stale prompt.
 */
import { readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
// Leaf helpers only (no store.mjs, no workers, no config): the three-way
// present/absent/unreadable classification and the strict record parser the
// authoritative store uses, so the cold catalog cannot disagree with it.
import { probePath, readTextFile, PROBE_PRESENT, PROBE_ABSENT } from './store/fs-probe.mjs';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from './lifecycle-scan.mjs';

const SESSION_SUMMARY_INDEX_VERSION = 2;
const DEAD_AGENT_STATUS =
    /^(?:done|complete|completed|success|closed|error|fail|failed|cancelled|canceled|killed|timeout)$/i;
const LIVING_AGENT_STATUS =
    /^(?:idle|connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting|cancelling)$/i;
const AGENT_POOL_HEARTBEAT_FRESH_MS = 2 * 60 * 1000;

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

function cleanValue(value) {
    return String(value || '').trim();
}

function archivedAgentNotification(content, sessionId) {
    const text = typeof content === 'string' ? content : '';
    const marker = '\n\nResult:\n';
    const markerAt = text.indexOf(marker);
    if (markerAt < 0 || !/The async agent task .* has finished \(/.test(text.slice(0, markerAt))) return null;
    const lines = text.slice(markerAt + marker.length)
        .split(/\r?\n/)
        .map((line) => line.replace(/^>\s?/, ''));
    const divider = lines.findIndex((line) => line.trim() === '');
    if (divider < 0) return null;
    const headers = new Map();
    for (const line of lines.slice(0, divider)) {
        const match = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*?)\s*$/.exec(line);
        if (match) headers.set(match[1], match[2]);
    }
    if (headers.get('surface') !== 'agent' || headers.get('sessionId') !== sessionId) return null;
    const status = cleanValue(headers.get('status')).toLowerCase();
    if (!/^(?:completed|failed|cancelled)$/.test(status)) return null;
    const body = lines.slice(divider + 1).join('\n').trim();
    if (!body) return null;
    return {
        body,
        status,
        tag: cleanValue(headers.get('tag') || headers.get('label')),
        agent: cleanValue(headers.get('agent')),
        provider: cleanValue(headers.get('provider')),
        model: cleanValue(headers.get('model')),
        effort: cleanValue(headers.get('effort')),
        fast: cleanValue(headers.get('fast')).toLowerCase() === 'true',
        finishedAt: Date.parse(cleanValue(headers.get('finished'))) || 0,
    };
}

/** Legacy recovery for child transcripts already unlinked by terminal reaping.
 * The parent owns one canonical body-carrying completion notification, so scan
 * only files containing the exact child id and project the newest valid body. */
function readArchivedAgentResult(sessionId) {
    const dir = join(dataDir(), 'sessions');
    if (probePath(dir).state !== PROBE_PRESENT) return null;
    let files;
    try { files = readdirSync(dir).filter((file) => file.endsWith('.json')); }
    catch { return null; }
    let best = null;
    for (const file of files) {
        let raw;
        try { raw = readFileSync(join(dir, file), 'utf8'); } catch { continue; }
        if (!raw.includes(sessionId)) continue;
        const record = readTopLevelLifecycleRecord(raw);
        if (isLifecycleUnreadable(record) || record.id === sessionId) continue;
        const parent = record.doc;
        const messages = Array.isArray(parent.messages) ? parent.messages : [];
        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index];
            if (message?.role !== 'user') continue;
            const archived = archivedAgentNotification(message.content, sessionId);
            if (!archived) continue;
            const at = positiveNumber(
                message?.meta?.transcript?.at,
                archived.finishedAt || positiveNumber(parent.updatedAt),
            );
            if (best && best.at > at) continue;
            best = { ...archived, at, parent };
            break;
        }
    }
    if (!best) return null;
    const text = `# Archived agent result\n\n${best.body}`;
    return {
        sessionId,
        items: [{
            id: `archived-agent-result:${sessionId}`,
            kind: 'assistant',
            text,
            status: best.status,
            ...(best.at ? { at: best.at } : {}),
            ...(best.model ? { model: best.model } : {}),
            ...(best.provider ? { provider: best.provider } : {}),
            ...(best.agent ? { agent: best.agent } : {}),
        }],
        provider: best.provider,
        model: best.model,
        effort: best.effort,
        fast: best.fast,
        cwd: cleanValue(best.parent.cwd),
        desktopSession: desktopSession(best.parent.desktopSession, best.parent.cwd),
        workflow: null,
        stats: {
            currentContextTokens: 0,
            currentEstimatedContextTokens: 0,
            currentContextSource: null,
        },
        contextWindow: null,
        rawContextWindow: null,
        displayContextWindow: null,
        autoCompactTokenLimit: null,
        archivedAgentResult: true,
        readOnlyDetachedAgent: false,
    };
}

function activeAgentWorker(row) {
    const statuses = [row?.stage, row?.status]
        .map(cleanValue)
        .filter((status, index, values) => Boolean(status) && values.indexOf(status) === index);
    return statuses.length > 0
        && !statuses.some((status) => DEAD_AGENT_STATUS.test(status))
        && statuses.some((status) => LIVING_AGENT_STATUS.test(status));
}

export function storedAgentWorkerIndexPath() {
    return join(dataDir(), 'agent-workers.json');
}

function mergeLeadSessionsIntoPool(bySessionId, now) {
    let summaries = [];
    try { summaries = listStoredSessionSummaries(); }
    catch { return; }
    for (const row of summaries) {
        const sessionId = cleanValue(row?.id);
        if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) continue;
        const current = bySessionId.get(sessionId);
        const currentAgent = cleanValue(current?.agent).toLowerCase();
        if (current && currentAgent && currentAgent !== 'lead') continue;
        const heartbeatAt = positiveNumber(row.heartbeatAt, 0);
        const running = heartbeatAt > 0 && now - heartbeatAt <= AGENT_POOL_HEARTBEAT_FRESH_MS;
        const status = running ? 'running' : 'idle';
        bySessionId.set(sessionId, {
            tag: cleanValue(current?.tag) || `lead:${sessionId}`,
            sessionId,
            ownerSessionId: sessionId,
            agent: 'lead',
            provider: cleanValue(row.provider || current?.provider) || null,
            model: cleanValue(row.model || current?.model) || null,
            effort: cleanValue(row.effort || current?.effort) || null,
            fast: row.fast === true || current?.fast === true,
            status,
            stage: status,
            startedAt: row.createdAt || current?.startedAt || null,
            turnStartedAt: running ? (current?.turnStartedAt || heartbeatAt) : null,
            createdAt: row.createdAt || current?.createdAt || null,
            updatedAt: row.updatedAt || current?.updatedAt || heartbeatAt || null,
            cwd: cleanValue(row.cwd || current?.cwd) || null,
            clientHostPid: positiveNumber(row.clientHostPid || current?.clientHostPid, 0) || null,
            taskId: cleanValue(current?.taskId) || null,
        });
    }
}

/** Process-global active agent pool. Fresh child heartbeat sidecars are the
 * cross-process running source even when their durable session is detached
 * (`closed`) and a terminal reaper has already removed the worker-index row.
 * The index remains additive for living rows (running or idle) published before
 * the heartbeat or by runtimes without a sidecar. No runtime starts. */
export function listStoredAgentWorkers() {
    let parsed = null;
    try {
        parsed = JSON.parse(readFileSync(storedAgentWorkerIndexPath(), 'utf8'));
    } catch { /* heartbeat-backed rows remain authoritative without the index */ }
    const source = Array.isArray(parsed?.workers)
        ? parsed.workers
        : parsed?.workers && typeof parsed.workers === 'object'
            ? Object.values(parsed.workers)
            : [];
    const bySessionId = new Map();
    for (const row of source) {
        if (!row || typeof row !== 'object' || !activeAgentWorker(row)) continue;
        const sessionId = cleanValue(row.sessionId);
        const tag = cleanValue(row.tag);
        if (!sessionId || !tag || !/^[A-Za-z0-9_-]+$/.test(sessionId)) continue;
        let session = null;
        if (!cleanValue(row.ownerSessionId || row.parentSessionId)) {
            try {
                session = JSON.parse(readFileSync(
                    join(dataDir(), 'sessions', `${sessionId}.json`),
                    'utf8',
                ));
            } catch { /* a new row may precede its first session save */ }
        }
        bySessionId.set(sessionId, {
            tag,
            sessionId,
            ownerSessionId: cleanValue(
                row.ownerSessionId || row.parentSessionId
                || session?.ownerSessionId || session?.parentSessionId,
            ) || null,
            agent: cleanValue(row.agent || session?.agent) || null,
            provider: cleanValue(row.provider || session?.provider) || null,
            model: cleanValue(row.model || session?.model) || null,
            effort: cleanValue(row.effort || session?.effort) || null,
            fast: row.fast === true || session?.fast === true,
            status: cleanValue(row.status) || 'running',
            stage: cleanValue(row.stage || row.status) || 'running',
            startedAt: row.startedAt || row.createdAt || session?.createdAt || null,
            turnStartedAt: row.turnStartedAt || null,
            createdAt: row.createdAt || session?.createdAt || null,
            updatedAt: row.updatedAt || session?.updatedAt || null,
            cwd: cleanValue(row.cwd || session?.cwd) || null,
            clientHostPid: positiveNumber(row.clientHostPid || session?.clientHostPid, 0) || null,
            taskId: cleanValue(row.task_id || row.taskId) || null,
        });
    }
    const now = Date.now();
    for (const [sessionId, heartbeatAt] of sessionHeartbeatMtimes()) {
        if (now - heartbeatAt > AGENT_POOL_HEARTBEAT_FRESH_MS) continue;
        let session;
        try {
            session = JSON.parse(readFileSync(
                join(dataDir(), 'sessions', `${sessionId}.json`),
                'utf8',
            ));
        } catch {
            continue;
        }
        const ownerSessionId = cleanValue(
            session?.ownerSessionId || session?.parentSessionId,
        );
        const owner = cleanValue(session?.owner).toLowerCase();
        const agent = cleanValue(session?.agent);
        if (!ownerSessionId || (owner !== 'agent' && (!agent || agent === 'lead'))) continue;
        const current = bySessionId.get(sessionId) || {};
        bySessionId.set(sessionId, {
            ...current,
            tag: cleanValue(session?.agentTag) || cleanValue(current.tag)
                || `${agent || 'agent'}:${sessionId}`,
            sessionId,
            ownerSessionId,
            agent: agent || current.agent || null,
            provider: cleanValue(session?.provider) || current.provider || null,
            model: cleanValue(session?.model) || current.model || null,
            effort: cleanValue(session?.effort) || current.effort || null,
            fast: session?.fast === true || current.fast === true,
            // The sidecar is the live lease. Durable child sessions are
            // intentionally detached/closed while their external owner runs.
            status: 'running',
            stage: 'running',
            startedAt: session?.createdAt || current.startedAt || heartbeatAt,
            turnStartedAt: current.turnStartedAt || null,
            createdAt: session?.createdAt || current.createdAt || null,
            updatedAt: heartbeatAt,
            cwd: cleanValue(session?.cwd) || current.cwd || null,
            clientHostPid: positiveNumber(session?.clientHostPid, 0)
                || current.clientHostPid || null,
            taskId: cleanValue(session?.task_id || session?.taskId)
                || current.taskId || null,
        });
    }
    mergeLeadSessionsIntoPool(bySessionId, now);
    const rows = [...bySessionId.values()];
    return rows.sort((left, right) => {
        const leftTime = Date.parse(String(left.startedAt || '')) || 0;
        const rightTime = Date.parse(String(right.startedAt || '')) || 0;
        return leftTime - rightTime || left.tag.localeCompare(right.tag);
    });
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
        sourceDelivery: row.sourceDelivery || null,
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
        title: cleanText(row.title, 100),
        preview: cleanText(row.preview),
        generation: typeof row.generation === 'number' ? row.generation : 0,
        storageMtimeMs: positiveNumber(row.storageMtimeMs, 0),
        storageSize: positiveNumber(row.storageSize, 0),
        detachedReason: row.detachedReason || null,
    };
}

function leadRowsWithAgentHeartbeat(rows) {
    const agentHeartbeatByOwner = new Map();
    for (const row of rows) {
        const heartbeatAt = positiveNumber(row?.heartbeatAt, 0);
        const ownerSessionId = String(row?.ownerSessionId || '').trim();
        const owner = String(row?.owner || '').trim().toLowerCase();
        const agent = String(row?.agent || '').trim().toLowerCase();
        if (!heartbeatAt || !ownerSessionId
            || (owner !== 'agent' && (!agent || agent === 'lead'))) continue;
        agentHeartbeatByOwner.set(
            ownerSessionId,
            Math.max(agentHeartbeatByOwner.get(ownerSessionId) || 0, heartbeatAt),
        );
    }
    return rows
        .filter((row) => row && isLeadVisibleRow(row))
        .map((row) => {
            const agentHeartbeatAt = agentHeartbeatByOwner.get(row.id) || 0;
            return agentHeartbeatAt > 0 ? { ...row, agentHeartbeatAt } : row;
        });
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
    if (probePath(directory).state !== PROBE_PRESENT) return result;
    let entries = [];
    try { entries = readdirSync(directory); } catch { return result; }
    for (const filename of entries) {
        if (!filename.endsWith('.hb')) continue;
        const id = filename.slice(0, -3);
        if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
        // Liveness is additive: a sidecar that is absent OR unreadable simply
        // contributes nothing, and can never remove a row.
        const probe = probePath(join(directory, filename));
        if (probe.state === PROBE_PRESENT && probe.mtimeMs > 0) result.set(id, probe.mtimeMs);
    }
    return result;
}

/**
 * Read-only scan of the authoritative session files.
 * Returns `null` when the directory itself is NOT enumerable (unreadable
 * stat / readdir): that is not "no sessions", and the caller must keep the
 * authority it already has (the index rows) instead of publishing an empty
 * catalog. `indexRowsById` carries those rows so unchanged files can reuse the
 * durable summary and a single UNREADABLE file retains its last known row
 * instead of vanishing.
 */
function scanSessionFiles(
    heartbeatMtimes = sessionHeartbeatMtimes(),
    indexRowsById = new Map(),
    { indexMtimeMs = 0, forceRead = false } = {},
) {
    const directory = join(dataDir(), 'sessions');
    const dirProbe = probePath(directory);
    if (dirProbe.state === PROBE_ABSENT) return [];
    if (dirProbe.state !== PROBE_PRESENT) return null;
    let entries;
    try { entries = readdirSync(directory); } catch { return null; }
    const rows = [];
    for (const filename of entries) {
        if (!filename.endsWith('.json')) continue;
        const storageId = filename.slice(0, -5);
        const path = join(directory, filename);
        const retained = indexRowsById.get(storageId);
        const probe = probePath(path);
        // Provably gone: the row legitimately disappears with the file.
        if (probe.state === PROBE_ABSENT) continue;
        if (probe.state !== PROBE_PRESENT) {
            if (retained) rows.push(retained);
            continue;
        }
        if (!forceRead && retained) {
            const exactFingerprint = retained.storageMtimeMs > 0
                && retained.storageSize > 0
                && retained.storageMtimeMs === probe.mtimeMs
                && retained.storageSize === probe.size;
            // Older v2 rows predate per-file fingerprints. Their global index
            // timestamp remains a one-release compatibility fallback; every
            // later save/rebuild stamps the exact (mtimeMs,size) pair.
            const legacyUnchanged = retained.storageMtimeMs === 0
                && indexMtimeMs > 0
                && (probe.mtimeMs || 0) <= indexMtimeMs;
            if (exactFingerprint || legacyUnchanged) {
                rows.push(retained);
                continue;
            }
        }
        const read = readTextFile(path);
        // Provably gone: the row legitimately disappears with the file.
        if (read.state === PROBE_ABSENT) continue;
        if (read.state !== PROBE_PRESENT) {
            // Exists and could not be read (EACCES/EIO): retain the last known
            // row rather than let a transient IO error delete it from view.
            if (retained) rows.push(retained);
            continue;
        }
        // Same strict authority as the store: a duplicate/ambiguous top-level
        // record or a foreign identity is not this file's session.
        const record = readTopLevelLifecycleRecord(read.text);
        if (isLifecycleUnreadable(record) || record.id !== storageId) continue;
        const summary = rowFromSession(record.doc, heartbeatMtimes.get(record.id) || 0);
        const row = summary
            ? { ...summary, storageMtimeMs: probe.mtimeMs, storageSize: probe.size }
            : null;
        if (row) rows.push(row);
    }
    return leadRowsWithAgentHeartbeat(rows).sort((left, right) =>
        (right.lastUsedAt || right.updatedAt || 0) - (left.lastUsedAt || left.updatedAt || 0));
}

export function listStoredSessionSummaries(options = {}) {
    const heartbeatMtimes = sessionHeartbeatMtimes();
    const indexPath = join(dataDir(), 'session-summaries.json');
    // The index is read on EVERY path (it is one small file): its rows are the
    // authority that must be retained whenever storage cannot be enumerated or
    // an individual session file cannot be read.
    const indexRowsById = new Map();
    let indexRows = null;
    let indexMtimeMs = 0;
    const indexRead = readTextFile(indexPath);
    if (indexRead.state === PROBE_PRESENT) {
        try {
            const index = JSON.parse(indexRead.text);
            if (Number(index?.version) === SESSION_SUMMARY_INDEX_VERSION) {
                const normalizedRows = (Array.isArray(index.rows) ? index.rows : [])
                    .map((row) => normalizedRow(row, heartbeatMtimes.get(row?.id) || 0))
                    .filter(Boolean);
                for (const row of normalizedRows) indexRowsById.set(row.id, row);
                indexRows = leadRowsWithAgentHeartbeat(normalizedRows)
                    .sort((left, right) =>
                        (right.lastUsedAt || right.updatedAt || 0) - (left.lastUsedAt || left.updatedAt || 0));
                const indexProbe = probePath(indexPath);
                if (indexProbe.state === PROBE_PRESENT) indexMtimeMs = indexProbe.mtimeMs || 0;
            }
        } catch { /* malformed sidecar: the files below are the authority */ }
    }
    // An index that EXISTS but is unreadable (EACCES/EIO) is neither missing
    // nor empty: the scan below still runs, and when IT cannot enumerate
    // either, the catalog reports nothing rather than inventing an empty truth.
    const scan = (forceRead = false) => scanSessionFiles(
        heartbeatMtimes,
        indexRowsById,
        { indexMtimeMs, forceRead },
    );
    if (options.refreshFromStorage === true) return scan(true) ?? indexRows ?? [];
    if (indexRows) {
        if (options.rebuildIfMissing === false) return indexRows;
        // Enumerate identities to detect deletions, stat known files, and parse
        // only rows newer than the index. Cold-start cost therefore scales with
        // changed transcripts rather than total transcript bytes.
        return scan(false) ?? indexRows;
    }
    // Missing/malformed index is the sole cold path that must rebuild every
    // summary from canonical session bytes.
    return options.rebuildIfMissing === false ? [] : (scan(true) ?? indexRows ?? []);
}

/** Exact, fail-closed existence check for a durable session address.
 * Summary indexes and desktop metadata are presentation caches; neither may
 * make a missing sessions/<id>.json record addressable again. */
export function storedSessionExists(id) {
    const sessionId = String(id || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return false;
    const read = readTextFile(join(dataDir(), 'sessions', `${sessionId}.json`));
    if (read.state !== PROBE_PRESENT) return false;
    const record = readTopLevelLifecycleRecord(read.text);
    return !isLifecycleUnreadable(record) && record.id === sessionId;
}

/** Read exactly one persisted session for a visible desktop pane. This never
 * enumerates siblings. Normal reads stay independent of runtime ownership;
 * interrupted turns conditionally use the same durable reconnect recovery as
 * resumeSession before projecting the transcript. */
export async function readStoredSessionTranscript(id, options = {}) {
    const sessionId = String(id || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
    // Same strict authority as the store, and the same fail-closed rule: an
    // absent, unreadable, ambiguous or foreign record yields no transcript.
    const read = readTextFile(join(dataDir(), 'sessions', `${sessionId}.json`));
    if (read.state === PROBE_ABSENT) return readArchivedAgentResult(sessionId);
    if (read.state !== PROBE_PRESENT) return null;
    const record = readTopLevelLifecycleRecord(read.text);
    if (isLifecycleUnreadable(record) || record.id !== sessionId) return null;
    let session = record.doc;
    const owner = cleanValue(session.owner).toLowerCase();
    const agent = cleanValue(session.agent).toLowerCase();
    const liveDetachedAgent = session.closed === true
        && (owner === 'agent' || (agent && agent !== 'lead'))
        && Boolean(cleanValue(session.ownerSessionId || session.parentSessionId));
    // Only a PROVABLY absent checkpoint skips recovery: an unreadable probe
    // must not silently downgrade an interrupted turn to a plain cold read.
    if (probePath(join(dataDir(), 'turn-checkpoints', `${sessionId}.json`)).state !== PROBE_ABSENT) {
        if (liveDetachedAgent) {
            const {
                projectTurnCheckpointMessages,
                readTurnCheckpoint,
            } = await import('./manager/turn-checkpoint.mjs');
            const checkpoint = readTurnCheckpoint(sessionId);
            if (checkpoint) {
                session = {
                    ...session,
                    messages: projectTurnCheckpointMessages(session, checkpoint),
                };
            }
        } else {
            const { recoverSessionAfterProcessRestart } = await import('./manager.mjs');
            session = recoverSessionAfterProcessRestart(sessionId) || session;
        }
    }
    const {
        restoreTranscriptItems,
        sessionContextSnapshotProjection,
    } = await import(
        '../../../../tui/session/session-api-ext.mjs'
    );
    let preparedContextProjection = null;
    try {
        const [
            { prepareSessionProjection },
            { createContextStatus },
        ] = await Promise.all([
            import('./manager.mjs'),
            import('../../../../session-runtime/context-status.mjs'),
        ]);
        const prepared = prepareSessionProjection(session, 'full');
        if (prepared) session = prepared;
        const { contextStatus } = createContextStatus({
            getSession: () => session,
            getRoute: () => ({
                provider: session.provider || '',
                model: session.model || '',
                contextWindow: session.contextWindow || null,
            }),
            getCurrentCwd: () => session.cwd || '',
            getMode: () => 'full',
        });
        preparedContextProjection = sessionContextSnapshotProjection(session, contextStatus());
    } catch {
        // Cold context projection is presentation-only. The transcript and
        // legacy estimator below remain available if provider/tool prep fails.
    }
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const hasConversationActivity = messages.some((message) => message?.role === 'user');
    let currentEstimatedContextTokens = 0;
    if (hasConversationActivity) {
        try {
            const { estimateTranscriptContextUsage } = await import('./context-utils.mjs');
            currentEstimatedContextTokens = estimateTranscriptContextUsage(
                messages,
                Array.isArray(session.tools) ? session.tools : [],
                { provider: session.provider },
            );
        } catch {
            // Context metering is presentation-only. A cold transcript remains
            // readable even if its optional estimator cannot be loaded.
        }
    }
    const contextWindow = positiveNumber(session.contextWindow);
    const rawContextWindow = positiveNumber(session.rawContextWindow, contextWindow);
    const displayContextWindow = positiveNumber(session.compactBoundaryTokens, contextWindow);
    const rawAutoCompactTokenLimit = positiveNumber(session.autoCompactTokenLimit);
    const autoCompactTokenLimit = rawAutoCompactTokenLimit
        && (!displayContextWindow || rawAutoCompactTokenLimit < displayContextWindow)
        ? rawAutoCompactTokenLimit
        : 0;
    const requestedLimit = Number(options.transcriptItemLimit);
    return {
        sessionId,
        items: restoreTranscriptItems(messages, {
            sessionId,
            itemLimit: Number.isFinite(requestedLimit) && requestedLimit > 0
                ? requestedLimit
                : Number.POSITIVE_INFINITY,
        }),
        provider: session.provider || '',
        model: session.model || '',
        effort: session.effort || '',
        fast: session.fast === true,
        modelParameters: session.modelParameters || {},
        cwd: session.cwd || '',
        desktopSession: desktopSession(session.desktopSession, session.cwd),
        workflow: session.workflow || null,
        ...(preparedContextProjection ? {
            ...preparedContextProjection,
            preparedContextProjection: true,
        } : {
            stats: {
                currentContextTokens: 0,
                currentEstimatedContextTokens,
                currentContextSource: currentEstimatedContextTokens > 0 ? 'estimated' : null,
            },
            contextWindow: contextWindow || null,
            rawContextWindow: rawContextWindow || null,
            displayContextWindow: displayContextWindow || null,
            autoCompactTokenLimit: autoCompactTokenLimit || null,
        }),
        // Desktop must not ask its unrelated active engine to recover/peek an
        // externally owned child: that runtime can only return the detached
        // Task row and masks this checkpoint projection.
        readOnlyDetachedAgent: liveDetachedAgent,
    };
}

/**
 * Lightweight desktop background viewer. It reuses the owner's existing
 * live-share pipe without creating a second engine/runtime or claiming session
 * ownership. The caller has already published the cold disk snapshot; the
 * owner's first full frame atomically replaces it, then deltas keep the pane
 * current while it remains visible.
 */
export async function createStoredSessionLiveViewer(id, options = {}) {
    const sessionId = String(id || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)
        || typeof options.onSnapshot !== 'function') return null;
    const initial = options.initialSnapshot && typeof options.initialSnapshot === 'object'
        ? options.initialSnapshot
        : {};
    let state = {
        ...initial,
        sessionId,
        items: Array.isArray(initial.items) ? initial.items : [],
        queued: Array.isArray(initial.queued) ? initial.queued : [],
        streamingTail: initial.streamingTail || null,
        spinner: initial.spinner || null,
    };
    let disposed = false;
    let publishQueued = false;
    const publish = () => {
        if (disposed || publishQueued) return;
        publishQueued = true;
        queueMicrotask(() => {
            publishQueued = false;
            if (disposed) return;
            try { options.onSnapshot(state); } catch { /* host lane isolation */ }
        });
    };
    const commit = (patch) => {
        state = { ...state, ...patch, sessionId };
        publish();
    };
    const viewerApply = {
        getState: () => state,
        set: (patch) => commit(patch && typeof patch === 'object' ? patch : {}),
        replaceItems: (items, replaceOptions = {}) => commit({
            items: Array.isArray(items) ? [...items] : [],
            ...(replaceOptions.preserveStreamingTail === true
                ? {}
                : { streamingTail: null }),
        }),
        patchItem: (itemId, patch) => {
            const index = state.items.findIndex((item) => item?.id === itemId);
            if (index < 0) return false;
            const items = [...state.items];
            items[index] = { ...items[index], ...patch };
            commit({ items });
            return true;
        },
        appendItems: (items) => {
            if (!Array.isArray(items) || items.length === 0) return;
            commit({ items: [...state.items, ...items] });
        },
        updateStreamingTail: (itemId, patch, _unused = {}, updateOptions = {}) => {
            const current = updateOptions.resetText !== true
                && state.streamingTail?.id === itemId
                ? state.streamingTail
                : { id: itemId, text: '' };
            commit({ streamingTail: { ...current, ...patch, id: itemId } });
        },
        clearStreamingTail: () => commit({ streamingTail: null }),
    };
    const { createLiveShare, liveSharePipePath } = await import(
        '../../../../tui/session/live-share.mjs'
    );
    const share = createLiveShare({
        ownerSessionId: () => '',
        viewerSessionId: () => disposed ? '' : sessionId,
        socketPathFor: (targetId) => liveSharePipePath(
            targetId,
            join(dataDir(), 'sessions', `${targetId}.json`),
        ),
        getPublishedState: () => state,
        listeners: new Set(),
        onRemoteSubmit: () => {},
        onRemoteAbort: () => {},
        onOwnerClosed: () => {
            if (!disposed) options.onOwnerClosed?.();
        },
        viewerApply,
        // A visible desktop pane may remain open before its external owner
        // starts. Keep one bounded retry per pane instead of the TUI's
        // latency-first 160ms retry ceiling.
        viewerRetryMaxMs: 1_000,
    });
    share.ensure();
    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            share.dispose();
        },
    };
}
