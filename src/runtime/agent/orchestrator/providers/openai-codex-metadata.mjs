// Codex client-metadata for the openai-oauth WebSocket transport: the
// installation/session/thread/turn identity block that rides every frame, its
// handshake-header projection, and the per-turn x-codex-turn-state guard.
// Extracted from openai-oauth-ws.mjs, which now owns transport flow only.
import { createHash } from 'crypto';

function _cleanMetaString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function _hashText(value, chars = 24) {
    return createHash('sha256').update(String(value || '')).digest('hex').slice(0, chars);
}

// Session ids embed their creation stamp; fall back to now for foreign shapes.
function _sessionStartedAtUnixMs(sessionId) {
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

// The identity block codex rebuilds per request (responses_metadata.rs
// client_metadata()): never cached on the pooled socket, or a later turn would
// replay the first turn's identity.
function _codexMetadataBase(entry, { poolKey, cacheKey, sendOpts, handshake = false } = {}) {
    const sessionId = _cleanMetaString(sendOpts?.codexSessionId || sendOpts?.session?.codexSessionId || poolKey || cacheKey)
        || 'mixdog-session';
    const threadId = _cleanMetaString(sendOpts?.threadId || sendOpts?.codexThreadId || sendOpts?.session?.threadId || cacheKey || sessionId)
        || sessionId;
    const installationId = _codexInstallationId(sendOpts);
    const startedAt = Number.isFinite(Number(sendOpts?.turnStartedAtUnixMs))
        ? Math.floor(Number(sendOpts.turnStartedAtUnixMs))
        : _sessionStartedAtUnixMs(sessionId);
    const requestKind = _codexRequestKind(sendOpts, sessionId);
    const wireParity = process.env.MIXDOG_OAI_CODEX_WIRE_PARITY === '1';
    // codex opens the WS with a prewarm (empty turn_id) BEFORE the real turn
    // (client.rs). Under wire parity the handshake IS that prewarm, so its
    // turn_id empties and its request_kind becomes 'prewarm' instead of
    // presenting the handshake as a live turn. Parity off is unchanged.
    const isPrewarm = requestKind === 'prewarm' || handshake === true;
    const explicitTurnId = _cleanMetaString(sendOpts?.turnId || sendOpts?.codexTurnId || sendOpts?.session?.turnId);
    const explicitWindowId = _cleanMetaString(sendOpts?.windowId || sendOpts?.codexWindowId || sendOpts?.session?.windowId);
    const turnId = wireParity && isPrewarm ? '' : (explicitTurnId || sessionId);
    const effectiveRequestKind = wireParity && isPrewarm ? 'prewarm' : requestKind;
    const windowId = explicitWindowId || `${threadId}:${wireParity ? 0 : 1}`;
    const turnMetadata = {
        installation_id: installationId,
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
        window_id: windowId,
        request_kind: effectiveRequestKind,
        // Richer codex turn-metadata (responses_metadata.rs:264-280). A/B
        // 2026-07-04 showed no effect, so it stays behind a knob for future
        // probes; wire parity implies it.
        ...((process.env.MIXDOG_OAI_TURN_METADATA_RICH === '1' || wireParity) ? {
            thread_source: 'user',
            sandbox: 'read-only',
        } : {}),
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

// Handshake projection of the same identity. codex attaches these on every
// request (client.rs:582-584, responses_metadata.rs:227-252); A/B 2026-07-04
// showed the turn-metadata blob alone lifts prefix-cache hits, so it is ON by
// default. MIXDOG_OAI_TURN_METADATA overrides:
//   unset|1|turn-metadata : window-id + turn-metadata + installation-id
//   parent                : + x-codex-parent-thread-id
//   window                : window-id only (drop the blob)
//   0|off|false|no        : pre-2026-07-04 baseline (drop the blob)
export function _codexWsCompatibilityHeaders(context = {}) {
    const metadata = _codexMetadataBase(null, context);
    const headers = {};
    if (metadata['x-codex-window-id']) headers['x-codex-window-id'] = metadata['x-codex-window-id'];
    if (metadata['x-codex-turn-metadata']) headers['x-codex-turn-metadata'] = metadata['x-codex-turn-metadata'];
    if (metadata['x-codex-installation-id']) headers['x-codex-installation-id'] = metadata['x-codex-installation-id'];
    const parentThreadId = () => _cleanMetaString(context?.sendOpts?.parentThreadId
        || context?.sendOpts?.codexParentThreadId
        || metadata.thread_id);
    const probe = String(process.env.MIXDOG_OAI_TURN_METADATA || '').trim().toLowerCase();
    if (probe === '0' || probe === 'off' || probe === 'false' || probe === 'no' || probe === 'window') {
        delete headers['x-codex-turn-metadata'];
    } else if (probe === 'parent') {
        const parent = parentThreadId();
        if (parent) headers['x-codex-parent-thread-id'] = parent;
    }
    // Turn-state gate probe: attach the parent header independent of the knob
    // above (hypothesis: x-codex-turn-state issuance wants it). Default OFF.
    const gate = String(process.env.MIXDOG_OAI_CODEX_TURN_STATE_GATE || '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(gate) && !headers['x-codex-parent-thread-id']) {
        const parent = parentThreadId();
        if (parent) headers['x-codex-parent-thread-id'] = parent;
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
        // codex scopes x-codex-turn-state to ONE turn (client.rs:263-279) while
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
