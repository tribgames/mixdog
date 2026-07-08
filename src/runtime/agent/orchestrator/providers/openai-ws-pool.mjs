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
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexOriginator, codexUserAgent, codexVersionHeader } from './codex-client-meta.mjs';
import {
    PROVIDER_WS_ACQUIRE_TIMEOUT_MS,
    PROVIDER_WS_HANDSHAKE_TIMEOUT_MS,
    resolveTimeoutMs,
} from '../stall-policy.mjs';

// Human-readable transport label for handshake/acquire error messages. Shared
// with openai-oauth-ws.mjs (stream-side errors use the same labels).
export function _wsErrLabel(p) {
    if (p === 'xai') return 'xAI WS';
    if (p === 'openai-direct' || p === 'openai') return 'OpenAI WS';
    return 'OpenAI OAuth WS';
}

const CODEX_WS_URL = 'wss://chatgpt.com/backend-api/codex/responses';
const OPENAI_WS_URL = 'wss://api.openai.com/v1/responses';
const XAI_WS_URL = 'wss://api.x.ai/v1/responses';
export const WS_IDLE_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_WS_IDLE_MS',
    20 * 60_000,
    { minMs: 60_000, maxMs: 60 * 60_000 },
);
const WS_HANDSHAKE_TIMEOUT_MS = PROVIDER_WS_HANDSHAKE_TIMEOUT_MS;
const WS_ACQUIRE_TIMEOUT_MS = PROVIDER_WS_ACQUIRE_TIMEOUT_MS;

// WS socket pool buckets are keyed by `poolKey` (the per-call sessionId)
// to isolate parallel agent invocations — each gets its own socket so
// a second caller cannot grab a sibling's mid-turn entry (openai-oauth would
// otherwise reject the new response.create with "No tool output found
// for function call ..."). The handshake `session_id` header/URL
// uses `cacheKey` — for OpenAI OAuth this mirrors Codex's thread-scoped
// prompt_cache_key by default. The backend dedupes cache by handshake
// session_id, not by body.prompt_cache_key alone (measured 2026-04-19 after the
// v0.6.151 regression).
const MAX_POOLED_SOCKETS_PER_KEY = 8;

// poolKey -> Entry[]
// Entry: { socket, busy, idleTimer, lastResponseId, lastRequestSansInput,
//          lastRequestInput, lastResponseItems, lastInputLen, turnState,
//          closing, ephemeral }
const _wsPool = new Map();

// --- Cache-route probe state (2026-07-04 hunt) -----------------------------
// CF cookie stickiness (codex chatgpt_cloudflare_cookies.rs:22-55 persists
// __cf_bm/_cfuvid across HTTP clients; our WS handshakes never echo them, so
// Cloudflare may re-shard every fresh socket). Jar is per-process, keyed by
// auth account. Env knobs (A/B):
//   MIXDOG_OAI_CF_COOKIES=1        capture Set-Cookie from the 101 upgrade and
//                                  send Cookie on subsequent handshakes
//   MIXDOG_OAI_SESSION_AFFINITY=1  send x-session-affinity: <cacheKey>
//                                  (opencode request.ts:187, ws-pool.ts:66)
//   MIXDOG_OAI_WS_URL_SESSION=0    drop the ?session_id= URL query (codex/pi/
//                                  opencode all use the bare WS URL)
const _cfCookieJar = new Map(); // accountKey -> { name -> value }
const _CF_COOKIE_ALLOWLIST = new Set(['__cf_bm', '_cfuvid']);

