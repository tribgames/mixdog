// Codex client-metadata for the openai-oauth WebSocket transport: the
// installation/session/thread/turn identity block that rides every frame, its
// handshake-header projection, and the per-turn x-codex-turn-state guard.
// Extracted from openai-oauth-ws.mjs, which now owns transport flow only.
import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPluginData } from '../config.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let _installationId = null;

function _cleanMetaString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function _codexUuidV7(value) {
    const clean = String(value || '').trim().toLowerCase();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clean)) {
        return clean;
    }
    const digest = createHash('sha256').update(clean).digest();
    const bytes = Buffer.from(digest.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function _hashText(value, chars = 24) {
    return createHash('sha256').update(String(value || '')).digest('hex').slice(0, chars);
}

// Session ids embed their creation stamp; fall back to now for foreign shapes.
function _sessionStartedAtUnixMs(sessionId) {
    const compactUuid = String(sessionId || '').trim().replace(/-/g, '');
    if (/^[0-9a-f]{12}7[0-9a-f]{19}$/i.test(compactUuid)) {
        const timestamp = Number.parseInt(compactUuid.slice(0, 12), 16);
        if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
    }
    const parts = String(sessionId || '').split('_');
    for (const part of parts) {
        if (/^\d{12,}$/.test(part)) {
            const n = Number(part);
            if (Number.isFinite(n) && n > 0) return Math.floor(n);
        }
    }
    return Date.now();
}

function _codexRequestKind(sendOpts, sessionId) {
    const explicit = _cleanMetaString(sendOpts?.requestKind || sendOpts?.codexRequestKind);
    if (explicit) return explicit;
    return String(sessionId || '').includes(':compact') ? 'compaction' : 'turn';
}

function _codexInstallationId(sendOpts) {
    const explicit = _cleanMetaString(
        sendOpts?.installationId
        || sendOpts?.codexInstallationId
        || process.env.MIXDOG_CODEX_INSTALLATION_ID,
    ).toLowerCase();
    if (UUID_RE.test(explicit)) return explicit;
    if (_installationId) return _installationId;
    const dir = getPluginData();
    const file = join(dir, 'installation_id');
    try {
        const existing = existsSync(file) ? readFileSync(file, 'utf8').trim().toLowerCase() : '';
        if (UUID_RE.test(existing)) {
            _installationId = existing;
            return _installationId;
        }
    } catch {}
    const generated = randomUUID();
    try {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        try {
            writeFileSync(file, generated, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
        } catch {
            const winner = readFileSync(file, 'utf8').trim().toLowerCase();
            if (UUID_RE.test(winner)) {
                _installationId = winner;
                return _installationId;
            }
            writeFileSync(file, generated, { encoding: 'utf8', mode: 0o644 });
        }
    } catch {}
    _installationId = generated;
    return _installationId;
}

// The identity block is rebuilt per request: never cached on the pooled
// socket, or a later turn would
// replay the first turn's identity.
function _codexMetadataBase(entry, { poolKey, cacheKey, sendOpts, handshake = false } = {}) {
    const rawSessionId = _cleanMetaString(
        sendOpts?.codexSessionId
        || sendOpts?.session?.codexWireSessionId
        || sendOpts?.session?.codexSessionId
        || poolKey
        || cacheKey,
    )
        || 'mixdog-session';
    const rawThreadId = _cleanMetaString(
        sendOpts?.threadId
        || sendOpts?.codexThreadId
        || sendOpts?.session?.codexWireSessionId
        || sendOpts?.session?.threadId
        || cacheKey
        || rawSessionId,
    )
        || rawSessionId;
    const rawInstallationId = _codexInstallationId(sendOpts);
    const sessionId = _codexUuidV7(rawSessionId);
    const threadId = _codexUuidV7(rawThreadId);
    const installationId = rawInstallationId;
    const startedAt = Number.isFinite(Number(sendOpts?.turnStartedAtUnixMs))
        ? Math.floor(Number(sendOpts.turnStartedAtUnixMs))
        : _sessionStartedAtUnixMs(rawSessionId);
    const requestKind = _codexRequestKind(sendOpts, rawSessionId);
    // The reference client opens the WS with a prewarm (empty turn_id) BEFORE
    // the real turn, so the handshake is always identified as a prewarm rather
    // than as a live turn.
    const isPrewarm = requestKind === 'prewarm' || handshake === true;
    const rawExplicitTurnId = _cleanMetaString(sendOpts?.turnId || sendOpts?.codexTurnId || sendOpts?.session?.turnId);
    const explicitWindowId = _cleanMetaString(sendOpts?.windowId || sendOpts?.codexWindowId || sendOpts?.session?.windowId);
    const turnId = isPrewarm
        ? ''
        : _codexUuidV7(rawExplicitTurnId || `${rawSessionId}:turn`);
    const effectiveRequestKind = isPrewarm ? 'prewarm' : requestKind;
    // Window id is `<thread-id>:<auto-compact window number>`, and that counter
    // starts at 0: a thread that never auto-compacted reports generation 0 and
    // only advances when a new context window opens.
    const windowId = explicitWindowId || `${threadId}:0`;
    const turnMetadata = {
        installation_id: installationId,
        session_id: sessionId,
        thread_id: threadId,
        agent_name: '/root',
        turn_id: turnId,
        window_id: windowId,
        request_kind: effectiveRequestKind,
        thread_source: 'user',
        sandbox: 'none',
        sandbox_mode: 'danger-full-access',
        auto_review_enabled: false,
        node_repl_auto_review_required: false,
        node_repl_disabled: false,
        ...(!isPrewarm ? { turn_started_at_unix_ms: startedAt } : {}),
    };
    return {
        'x-codex-installation-id': installationId,
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
        'x-codex-window-id': windowId,
        'x-codex-turn-metadata': JSON.stringify(turnMetadata),
    };
}

export function _metadataTrace(metadata) {
    if (!metadata || typeof metadata !== 'object') {
        return { count: 0, hash: null, hasTurnMetadata: false, hasThreadId: false };
    }
    const keys = Object.keys(metadata).sort();
    return {
        count: keys.length,
        hash: _hashText(keys.map((key) => `${key}=${metadata[key]}`).join('\n'), 12),
        hasTurnMetadata: typeof metadata['x-codex-turn-metadata'] === 'string' && metadata['x-codex-turn-metadata'].length > 0,
        hasThreadId: typeof metadata.thread_id === 'string' && metadata.thread_id.length > 0,
    };
}

// The WebSocket handshake carries compatibility identity and routing fields.
// Installation and Responses Lite data stay in per-request client_metadata.
export function _codexWsCompatibilityHeaders(context = {}) {
    const metadata = _codexMetadataBase(null, context);
    const headers = {};
    if (metadata.session_id) headers['session-id'] = metadata.session_id;
    if (metadata.thread_id) {
        headers['thread-id'] = metadata.thread_id;
        headers['x-client-request-id'] = metadata.thread_id;
    }
    if (metadata['x-codex-window-id']) headers['x-codex-window-id'] = metadata['x-codex-window-id'];
    if (metadata['x-codex-turn-metadata']) headers['x-codex-turn-metadata'] = metadata['x-codex-turn-metadata'];
    // Routing hint. The reference client attaches this to EVERY request whose
    // auth is the ChatGPT backend — no flag, no mode, and with `model=` alone
    // when no service tier is selected. It is how the backend lands the request
    // on a node that already holds this model's prefix, so leaving it off makes
    // node selection arbitrary and the first call of a session pays a cold
    // prefix. Measured 2026-08-22: without the hint, 3 of 8 parallel sessions
    // started with 0 cached tokens and 6 warm calls missed; the run that
    // happened to carry a priority tier (its own routing signal) missed none.
    const model = _cleanMetaString(context?.model || context?.sendOpts?.model);
    if (model) {
        const serviceTier = _cleanMetaString(context?.serviceTier
            || context?.sendOpts?.serviceTier
            || context?.sendOpts?.service_tier);
        headers['x-codex-routing-hint'] = serviceTier
            ? `model=${model};tier=${serviceTier}`
            : `model=${model}`;
    }
    return headers;
}

export function _withCodexWsClientMetadata(frame, entry, enabled, context = {}) {
    if (!enabled || !frame || typeof frame !== 'object') return frame;
    const base = _codexMetadataBase(entry, context);
    const requestKind = _codexRequestKind(context?.sendOpts, context?.poolKey || '');
    const isPrewarmRequest = requestKind === 'prewarm';
    const metadata = {
        ...base,
        ...(frame.client_metadata && typeof frame.client_metadata === 'object' ? frame.client_metadata : {}),
        ...(context?.useResponsesLite === true
            ? { ws_request_header_x_openai_internal_codex_responses_lite: 'true' }
            : {}),
        'x-codex-ws-stream-request-start-ms': String(Date.now()),
    };
    if (entry && typeof entry === 'object') {
        // x-codex-turn-state is scoped to ONE turn while
        // pooled sockets span turns: attribute a captured token to the FIRST
        // turn that observes it, then drop it once turn_id moves on. An empty
        // turn_id (parity prewarm) is a valid owner, so the check is against
        // null rather than falsiness.
        if (entry.turnState) {
            if (entry.turnStateTurnId == null) {
                entry.turnStateTurnId = base.turn_id;
            } else if (entry.turnStateTurnId !== base.turn_id) {
                // Codex startup prewarm owns the handshake turn-state until
                // the first real turn consumes that prewarmed client session.
                // Adopt it once across prewarm→turn; ordinary turn changes
                // still retire the old token.
                if (entry.turnStateFromPrewarm === true && !isPrewarmRequest) {
                    entry.turnStateTurnId = base.turn_id;
                } else {
                    entry.turnState = null;
                    entry.turnStateTurnId = null;
                }
            }
        }
        if (!isPrewarmRequest && entry.turnStateFromPrewarm === true) {
            entry.turnStateFromPrewarm = false;
        }
        entry.currentTurnId = base.turn_id;
    }
    if (entry?.turnState) metadata['x-codex-turn-state'] = String(entry.turnState);
    return { ...frame, client_metadata: metadata };
}
