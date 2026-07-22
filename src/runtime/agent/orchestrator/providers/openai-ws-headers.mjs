// Codex WS handshake helpers: CF cookie jar, id parity, debug dump redaction. Extracted from openai-ws-pool.mjs.
/**
 * openai-ws-pool.mjs — WebSocket connection pool for the OpenAI OAuth provider.
 *
 * Extracted from openai-oauth-ws.mjs. Owns the socket pool singleton
 * (_wsPool), handshake/open/acquire/release lifecycle, idle-close timers and
 * the process-exit drain fence. openai-oauth-ws.mjs imports acquire/release/
 * _sendFrame and re-exports the drain hooks for legacy import paths.
 */
import WebSocket from 'ws';
import { errText } from '../../../shared/err-text.mjs';
import { createHash, randomBytes } from 'crypto';
import { performance } from 'node:perf_hooks';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexOriginator, codexUserAgent, codexVersionHeader } from './codex-client-meta.mjs';
import {
    PROVIDER_WS_ACQUIRE_TIMEOUT_MS,
    PROVIDER_WS_HANDSHAKE_TIMEOUT_MS,
    PROVIDER_WS_PING_ENABLED,
    PROVIDER_WS_PING_INTERVAL_MS,
    PROVIDER_WS_PONG_TIMEOUT_MS,
    PROVIDER_WS_LIVENESS_STALE_MS,
    resolveTimeoutMs,
} from '../stall-policy.mjs';

// Human-readable transport label for handshake/acquire error messages. Shared
// with openai-oauth-ws.mjs (stream-side errors use the same labels).
import { _wsPool, _sendFrame } from './openai-ws-pool.mjs';

export const _cfCookieJar = new Map(); // accountKey -> { name -> value }
export const _CF_COOKIE_ALLOWLIST = new Set(['__cf_bm', '_cfuvid']);

