// Codex client-metadata for the openai-oauth WebSocket transport: the
// installation/session/thread/turn identity block that rides every frame, its
// handshake-header projection, and the per-turn x-codex-turn-state guard.
// Extracted from openai-oauth-ws.mjs, which now owns transport flow only.
import { createHash } from 'crypto';

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
    return _cleanMetaString(sendOpts?.installationId || sendOpts?.codexInstallationId || process.env.MIXDOG_CODEX_INSTALLATION_ID)
        || `mixdog-${_hashText(`${process.env.USERPROFILE || process.env.HOME || ''}:${process.cwd()}`, 32)}`;
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
    const wireParity = process.env.MIXDOG_OAI_CODEX_WIRE_PARITY === '1';
    const sessionId = wireParity ? _codexUuidV7(rawSessionId) : rawSessionId;
    const threadId = wireParity ? _codexUuidV7(rawThreadId) : rawThreadId;
    const installationId = wireParity ? _codexUuidV7(rawInstallationId) : rawInstallationId;
    const startedAt = Number.isFinite(Number(sendOpts?.turnStartedAtUnixMs))
        ? Math.floor(Number(sendOpts.turnStartedAtUnixMs))
        : _sessionStartedAtUnixMs(rawSessionId);
    const requestKind = _codexRequestKind(sendOpts, rawSessionId);
    // The reference client opens the WS with a prewarm (empty turn_id) BEFORE
    // the real turn. Under wire parity the handshake IS that prewarm, so its
    // turn_id empties and its request_kind becomes 'prewarm' instead of
    // presenting the handshake as a live turn. Parity off is unchanged.
    const isPrewarm = requestKind === 'prewarm' || handshake === true;
    const rawExplicitTurnId = _cleanMetaString(sendOpts?.turnId || sendOpts?.codexTurnId || sendOpts?.session?.turnId);
    const explicitWindowId = _cleanMetaString(sendOpts?.windowId || sendOpts?.codexWindowId || sendOpts?.session?.windowId);
    const turnId = wireParity && isPrewarm
        ? ''
        : wireParity
            ? _codexUuidV7(rawExplicitTurnId || `${rawSessionId}:turn`)
            : (rawExplicitTurnId || sessionId);
    const effectiveRequestKind = wireParity && isPrewarm ? 'prewarm' : requestKind;
    // Window id is `<thread-id>:<auto-compact window number>`, and that counter
    // starts at 0: a thread that never auto-compacted reports generation 0 and
    // only advances when a new context window opens. The legacy non-parity
    // wire kept :1 and is left alone so measured default behavior is unchanged.
    const windowId = explicitWindowId || `${threadId}:${wireParity ? 0 : 1}`;
    const turnMetadata = {
        installation_id: installationId,
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
        window_id: windowId,
        request_kind: effectiveRequestKind,
        // Turn-metadata fields the reference client fills on every request.
        // They were behind a probe knob after a 2026-07-04 A/B showed no
        // isolated effect; they are unconditional now because a partial blob is
        // a shape no real client sends. Absolute agent path, not a bare name;
        // the sandbox pair reports this runtime honestly (tools run with full
        // host access, so there is no sandbox to declare).
        agent_name: '/root',
        thread_source: 'user',
        sandbox: 'none',
        sandbox_mode: 'danger-full-access',
        auto_review_enabled: false,
        turn_started_at_unix_ms: startedAt,
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

// Handshake projection of the same identity: window id, the turn-metadata
// blob, the installation id, and the routing hint. The reference client sends
// all of them on every request, and a 2026-07-04 A/B measured the blob alone
// lifting prefix-cache hits.
export function _codexWsCompatibilityHeaders(context = {}) {
    const metadata = _codexMetadataBase(null, context);
    const headers = {};
    if (metadata['x-codex-window-id']) headers['x-codex-window-id'] = metadata['x-codex-window-id'];
    if (metadata['x-codex-turn-metadata']) headers['x-codex-turn-metadata'] = metadata['x-codex-turn-metadata'];
    if (metadata['x-codex-installation-id']) headers['x-codex-installation-id'] = metadata['x-codex-installation-id'];
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
    const metadata = {
        ...base,
        ...(frame.client_metadata && typeof frame.client_metadata === 'object' ? frame.client_metadata : {}),
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
                entry.turnState = null;
                entry.turnStateTurnId = null;
            }
        }
        entry.currentTurnId = base.turn_id;
    }
    if (entry?.turnState) metadata['x-codex-turn-state'] = String(entry.turnState);
    return { ...frame, client_metadata: metadata };
}
