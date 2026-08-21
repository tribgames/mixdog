// manager/session-id.mjs
// Monotonic session-id minting extracted from manager.mjs. The counter is a
// module-level singleton shared by createSession (spawn) and
// clearSessionMessages (clear-fork), matching the original single `nextId`.
import { randomBytes } from 'crypto';
let nextId = Date.now();
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let lastUuidV7Ms = -1;
let uuidV7Sequence = 0;

export function mintSessionId() {
    return `sess_${process.pid}_${nextId++}_${Date.now()}_${randomBytes(16).toString('hex')}`;
}

export function isUuidV7(value) {
    return UUID_V7_RE.test(String(value || '').trim());
}

export function mintUuidV7(nowMs = Date.now()) {
    const parsedNow = Number(nowMs);
    const timestampMs = Math.max(
        0,
        Math.min(
            0xffffffffffff,
            Math.floor(Number.isFinite(parsedNow) ? parsedNow : Date.now()),
        ),
    );
    if (timestampMs === lastUuidV7Ms) {
        uuidV7Sequence = (uuidV7Sequence + 1) & 0x0fff;
    } else {
        lastUuidV7Ms = timestampMs;
        uuidV7Sequence = randomBytes(2).readUInt16BE(0) & 0x0fff;
    }
    const bytes = randomBytes(16);
    const timestamp = BigInt(timestampMs);
    bytes[0] = Number((timestamp >> 40n) & 0xffn);
    bytes[1] = Number((timestamp >> 32n) & 0xffn);
    bytes[2] = Number((timestamp >> 24n) & 0xffn);
    bytes[3] = Number((timestamp >> 16n) & 0xffn);
    bytes[4] = Number((timestamp >> 8n) & 0xffn);
    bytes[5] = Number(timestamp & 0xffn);
    bytes[6] = 0x70 | ((uuidV7Sequence >> 8) & 0x0f);
    bytes[7] = uuidV7Sequence & 0xff;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Send-opts projection of a session's Codex wire identity.
 *
 * Every request belonging to one session — live turns and compaction summaries
 * alike — presents the SAME session/thread id, because the backend derives its
 * prompt-cache slot from that id. Only `turn_id` and `request_kind` change per
 * request. Splitting compaction onto its own identity would hand the same
 * session two cache slots and cold-start one of them on every compaction.
 *
 * Returns null for providers without a Codex wire identity, so callers can
 * spread the result unconditionally.
 */
export function codexWireSendOpts(session, { requestKind = 'turn', turnId = null, startedAtMs = null } = {}) {
    const wireSessionId = ensureCodexWireSessionId(session);
    if (!wireSessionId) return null;
    const parsedStartedAt = Number(startedAtMs);
    const startedAt = Number.isFinite(parsedStartedAt) && parsedStartedAt > 0
        ? Math.floor(parsedStartedAt)
        : Date.now();
    return {
        codexSessionId: wireSessionId,
        codexThreadId: wireSessionId,
        turnId: turnId || mintUuidV7(startedAt),
        windowId: `${wireSessionId}:0`,
        turnStartedAtUnixMs: startedAt,
        requestKind,
    };
}

export function ensureCodexWireSessionId(session) {
    if (!session || session.provider !== 'openai-oauth') return null;
    const current = String(session.codexWireSessionId || '').trim().toLowerCase();
    if (isUuidV7(current)) {
        session.codexWireSessionId = current;
        return current;
    }
    const minted = mintUuidV7();
    session.codexWireSessionId = minted;
    return minted;
}