export function _envOn(name) {
    const v = String(process.env[name] || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(v);
}

// --- Opt-in Codex fingerprint/id parity knobs ------------------------------
// All default OFF; unset envs leave the winning combo
// (MIXDOG_OAI_CODEX_WIRE_PARITY=1 + ws-delta + underscore session_id) exactly
// as-is. These add EXTRA parity dimensions for backend fingerprint probes.

// codex sends dashed RFC-4122 UUIDs as session-id/thread-id (client.rs:1033-
// 1057); we key those dashed handshake headers off the underscore cacheKey by
// default. Opt in with MIXDOG_OAI_CODEX_WIRE_PARITY_UUID_IDS to reshape ONLY
// the dashed pair (session-id/thread-id/x-client-request-id) into codex's UUID
// format. The value is derived deterministically from the id so it stays
// stable per cache key (prefix-cache continuity preserved), and the underscore
// `session_id` header (the backend prefix-dedupe key) is left untouched.
export function _codexUuidIdParity() {
    const v = String(process.env.MIXDOG_OAI_CODEX_WIRE_PARITY_UUID_IDS || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'uuid', 'dashed'].includes(v);
}

export function _codexDashedId(value) {
    const h = createHash('sha256').update(String(value)).digest();
    const b = Buffer.from(h.subarray(0, 16));
    b[6] = (b[6] & 0x0f) | 0x50; // version 5 nibble
    b[8] = (b[8] & 0x3f) | 0x80; // RFC-4122 variant
    const hex = b.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Opt-in turn-state gate experiment bundle (MIXDOG_OAI_CODEX_TURN_STATE_GATE).
// The debugger's working hypothesis for what gates x-codex-turn-state issuance
// is a specific wire shape: Codex-shaped UUIDv7 session/thread ids + dashed-only
// handshake headers (drop the underscore session_id) + NO duplicated
// x-client-request-id + a parent-thread header (added in openai-oauth-ws.mjs).
// This env ties those dimensions together as ONE experiment so operators can
// A/B the whole gate shape without hand-composing four flags. Default OFF; it
// leaves MIXDOG_OAI_CODEX_WIRE_PARITY_UUID_IDS / _SESSION_ID and every existing
// flag intact and only reshapes the wire when explicitly enabled.
export function _codexTurnStateGate() {
    const v = String(process.env.MIXDOG_OAI_CODEX_TURN_STATE_GATE || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(v);
}

// Same derivation as _codexDashedId but stamps the version-7 nibble so the
// dashed pair reads as a Codex-shaped UUIDv7. Deterministic per id (prefix
// cache continuity preserved); only used under the turn-state gate bundle.
export function _codexDashedIdV7(value) {
    const h = createHash('sha256').update(String(value)).digest();
    const b = Buffer.from(h.subarray(0, 16));
    b[6] = (b[6] & 0x0f) | 0x70; // version 7 nibble
    b[8] = (b[8] & 0x3f) | 0x80; // RFC-4122 variant
    const hex = b.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// codex advertises enabled beta features on the WS handshake; the backend
// plausibly gates x-codex-turn-state issuance on that list (see the
// x-codex-beta-features comment below). MIXDOG_CODEX_BETA_FEATURES replaces the
// whole list; MIXDOG_OAI_CODEX_TURN_STATE_FEATURES is a safe ADD-ONLY opt-in
// that appends turn-state-gating feature token(s) (comma-separated, de-duped)
// without dropping the default `remote_compaction_v2`. Unset = default list.
export function _codexBetaFeatures() {
    const base = process.env.MIXDOG_CODEX_BETA_FEATURES || 'remote_compaction_v2';
    const extra = String(process.env.MIXDOG_OAI_CODEX_TURN_STATE_FEATURES || '').trim();
    if (!extra) return base;
    const seen = new Set();
    const out = [];
    for (const tok of `${base},${extra}`.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (seen.has(tok)) continue;
        seen.add(tok);
        out.push(tok);
    }
    return out.join(',');
}

// --- Opt-in raw WS capture for byte-diff against codex-rs -------------------
// Enabled ONLY when MIXDOG_OAI_WS_DUMP_DIR names a directory. Persists the
// (redacted) handshake header metadata and the exact serialized
// response.create frame bytes so our wire format can be byte-diffed against
// codex. Secrets (Authorization / Cookie / account-id / routing tokens) are
// hashed, never written in clear. When the env is unset both helpers are
// no-ops, so there is no default behavior change.
export const _WS_DUMP_SECRET_RE = /^(authorization|proxy-authorization|cookie|set-cookie|chatgpt-account-id|x-codex-turn-state|session_id|session-id|thread-id|x-codex-parent-thread-id|x-client-request-id|x-session-affinity)$/i;

export function _wsDumpDir() {
    const dir = String(process.env.MIXDOG_OAI_WS_DUMP_DIR || '').trim();
    return dir || null;
}

export function _redactHeaderValue(key, value) {
    const v = String(value ?? '');
    if (_WS_DUMP_SECRET_RE.test(String(key))) {
        if (!v) return '';
        return `<redacted:sha256:${createHash('sha256').update(v).digest('hex').slice(0, 12)}:len${v.length}>`;
    }
    return v;
}

export function _redactDumpUrl(url) {
    try {
        const parsed = new URL(String(url));
        for (const [key, value] of parsed.searchParams.entries()) {
            if (_WS_DUMP_SECRET_RE.test(String(key))) {
                parsed.searchParams.set(key, _redactHeaderValue(key, value));
            }
        }
        return parsed.toString();
    } catch {
        return String(url || '');
    }
}

export function _dumpHandshakeHeaders(url, headers) {
    const dir = _wsDumpDir();
    if (!dir) return;
    try {
        mkdirSync(dir, { recursive: true });
        const redacted = {};
        for (const [k, v] of Object.entries(headers || {})) redacted[k] = _redactHeaderValue(k, v);
        const rec = {
            ts: new Date().toISOString(),
            kind: 'ws_handshake',
            url: _redactDumpUrl(url),
            // Header order matters for the codex byte-diff; keep it explicit.
            headerOrder: Object.keys(headers || {}),
            headers: redacted,
        };
        const stamp = `${Date.now()}-${randomBytes(4).toString('hex')}`;
        writeFileSync(join(dir, `handshake-${stamp}.json`), JSON.stringify(rec, null, 2));
    } catch {}
}

export function _dumpFrame(payload) {
    const dir = _wsDumpDir();
    if (!dir) return;
    try {
        mkdirSync(dir, { recursive: true });
        const stamp = `${Date.now()}-${randomBytes(4).toString('hex')}`;
        // Persist the serialized response.create bytes for codex byte-diff,
        // but never dump x-codex-turn-state in clear. That token is a
        // per-turn credential-like routing secret; header dumps already hash
        // it, so frame dumps must do the same when client_metadata carries it.
        let out = payload;
        try {
            const frame = JSON.parse(String(payload));
            const meta = frame?.client_metadata;
            if (meta && typeof meta === 'object' && typeof meta['x-codex-turn-state'] === 'string') {
                meta['x-codex-turn-state'] = _redactHeaderValue('x-codex-turn-state', meta['x-codex-turn-state']);
                out = JSON.stringify(frame);
            }
        } catch {}
        writeFileSync(join(dir, `frame-${stamp}.json`), out);
    } catch {}
}

export function _cfCookieAccountKey(auth) {
    return String(auth?.account_id || auth?.apiKey || 'default');
}

export function _cfCookieHeader(auth) {
    if (!_envOn('MIXDOG_OAI_CF_COOKIES')) return null;
    const jar = _cfCookieJar.get(_cfCookieAccountKey(auth));
    if (!jar || !jar.size) return null;
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

export function _cfCookieCapture(auth, setCookieHeaders) {
    if (!_envOn('MIXDOG_OAI_CF_COOKIES')) return;
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : (setCookieHeaders ? [setCookieHeaders] : []);
    if (!list.length) return;
    const key = _cfCookieAccountKey(auth);
    let jar = _cfCookieJar.get(key);
    if (!jar) { jar = new Map(); _cfCookieJar.set(key, jar); }
    for (const raw of list) {
        const pair = String(raw || '').split(';', 1)[0];
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        if (_CF_COOKIE_ALLOWLIST.has(name)) jar.set(name, pair.slice(eq + 1).trim());
    }
}