function _envOn(name) {
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
function _codexUuidIdParity() {
    const v = String(process.env.MIXDOG_OAI_CODEX_WIRE_PARITY_UUID_IDS || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'uuid', 'dashed'].includes(v);
}

function _codexDashedId(value) {
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
function _codexTurnStateGate() {
    const v = String(process.env.MIXDOG_OAI_CODEX_TURN_STATE_GATE || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(v);
}

// Same derivation as _codexDashedId but stamps the version-7 nibble so the
// dashed pair reads as a Codex-shaped UUIDv7. Deterministic per id (prefix
// cache continuity preserved); only used under the turn-state gate bundle.
function _codexDashedIdV7(value) {
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
function _codexBetaFeatures() {
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
const _WS_DUMP_SECRET_RE = /^(authorization|proxy-authorization|cookie|set-cookie|chatgpt-account-id|x-codex-turn-state|session_id|session-id|thread-id|x-codex-parent-thread-id|x-client-request-id|x-session-affinity)$/i;

function _wsDumpDir() {
    const dir = String(process.env.MIXDOG_OAI_WS_DUMP_DIR || '').trim();
    return dir || null;
}

function _redactHeaderValue(key, value) {
    const v = String(value ?? '');
    if (_WS_DUMP_SECRET_RE.test(String(key))) {
        if (!v) return '';
        return `<redacted:sha256:${createHash('sha256').update(v).digest('hex').slice(0, 12)}:len${v.length}>`;
    }
    return v;
}

function _redactDumpUrl(url) {
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

function _dumpHandshakeHeaders(url, headers) {
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

function _dumpFrame(payload) {
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

function _cfCookieAccountKey(auth) {
    return String(auth?.account_id || auth?.apiKey || 'default');
}

function _cfCookieHeader(auth) {
    if (!_envOn('MIXDOG_OAI_CF_COOKIES')) return null;
    const jar = _cfCookieJar.get(_cfCookieAccountKey(auth));
    if (!jar || !jar.size) return null;
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function _cfCookieCapture(auth, setCookieHeaders) {
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

function _getPoolArr(poolKey) {
    if (!poolKey) return null;
    let arr = _wsPool.get(poolKey);
    if (!arr) {
        arr = [];
        _wsPool.set(poolKey, arr);
    }
    return arr;
}

function _removeFromPool(poolKey, entry) {
    if (!poolKey) return;
    const arr = _wsPool.get(poolKey);
    if (!arr) return;
    const idx = arr.indexOf(entry);
    if (idx >= 0) arr.splice(idx, 1);
    if (arr.length === 0) _wsPool.delete(poolKey);
}

function _scheduleIdleClose(poolKey, entry) {
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
        if (entry.busy) return;
        try { entry.socket.close(1000, 'idle_timeout'); } catch {}
        _removeFromPool(poolKey, entry);
    }, WS_IDLE_MS);
    try { entry.idleTimer.unref?.(); } catch {}
}

function _clearIdle(entry) {
    if (entry?.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
    }
}

function _isOpen(entry) {
    return entry?.socket?.readyState === WebSocket.OPEN;
}

// Awaited frame send. Asserts the socket is OPEN and resolves only after
// the underlying transport reports the buffered write succeeded (or fails)
// via the WebSocket send callback. Raw `socket.send(JSON.stringify(...))`
// is fire-and-forget — a wedged or half-closed socket silently queues the
// payload and the caller assumes it landed, then later times out waiting
// for a server event that will never arrive. Tag any failure with
// `wsSendFailed=true` so _classifyMidstreamError routes the next attempt
// through a fresh socket.
export function _sendFrame(entry, frame) {
    return new Promise((resolve, reject) => {
        const socket = entry?.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            const err = new Error(`WS send: socket not OPEN (readyState=${socket?.readyState ?? 'n/a'})`);
            err.wsSendFailed = true;
            reject(err);
            return;
        }
        let payload;
        try { payload = JSON.stringify(frame); }
        catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            err.wsSendFailed = true;
            reject(err);
            return;
        }
        _dumpFrame(payload);
        try {
            // Do NOT await the send callback: on a wedged-but-OPEN socket the
            // ws write callback may never fire, which would hang this Promise
            // before _streamResponse arms its first-byte watchdog. Fire and
            // resolve immediately; transport failures surface via the socket
            // 'error'/'close' handlers and the first-byte watchdog.
            socket.send(payload, () => {});
            resolve();
        } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            err.wsSendFailed = true;
            reject(err);
        }
    });
}

function _buildHandshakeHeaders({ auth, sessionToken, turnState, cacheKey: _cacheKey, codexHeaders }) {
    // xAI WS: do NOT pin x-grok-conv-id. Measured parallel runs show that
    // forcing a routing shard via that header alternates cold caches across
    // parallel workers; the automatic prompt-prefix cache holds up better
    // when each handshake is unpinned. Reference: vercel/ai xai provider.
    const headers = auth.type === 'xai'
        ? {
            'Authorization': `Bearer ${auth.apiKey}`,
        }
        : auth.type === 'openai-direct'
        ? {
            'Authorization': `Bearer ${auth.apiKey}`,
            'OpenAI-Beta': 'responses_websockets=2026-02-06',
        }
        : {
            'Authorization': `Bearer ${auth.access_token}`,
            'chatgpt-account-id': auth.account_id || '',
            'originator': codexOriginator(),
            'OpenAI-Beta': 'responses_websockets=2026-02-06',
            // codex-rs merges provider http_headers ("version") plus
            // default_headers (User-Agent) into the WS handshake
            // (client.rs:970-975, model-provider-info/src/lib.rs:339-343,
            // login default_client.rs:289-305). The backend fingerprints
            // clients on these; missing them can route us onto a different
            // (colder) cache-node class than codex.
            'User-Agent': codexUserAgent(),
            'version': codexVersionHeader(),
            // codex advertises enabled beta features on every request incl.
            // the WS handshake (client.rs:1038-1041 via build_responses_headers,
            // session/mod.rs:1006-1027). With a default config the list is
            // exactly "remote_compaction_v2" (features/src/lib.rs: the only
            // always-advertised Stable default-on feature). Servers gate
            // behavior (plausibly incl. x-codex-turn-state issuance) on it.
            'x-codex-beta-features': _codexBetaFeatures(),
        };
    const isOpenAiOauth = auth.type !== 'xai' && auth.type !== 'openai-direct';
    // codex-rs sends only the dashed session-id/thread-id pair
    // (client.rs:1033-1057), but OUR backend measurements disagree with pure
    // codex parity here: 2026-04-19 probes showed the OAuth backend dedupes
    // its in-memory prefix state by the underscore session_id handshake
    // header, and the only 0.0%-miss full-frame rounds (R7/R8, R15 regressed
    // to 13% after this header was dropped) all had it present. Send both.
    // The underscore session_id is the backend prefix-dedupe key (2026-04-19
    // probes; R15 regressed to 13% miss when it was dropped). Codex parity
    // (client.rs:1033-1057) sends ONLY the dashed pair, but dropping this
    // header is a KNOWN cache-unsafe change — so the general parity flag no
    // longer silently drops it. Keep it unless an operator EXPLICITLY opts
    // into the codex-exact dashed-only wire via
    // MIXDOG_OAI_CODEX_WIRE_PARITY_SESSION_ID=dashed.
    // The gate bundle implies the dashed-only wire (drop the underscore
    // session_id) on top of the standalone opt-in.
    const gate = _codexTurnStateGate();
    const dropUnderscoreSessionId = process.env.MIXDOG_OAI_CODEX_WIRE_PARITY_SESSION_ID === 'dashed' || gate;
    if (sessionToken && !dropUnderscoreSessionId) {
        headers['session_id'] = String(sessionToken);
    }
    if (isOpenAiOauth && (sessionToken || _cacheKey)) {
        // Gate bundle forces Codex-shaped UUIDv7 ids; the standalone parity flag
        // keeps its v5-derived shape.
        const uuidIds = _codexUuidIdParity() || gate;
        const shapeId = gate ? _codexDashedIdV7 : _codexDashedId;
        // Underscore `session_id` above is left as-is (backend prefix-dedupe
        // key); only the dashed codex pair is reshaped under the opt-in.
        const threadId = uuidIds ? shapeId(String(_cacheKey || sessionToken)) : String(_cacheKey || sessionToken);
        const sessionId = uuidIds ? shapeId(String(sessionToken || _cacheKey)) : String(sessionToken || _cacheKey);
        headers['session-id'] = sessionId;
        headers['thread-id'] = threadId;
        // Default/parity wire duplicates the dashed thread-id here. The gate
        // hypothesis is that a duplicated x-client-request-id suppresses
        // turn-state issuance, so omit it entirely under the bundle.
        if (!gate) headers['x-client-request-id'] = threadId;
        if (codexHeaders && typeof codexHeaders === 'object') {
            for (const [key, value] of Object.entries(codexHeaders)) {
                if (typeof key === 'string' && typeof value === 'string' && value) {
                    headers[key] = value;
                }
            }
        }
        // Gate-only: the wire thread-id above is reshaped to a Codex UUIDv7
        // (shapeId), but _codexWsCompatibilityHeaders derives
        // x-codex-parent-thread-id from the RAW dashed thread_id, so the merged
        // codexHeaders carry a parent-thread id that no longer matches the
        // thread-id on the same handshake. Realign it to the reshaped thread-id
        // (single source of truth: the pool owns the wire id shape) so the
        // gate handshake is internally consistent. Non-gate / standalone
        // parity paths keep codex's raw value untouched.
        if (gate && headers['x-codex-parent-thread-id']) {
            headers['x-codex-parent-thread-id'] = threadId;
        }
    } else {
        // xAI/direct keep a per-request value so their server-side traces stay
        // distinguishable across reconnects.
        headers['x-client-request-id'] = randomBytes(16).toString('hex');
    }
    if (turnState) headers['x-codex-turn-state'] = turnState;
    // Probe knobs (cache-route hunt 2026-07-04): see jar block at top of file.
    if (isOpenAiOauth) {
        const jar = _cfCookieHeader(auth);
        if (jar) headers['Cookie'] = jar;
        if (_envOn('MIXDOG_OAI_SESSION_AFFINITY') && (_cacheKey || sessionToken)) {
            headers['x-session-affinity'] = String(_cacheKey || sessionToken);
        }
    }
    return headers;
}

// handshake session_id is the conversation slot openai-oauth uses for in-memory
// prefix state. OpenAI OAuth uses the Codex-style thread cache key by default;
// xAI leaves routing unpinned.
function _mintSessionToken(cacheKey, auth) {
    // xAI's public WebSocket endpoint uses the open connection plus
    // response ids for continuation; unlike openai-oauth, it does not need the
    // OAuth-specific session_id handshake shard.
    if (auth?.type === 'xai') return null;
    return cacheKey || 'mixdog-default';
}

function _openSocket({ auth, sessionToken, turnState, externalSignal, cacheKey, codexHeaders }) {
    const headers = _buildHandshakeHeaders({ auth, sessionToken, turnState, cacheKey, codexHeaders });
    const baseUrl = auth.type === 'xai'
        ? XAI_WS_URL
        : auth.type === 'openai-direct'
            ? OPENAI_WS_URL
            : CODEX_WS_URL;
    const _wsOpenStart = Date.now();
    if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(`[agent-trace] ws-open-start url=${baseUrl} tokenHash=${createHash('sha256').update(String(sessionToken)).digest('hex').slice(0, 8)} ts=${_wsOpenStart}\n`);
    }
    // Bare WS URL by default (codex/pi/opencode parity). Interleaved A/B
    // (2026-07-04, ivA/ivB, 24 sessions each, alternating rounds to cancel
    // server-time noise): dropping the ?session_id= query improved it1
    // warmup-prefix hits 15/24 -> 22/24 and it2 full hits 11 -> 15 (miss
    // 5 -> 4). The query string seeds CF/backend shard routing away from
    // the header-affine cache node; session identity still rides on the
    // session_id/session-id handshake headers. Re-enable the legacy query
    // form with MIXDOG_OAI_WS_URL_SESSION=1.
    const url = baseUrl + (sessionToken && process.env.MIXDOG_OAI_WS_URL_SESSION === '1'
        ? `?session_id=${encodeURIComponent(String(sessionToken))}`
        : '');
    _dumpHandshakeHeaders(url, headers);
    return new Promise((resolve, reject) => {
        let settled = false;
        let abortListener = null;
        let acquireTimer = null;
        const settle = (ok, val) => {
            if (settled) return;
            settled = true;
            if (acquireTimer) {
                clearTimeout(acquireTimer);
                acquireTimer = null;
            }
            if (abortListener && externalSignal) {
                try { externalSignal.removeEventListener('abort', abortListener); } catch {}
            }
            (ok ? resolve : reject)(val);
        };
        const socket = new WebSocket(url, { headers, handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS });
        acquireTimer = setTimeout(() => {
            if (settled) return;
            if (process.env.MIXDOG_DEBUG_AGENT) {
                process.stderr.write(`[agent-trace] ws-open-fail kind=acquire_timeout timeoutMs=${WS_ACQUIRE_TIMEOUT_MS} elapsed=${Date.now() - _wsOpenStart}ms\n`);
            }
            try { socket.terminate(); } catch {}
            settle(false, Object.assign(
                new Error(`${_wsErrLabel(auth?.type === 'xai' ? 'xai' : auth?.type === 'openai-direct' ? 'openai-direct' : 'openai-oauth')} acquire timed out before open (${WS_ACQUIRE_TIMEOUT_MS}ms)`),
                { code: 'EWSACQUIRETIMEOUT', acquireTimeoutMs: WS_ACQUIRE_TIMEOUT_MS },
            ));
        }, WS_ACQUIRE_TIMEOUT_MS);
        try { acquireTimer.unref?.(); } catch {}
        const capturedHeaders = { turnState: null };
        socket.once('upgrade', (res) => {
            try {
                const ts = res?.headers?.['x-codex-turn-state'];
                if (typeof ts === 'string' && ts.length) capturedHeaders.turnState = ts;
                _cfCookieCapture(auth, res?.headers?.['set-cookie']);
                // Probe: dump the full 101-upgrade response header set so we can
                // see what the server actually issues (turn-state investigation).
                if (process.env.MIXDOG_WS_UPGRADE_HEADER_PROBE) {
                    const all = res?.headers && typeof res.headers === 'object'
                        ? Object.entries(res.headers).map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`).join(' | ')
                        : '(none)';
                    const line = `[ws-upgrade-probe] ts=${new Date().toISOString()} status=${res?.statusCode} headers={ ${all} }\n`;
                    process.stderr.write(line);
                    // Bench runners swallow child stderr on success; persist to a
                    // file so the probe survives (value of the env var = path, or
                    // default under tmp).
                    try {
                        const probePath = process.env.MIXDOG_WS_UPGRADE_HEADER_PROBE !== '1'
                            ? process.env.MIXDOG_WS_UPGRADE_HEADER_PROBE
                            : `${process.env.TEMP || process.env.TMPDIR || '.'}/mixdog-ws-upgrade-probe.log`;
                        appendFileSync(probePath, line);
                    } catch {}
                }
            } catch {}
        });
        socket.once('open', () => {
            if (process.env.MIXDOG_DEBUG_AGENT) {
                process.stderr.write(`[agent-trace] ws-open-ok elapsed=${Date.now() - _wsOpenStart}ms\n`);
            }
            settle(true, { socket, turnState: capturedHeaders.turnState });
        });
        socket.once('error', (err) => {
            if (process.env.MIXDOG_DEBUG_AGENT) {
                process.stderr.write(`[agent-trace] ws-open-fail kind=error msg=${String(err?.message || err).slice(0, 120)} elapsed=${Date.now() - _wsOpenStart}ms\n`);
            }
            try { socket.terminate(); } catch {}
            settle(false, err instanceof Error ? err : Object.assign(new Error(errText(err) || 'openai-oauth WS error'), { wsErrorEvent: true, original: err }));
        });
        socket.once('close', (code, reason) => {
            // Half-open handshake: the peer closed before 'open'/'error' fired
            // (TCP RST / TLS edge). Without this the connect Promise never
            // settles and only the 600s outer watchdog can break the stall
            // (observed stage=requesting 601s hang). Open-path closes are
            // no-ops here because settle() has already flipped `settled`.
            if (settled) return;
            try { socket.terminate(); } catch {}
            settle(false, Object.assign(
                new Error(`${_wsErrLabel(auth?.type === 'xai' ? 'xai' : auth?.type === 'openai-direct' ? 'openai-direct' : 'openai-oauth')} handshake closed before open (code=${code})`),
                { wsCloseCode: code, wsCloseReason: (reason && reason.toString) ? reason.toString('utf-8') : '' }));
        });
        socket.once('unexpected-response', (_req, res) => {
            if (settled) return;
            const status = res?.statusCode || 0;
            let body = '';
            res.on('data', c => { if (body.length < 2048) body += c.toString('utf-8'); });
            res.on('end', () => {
                if (process.env.MIXDOG_DEBUG_AGENT) {
                    process.stderr.write(`[agent-trace] ws-open-fail kind=http status=${status} body=${body.slice(0, 120)} elapsed=${Date.now() - _wsOpenStart}ms\n`);
                }
                try { socket.terminate(); } catch {}
                settle(false, Object.assign(new Error(`${_wsErrLabel(auth?.type === 'xai' ? 'xai' : auth?.type === 'openai-direct' ? 'openai-direct' : 'openai-oauth')} handshake ${status}: ${body.slice(0, 200)}`), { httpStatus: status, httpBody: body }));
            });
        });
        if (externalSignal) {
            const onAbort = () => {
                try { socket.terminate(); } catch {}
                const reason = externalSignal.reason;
                settle(false, reason instanceof Error ? reason : new Error(`${_wsErrLabel(auth?.type === 'xai' ? 'xai' : auth?.type === 'openai-direct' ? 'openai-direct' : 'openai-oauth')} handshake aborted`));
            };
            if (externalSignal.aborted) { onAbort(); return; }
            abortListener = onAbort;
            externalSignal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

export async function acquireWebSocket({ auth, poolKey, cacheKey, codexHeaders, forceFresh, externalSignal }) {
    const _acqStart = Date.now();
    if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(`[agent-trace] acquire-start poolKey=${poolKey} cacheKey=${cacheKey} forceFresh=${forceFresh} externalAborted=${!!externalSignal?.aborted} ts=${_acqStart}\n`);
    }
    if (externalSignal?.aborted) {
        const reason = externalSignal.reason;
        throw reason instanceof Error ? reason : new Error('OpenAI OAuth WS acquire aborted');
    }
    if (poolKey && !forceFresh) {
        const arr = _wsPool.get(poolKey) || [];
        // Prune dead entries first.
        for (let i = arr.length - 1; i >= 0; i--) {
            if (!_isOpen(arr[i]) || arr[i].closing) {
                _clearIdle(arr[i]);
                arr.splice(i, 1);
            }
        }
        if (arr.length === 0) _wsPool.delete(poolKey);
        // Reuse any idle open entry (cache-warm path).
        const idle = arr.find(e => !e.busy);
        if (idle) {
            _clearIdle(idle);
            idle.busy = true;
            // Defensive: pre-existing pooled entries created before the
            // prefix-hash field was introduced may not have it set. Normalize
            // to null so the first delta check reads a deterministic value
            // (and falls back to full-create instead of silently passing).
            if (idle.lastInputPrefixHash === undefined) idle.lastInputPrefixHash = null;
            if (idle.lastRequestInput === undefined) idle.lastRequestInput = null;
            if (idle.lastResponseItems === undefined) idle.lastResponseItems = null;
            if (process.env.MIXDOG_DEBUG_AGENT) {
                process.stderr.write(`[agent-trace] acquire-reuse poolKey=${poolKey} openSockets=${arr.length} elapsed=${Date.now() - _acqStart}ms\n`);
            }
            return { entry: idle, reused: true };
        }
        // All entries busy and bucket at cap: fall through to ephemeral socket.
        if (arr.length >= MAX_POOLED_SOCKETS_PER_KEY) {
            if (process.env.MIXDOG_DEBUG_AGENT) {
                process.stderr.write(`[agent-trace] acquire-ephemeral cacheKey=${cacheKey} reason=cap elapsed=${Date.now() - _acqStart}ms\n`);
            }
            const ephSessionToken = _mintSessionToken(cacheKey, auth);
            const { socket, turnState } = await _openSocket({ auth, sessionToken: ephSessionToken, turnState: null, externalSignal, cacheKey, codexHeaders });
            // Drain-complete fence: same invariant as the normal acquire path —
            // if drain fired during the await, do NOT push an ephemeral entry
            // back into the pool.
            if (_drainComplete) {
                try { socket.close(1000, 'drain-complete'); } catch {}
                throw new Error('WS pool drained — process exiting');
            }
            const entry = {
                socket,
                busy: true,
                idleTimer: null,
                lastResponseId: null,
                lastRequestSansInput: null,
                lastRequestInput: null,
                lastResponseItems: null,
                lastInputLen: 0,
                lastInputPrefixHash: null,
                turnState: turnState || null,
                closing: false,
                ephemeral: true,
                sessionToken: ephSessionToken,
            };
            socket.on('close', () => { entry.closing = true; });
            return { entry, reused: false };
        }
    }
    // Parallel sockets must not inherit sibling turnState or the openai-oauth server
    // treats the new request as a continuation of another in-flight turn and
    // returns "No tool output found for function call …". turnState only
    // propagates within a single entry across its own iterations.
    const sessionToken = _mintSessionToken(cacheKey, auth);
    if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(`[agent-trace] acquire-new tokenHash=${createHash('sha256').update(String(sessionToken)).digest('hex').slice(0, 8)} elapsed=${Date.now() - _acqStart}ms\n`);
    }
    const { socket, turnState } = await _openSocket({ auth, sessionToken, turnState: null, externalSignal, cacheKey, codexHeaders });
    const entry = {
        socket,
        busy: true,
        idleTimer: null,
        lastResponseId: null,
        lastRequestSansInput: null,
        lastRequestInput: null,
        lastResponseItems: null,
        lastInputLen: 0,
        lastInputPrefixHash: null,
        turnState: turnState || null,
        closing: false,
        ephemeral: false,
        sessionToken,
    };
    if (poolKey && !forceFresh) _getPoolArr(poolKey).push(entry);
    socket.on('close', () => {
        entry.closing = true;
        _removeFromPool(poolKey, entry);
    });
    return { entry, reused: false };
}

export function releaseWebSocket({ entry, poolKey, keep }) {
    if (!entry) return;
    entry.busy = false;
    if (!keep || !_isOpen(entry) || !poolKey || entry.ephemeral) {
        try { entry.socket.close(1000, keep ? 'no_session' : 'release_no_keep'); } catch {}
        _removeFromPool(poolKey, entry);
        return;
    }
    _scheduleIdleClose(poolKey, entry);
}

// Drain-complete fence — set true once _closeAllPooledSockets runs so any
// in-flight acquire that resumes after drain throws instead of pushing a
// fresh socket into the cleared pool. Single-set, process-lifetime invariant.
let _drainComplete = false;

// Drain hook — self-registered exit drain.
// Force-closes pooled sockets and fences subsequent acquires.
// `drainOpenaiWsPool` alias matches the registry's `drain*` naming convention;
// `_closeAllPooledSockets` kept for backward compat with existing call sites.
export function _closeAllPooledSockets(reason = 'shutdown') {
    _drainComplete = true;
    for (const arr of _wsPool.values()) {
        for (const entry of arr) {
            try { entry.socket.close(1000, reason); } catch {}
        }
    }
    _wsPool.clear();
}
export const drainOpenaiWsPool = _closeAllPooledSockets;
process.on('exit', drainOpenaiWsPool);
