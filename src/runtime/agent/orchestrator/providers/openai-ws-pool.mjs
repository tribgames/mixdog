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
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { _envOn, _codexBetaFeatures, _dumpHandshakeHeaders, _dumpFrame, _formatRedactedHeaders, _cfCookieHeader, _cfCookieCapture } from './openai-ws-headers.mjs';
import {
    clearAllCodexTurnStates,
    clearCodexTurnStateScope,
    retireCodexTurnStateOwner,
} from './openai-turn-state.mjs';
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
    // Codex keeps its cached connection until the backend's documented
    // 60-minute Responses WebSocket connection limit.
    60 * 60_000,
    { minMs: 60_000, maxMs: 60 * 60_000 },
);
const WS_HANDSHAKE_TIMEOUT_MS = PROVIDER_WS_HANDSHAKE_TIMEOUT_MS;
const WS_ACQUIRE_TIMEOUT_MS = PROVIDER_WS_ACQUIRE_TIMEOUT_MS;
// Enforced by `ws` while fragments are assembled, before a complete payload
// reaches the stream consumer or is decoded. Shared by Codex, direct OpenAI,
// and xAI so no provider can opt into an unbounded receive allocation.
export const WS_MAX_INCOMING_FRAME_BYTES = 16 * 1024 * 1024;
// A write that never reaches the ws callback is indistinguishable from a
// wedged transport. Keep it under the same short bound as socket acquisition
// so the caller can discard the entry and reconnect before arming stream
// watchdogs.
const WS_SEND_TIMEOUT_MS = WS_ACQUIRE_TIMEOUT_MS;
// Grace period between a graceful close() and a forced terminate() during
// session close / drain. A wedged or half-open socket never completes the close
// handshake, so without the follow-up terminate it keeps its FD (and the
// process) alive well past teardown.
const WS_CLOSE_TERMINATE_MS = 250;
const WS_PING_INTERVAL_MS = PROVIDER_WS_PING_INTERVAL_MS;
const WS_PONG_TIMEOUT_MS = PROVIDER_WS_PONG_TIMEOUT_MS;
const WS_LIVENESS_STALE_MS = PROVIDER_WS_LIVENESS_STALE_MS;
const WS_PING_ENABLED = PROVIDER_WS_PING_ENABLED;

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
export const _wsPool = new Map();
let _releaseSequence = 0;

// Codex gives one turn-scoped session exclusive use of one WebSocket until its
// response stream ends. Mirror that ownership per poolKey: a concurrent acquire
// waits instead of opening a sibling connection with a mismatched response
// chain. The claim is retained through close when keep=false so only an actual
// close can hand turn state to a replacement socket.
const _poolOwnerByKey = new Map();

function _acquireAbortError(externalSignal) {
    const reason = externalSignal?.reason;
    return reason instanceof Error ? reason : new Error('OpenAI OAuth WS acquire aborted');
}

function _waitForPoolOwnerRelease(claim, externalSignal) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            claim.waiters.delete(onRelease);
            try { externalSignal?.removeEventListener('abort', onAbort); } catch {}
            fn(value);
        };
        const onRelease = () => finish(resolve);
        const onAbort = () => finish(reject, _acquireAbortError(externalSignal));
        claim.waiters.add(onRelease);
        if (externalSignal) {
            if (externalSignal.aborted) {
                onAbort();
                return;
            }
            externalSignal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

async function _claimPoolOwner(poolKey, externalSignal) {
    if (!poolKey) return null;
    const waitStartedAt = performance.now();
    for (;;) {
        if (externalSignal?.aborted) throw _acquireAbortError(externalSignal);
        const current = _poolOwnerByKey.get(poolKey);
        if (!current) {
            const claim = {
                entry: null,
                waiters: new Set(),
                waitMs: Math.max(0, performance.now() - waitStartedAt),
            };
            _poolOwnerByKey.set(poolKey, claim);
            return claim;
        }
        await _waitForPoolOwnerRelease(current, externalSignal);
    }
}

function _bindPoolOwner(poolKey, claim, entry) {
    if (!poolKey || !claim) return;
    if (_poolOwnerByKey.get(poolKey) !== claim) {
        try { entry?.socket?.close?.(1000, 'pool_owner_changed'); } catch {}
        _scheduleForcedTerminate(entry?.socket);
        throw new Error('OpenAI OAuth WS ownership changed during acquire');
    }
    claim.entry = entry;
    entry.poolOwnerClaim = claim;
}

function _releasePoolOwner(poolKey, owner) {
    if (!poolKey || !owner) return;
    const claim = owner.poolOwnerClaim || owner;
    if (_poolOwnerByKey.get(poolKey) !== claim) return;
    _poolOwnerByKey.delete(poolKey);
    if (claim.entry?.poolOwnerClaim === claim) {
        try { delete claim.entry.poolOwnerClaim; } catch {}
    }
    for (const waiter of [...claim.waiters]) {
        try { waiter(); } catch {}
    }
    claim.waiters.clear();
}

function _clearPoolOwnerScope(poolKey) {
    const claim = poolKey ? _poolOwnerByKey.get(poolKey) : null;
    if (claim) _releasePoolOwner(poolKey, claim);
}

function _clearAllPoolOwners() {
    for (const [poolKey, claim] of [..._poolOwnerByKey.entries()]) {
        _releasePoolOwner(poolKey, claim);
    }
}

function _poolCompatibility(auth, cacheKey) {
    const type = String(auth?.type || 'openai-oauth');
    // Prefer the stable OAuth account id so an access-token refresh can keep
    // using the same connection. If it is unavailable, fail closed to the
    // credential itself; a refresh then opens a new socket rather than risking
    // cross-account continuation.
    const credentialIdentity = auth?.account_id || auth?.apiKey || auth?.access_token || '';
    return {
        authIdentity: createHash('sha256')
            .update(`${type}\0${String(credentialIdentity)}`)
            .digest('hex'),
        cacheKeyIdentity: String(cacheKey || ''),
    };
}

function _entryCompatible(entry, compatibility) {
    return entry?.authIdentity === compatibility.authIdentity
        && entry?.cacheKeyIdentity === compatibility.cacheKeyIdentity;
}

// A previous_response_id is valid on the connection that produced it. If a
// bucket contains multiple legacy idle entries, continue on the most recently
// completed one instead of whichever socket happened to be inserted first.
function _selectIdleEntry(entries, compatibility) {
    let selected;
    for (const entry of entries || []) {
        if (entry?.busy || !_entryCompatible(entry, compatibility)) continue;
        if (!selected || (entry.releaseSequence || 0) > (selected.releaseSequence || 0)) {
            selected = entry;
        }
    }
    return selected;
}

// --- Cache-route probe state (2026-07-04 hunt) -----------------------------
// CF cookie stickiness (the reference client persists
// __cf_bm/_cfuvid across HTTP clients; our WS handshakes never echo them, so
// Cloudflare may re-shard every fresh socket). Jar is per-process, keyed by
// auth account. Env knobs (A/B):
//   MIXDOG_OAI_CF_COOKIES=1        capture Set-Cookie from the 101 upgrade and
//                                  send Cookie on subsequent handshakes
//   MIXDOG_OAI_SESSION_AFFINITY=1  send x-session-affinity: <cacheKey>
//                                  (a known cache-affinity hint)
//   MIXDOG_OAI_WS_URL_SESSION=0    drop the ?session_id= URL query (reference
//                                  clients all use the bare WS URL)
function _getPoolArr(poolKey) {
    if (!poolKey) return null;
    let arr = _wsPool.get(poolKey);
    if (!arr) {
        arr = [];
        _wsPool.set(poolKey, arr);
    }
    return arr;
}

// Sockets this process owns that deliberately live OUTSIDE _wsPool: a
// forceFresh acquire (never reusable), a caller with no poolKey, and the
// cap-overflow ephemeral. They were invisible to per-session close and to the
// global drain, so a wedged one survived both. Tracking them here keeps the
// reuse map unchanged (nothing can select them) while making every owned socket
// reachable by closeOpenaiWsPoolForSession/drainOpenaiWsPool.
const _unpooledSockets = new Set();

function _trackUnpooled(entry, poolKey) {
    if (!entry) return;
    entry.unpooled = true;
    entry.poolKey = poolKey || null;
    _unpooledSockets.add(entry);
}

function _untrackUnpooled(entry) {
    if (entry) _unpooledSockets.delete(entry);
}

function _removeFromPool(poolKey, entry) {
    // Always tear down per-entry timers so evicting a socket never leaks an
    // idle-close or liveness-ping interval.
    _clearIdle(entry);
    _clearLiveness(entry);
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

function _setTransportReferenced(entry, referenced) {
    const transport = entry?.socket?._socket;
    try {
        if (referenced) transport?.ref?.();
        else transport?.unref?.();
    } catch {}
}

function _clearLiveness(entry) {
    if (entry?.pingTimer) {
        clearInterval(entry.pingTimer);
        entry.pingTimer = null;
    }
}

// Force a dead/half-open socket out of the pool. close() alone can hang on a
// wedged socket, so follow with terminate() to guarantee FD release.
function _evictDead(poolKey, entry) {
    try { entry.socket.close(1000, 'ws_liveness_dead'); } catch {}
    try { entry.socket.terminate?.(); } catch {}
    _removeFromPool(poolKey, entry);
}

// Send one ws-level ping and resolve true iff a pong lands within timeoutMs.
// Never rejects. On any success it refreshes lastAliveAt so the caller/loop
// treats the socket as fresh.
function _pingProbe(entry, timeoutMs) {
    return new Promise((resolve) => {
        const socket = entry?.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) { resolve(false); return; }
        let done = false;
        const finish = (alive) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { socket.removeListener('pong', onPong); } catch {}
            resolve(alive);
        };
        const onPong = () => { entry.lastAliveAt = Date.now(); finish(true); };
        const timer = setTimeout(() => finish(false), timeoutMs);
        try { timer.unref?.(); } catch {}
        try {
            socket.on('pong', onPong);
            socket.ping();
        } catch {
            finish(false);
        }
    });
}

// While an entry sits idle in the pool, ping it every WS_PING_INTERVAL_MS.
// A missed pong (or a socket that is no longer OPEN) evicts the entry so it can
// never be handed out dead. Busy entries are skipped — an in-flight turn has
// its own inter-chunk/semantic-idle watchdogs.
function _armLiveness(poolKey, entry) {
    _clearLiveness(entry);
    entry.pingTimer = setInterval(async () => {
        if (entry.busy || entry.closing || entry.probing) return;
        if (!_isOpen(entry)) { _evictDead(poolKey, entry); return; }
        // Recent activity ⇒ assume live, skip the probe this tick.
        if (Date.now() - (entry.lastAliveAt || 0) < WS_LIVENESS_STALE_MS) return;
        entry.probing = true;
        try {
            const alive = await _pingProbe(entry, WS_PONG_TIMEOUT_MS);
            if (!alive && !entry.busy) _evictDead(poolKey, entry);
        } finally {
            entry.probing = false;
        }
    }, WS_PING_INTERVAL_MS);
    try { entry.pingTimer.unref?.(); } catch {}
}

// Awaited frame send. Asserts the socket is OPEN and resolves only after
// the underlying transport reports the buffered write succeeded (or fails)
// via the WebSocket send callback. Raw `socket.send(JSON.stringify(...))`
// is fire-and-forget — a wedged or half-closed socket silently queues the
// payload and the caller assumes it landed, then later times out waiting
// for a server event that will never arrive. Tag any failure with
// `wsSendFailed=true` so _classifyMidstreamError routes the next attempt
// through a fresh socket.
export function _sendFrame(entry, frame, sendSpan = null, timeoutMs = WS_SEND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const socket = entry?.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            const err = new Error(`WS send: socket not OPEN (readyState=${socket?.readyState ?? 'n/a'})`);
            err.wsSendFailed = true;
            reject(err);
            return;
        }
        let payload;
        const serializeStart = performance.now();
        try { payload = JSON.stringify(frame); }
        catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            err.wsSendFailed = true;
            reject(err);
            return;
        }
        if (sendSpan && typeof sendSpan === 'object') {
            sendSpan.requestBuildSerializationMs = (sendSpan.requestBuildSerializationMs || 0)
                + (performance.now() - serializeStart);
        }
        _dumpFrame(payload);
        let settled = false;
        let timer = null;
        const finish = (err = null) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (!err) {
                resolve();
                return;
            }
            const sendErr = err instanceof Error ? err : new Error(String(err));
            sendErr.wsSendFailed = true;
            // A callback error/timeout leaves the transport state unknown.
            // Drop it immediately; releaseWebSocket will also remove the entry
            // from its pool, and the retry path force-acquires a fresh socket.
            try { entry.closing = true; } catch {}
            try { socket.terminate?.(); } catch {}
            reject(sendErr);
        };
        const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
            ? timeoutMs
            : WS_SEND_TIMEOUT_MS;
        timer = setTimeout(() => {
            finish(Object.assign(
                new Error(`WS send callback timed out after ${boundedTimeoutMs}ms`),
                { code: 'EWSSENDTIMEOUT', wsSendTimeoutMs: boundedTimeoutMs },
            ));
        }, boundedTimeoutMs);
        try {
            socket.send(payload, (err) => finish(err || null));
        } catch (e) {
            finish(e);
        }
    });
}

function _buildHandshakeHeaders({ auth, sessionToken, cacheKey: _cacheKey, codexHeaders }) {
    // xAI WS: do NOT pin x-grok-conv-id. Measured parallel runs show that
    // forcing a routing shard via that header alternates cold caches across
    // parallel workers; the automatic prompt-prefix cache holds up better
    // when each handshake is unpinned.
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
            // The reference client merges provider http_headers ("version")
            // plus default headers (User-Agent) into the WS handshake.
            // The backend fingerprints
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
    if (isOpenAiOauth && (sessionToken || _cacheKey)) {
        // Codex uses one caller-owned UUIDv7 identity everywhere. Prefer the
        // metadata projection from the session; prompt_cache_key/sessionToken
        // is the exact same UUID and remains a defensive fallback.
        const sessionId = String(codexHeaders?.['session-id'] || sessionToken || _cacheKey);
        const threadId = String(codexHeaders?.['thread-id'] || _cacheKey || sessionId);
        headers['session-id'] = sessionId;
        headers['thread-id'] = threadId;
        headers['x-client-request-id'] = String(codexHeaders?.['x-client-request-id'] || threadId);
        if (codexHeaders && typeof codexHeaders === 'object') {
            for (const [key, value] of Object.entries(codexHeaders)) {
                if (typeof key === 'string' && typeof value === 'string' && value) {
                    headers[key] = value;
                }
            }
        }
    } else {
        // xAI/direct keep a per-request value so their server-side traces stay
        // distinguishable across reconnects.
        headers['x-client-request-id'] = randomBytes(16).toString('hex');
    }
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

function _openSocket({ auth, sessionToken, externalSignal, cacheKey, codexHeaders }) {
    const headers = _buildHandshakeHeaders({ auth, sessionToken, cacheKey, codexHeaders });
    const baseUrl = auth.type === 'xai'
        ? XAI_WS_URL
        : auth.type === 'openai-direct'
            ? OPENAI_WS_URL
            : CODEX_WS_URL;
    const _wsOpenStart = Date.now();
    if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(`[agent-trace] ws-open-start url=${baseUrl} tokenHash=${createHash('sha256').update(String(sessionToken)).digest('hex').slice(0, 8)} ts=${_wsOpenStart}\n`);
    }
    // Bare WS URL by default (reference-client parity). Interleaved A/B
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
        const socket = new WebSocket(url, {
            headers,
            handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS,
            maxPayload: WS_MAX_INCOMING_FRAME_BYTES,
        });
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
        socket.once('upgrade', (res) => {
            try {
                _cfCookieCapture(auth, res?.headers?.['set-cookie']);
                // Probe: dump the full 101-upgrade response header set so we can
                // see what the server actually issues (turn-state investigation).
                if (process.env.MIXDOG_WS_UPGRADE_HEADER_PROBE) {
                    const all = res?.headers && typeof res.headers === 'object'
                        ? _formatRedactedHeaders(res.headers)
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
                        appendFileSync(probePath, line, { encoding: 'utf8', mode: 0o600 });
                        try { chmodSync(probePath, 0o600); } catch {}
                    } catch {}
                }
            } catch {}
        });
        socket.once('open', () => {
            if (process.env.MIXDOG_DEBUG_AGENT) {
                process.stderr.write(`[agent-trace] ws-open-ok elapsed=${Date.now() - _wsOpenStart}ms\n`);
            }
            settle(true, { socket });
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

let _openSocketImpl = _openSocket;

export async function acquireWebSocket({
    auth,
    poolKey,
    cacheKey,
    codexHeaders,
    forceFresh,
    externalSignal,
}) {
    const _acqStart = Date.now();
    if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(`[agent-trace] acquire-start poolKey=${poolKey} cacheKey=${cacheKey} forceFresh=${forceFresh} externalAborted=${!!externalSignal?.aborted} ts=${_acqStart}\n`);
    }
    if (externalSignal?.aborted) {
        throw _acquireAbortError(externalSignal);
    }
    const ownerClaim = await _claimPoolOwner(poolKey, externalSignal);
    try {
    if (poolKey && !forceFresh) {
        const arr = _wsPool.get(poolKey) || [];
        const compatibility = _poolCompatibility(auth, cacheKey);
        // Prune dead entries and idle sockets from an obsolete auth/cache
        // boundary. Busy incompatible entries are left alone until their owner
        // releases them, but can never be selected by this acquire.
        for (let i = arr.length - 1; i >= 0; i--) {
            const incompatibleIdle = !arr[i].busy && !_entryCompatible(arr[i], compatibility);
            if (!_isOpen(arr[i]) || arr[i].closing || incompatibleIdle) {
                if (incompatibleIdle) {
                    try { arr[i].socket.close(1000, 'pool_boundary_changed'); } catch {}
                }
                _clearIdle(arr[i]);
                _clearLiveness(arr[i]);
                arr.splice(i, 1);
            }
        }
        if (arr.length === 0) _wsPool.delete(poolKey);
        // Reuse an idle open entry (cache-warm path). An entry with no observed
        // activity within the freshness window is ping-probed under a short
        // bound before hand-out; a dead one is evicted and the scan retries the
        // next idle entry so a busy caller is never handed a wedged socket.
        let idle;
        while ((idle = _selectIdleEntry(arr, compatibility))) {
            _clearIdle(idle);
            _clearLiveness(idle);
            // Reserve the entry BEFORE awaiting the probe: _pingProbe yields the
            // event loop, so without this a second concurrent acquire could scan
            // the same still-idle entry and both would take it. Marking busy up
            // front makes the find() above skip it; on probe failure it is
            // evicted (removed from arr) so the loop continues cleanly.
            idle.busy = true;
            _setTransportReferenced(idle, true);
            if (WS_PING_ENABLED && Date.now() - (idle.lastAliveAt || 0) >= WS_LIVENESS_STALE_MS) {
                const alive = await _pingProbe(idle, WS_PONG_TIMEOUT_MS);
                if (!alive) {
                    if (process.env.MIXDOG_DEBUG_AGENT) {
                        process.stderr.write(`[agent-trace] acquire-evict-dead poolKey=${poolKey} reason=missed_pong elapsed=${Date.now() - _acqStart}ms\n`);
                    }
                    _evictDead(poolKey, idle);
                    continue;
                }
            }
            idle.lastAliveAt = Date.now();
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
            _bindPoolOwner(poolKey, ownerClaim, idle);
            return { entry: idle, reused: true, ownerWaitMs: ownerClaim?.waitMs || 0 };
        }
        // All entries busy and bucket at cap: fall through to ephemeral socket.
        if (arr.length >= MAX_POOLED_SOCKETS_PER_KEY) {
            if (process.env.MIXDOG_DEBUG_AGENT) {
                process.stderr.write(`[agent-trace] acquire-ephemeral cacheKey=${cacheKey} reason=cap elapsed=${Date.now() - _acqStart}ms\n`);
            }
            const ephSessionToken = _mintSessionToken(cacheKey, auth);
            const { socket } = await _openSocketImpl({ auth, sessionToken: ephSessionToken, externalSignal, cacheKey, codexHeaders });
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
                releaseSequence: 0,
                ...compatibility,
                turnState: null,
                closing: false,
                ephemeral: true,
                sessionToken: ephSessionToken,
            };
            entry.lastAliveAt = Date.now();
            entry.pingTimer = null;
            entry.probing = false;
            socket.on('pong', () => { entry.lastAliveAt = Date.now(); });
            socket.on('message', () => { entry.lastAliveAt = Date.now(); });
            socket.on('close', () => {
                entry.closing = true;
                retireCodexTurnStateOwner(entry.turnStateScope || poolKey, entry);
                _releasePoolOwner(poolKey, entry);
                _untrackUnpooled(entry);
            });
            // Cap-overflow ephemeral: never pooled, still owned by this session.
            _trackUnpooled(entry, poolKey);
            _bindPoolOwner(poolKey, ownerClaim, entry);
            return { entry, reused: false, ownerWaitMs: ownerClaim?.waitMs || 0 };
        }
    }
    // A handshake is scoped to a physical connection, while turn state belongs
    // to one logical turn. Every new socket therefore opens without turn state;
    // request metadata restores it later only when the turn id matches.
    const sessionToken = _mintSessionToken(cacheKey, auth);
    const compatibility = _poolCompatibility(auth, cacheKey);
    if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(`[agent-trace] acquire-new tokenHash=${createHash('sha256').update(String(sessionToken)).digest('hex').slice(0, 8)} elapsed=${Date.now() - _acqStart}ms\n`);
    }
    const { socket } = await _openSocketImpl({ auth, sessionToken, externalSignal, cacheKey, codexHeaders });
    // Drain may complete while the normal handshake is awaiting 'open'. Never
    // return or insert that late socket into the already-drained process pool.
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
        releaseSequence: 0,
        ...compatibility,
        turnState: null,
        turnStateTurnId: null,
        closing: false,
        ephemeral: false,
        sessionToken,
    };
    entry.lastAliveAt = Date.now();
    entry.pingTimer = null;
    entry.probing = false;
    socket.on('pong', () => { entry.lastAliveAt = Date.now(); });
    socket.on('message', () => { entry.lastAliveAt = Date.now(); });
    // A forceFresh or poolKey-less socket is never inserted into the reuse map,
    // but it is still this process's socket — register it as unpooled so
    // session close and drain can reach it.
    if (poolKey && !forceFresh) _getPoolArr(poolKey).push(entry);
    else _trackUnpooled(entry, poolKey);
    socket.on('close', () => {
        entry.closing = true;
        retireCodexTurnStateOwner(entry.turnStateScope || poolKey, entry);
        _releasePoolOwner(poolKey, entry);
        _untrackUnpooled(entry);
        _removeFromPool(poolKey, entry);
    });
    _bindPoolOwner(poolKey, ownerClaim, entry);
    return { entry, reused: false, ownerWaitMs: ownerClaim?.waitMs || 0 };
    } catch (err) {
        _releasePoolOwner(poolKey, ownerClaim);
        throw err;
    }
}

export function releaseWebSocket({ entry, poolKey, keep }) {
    if (!entry) return;
    entry.busy = false;
    if (!keep || !_isOpen(entry) || !poolKey || entry.ephemeral) {
        try { entry.socket.close(1000, keep ? 'no_session' : 'release_no_keep'); } catch {}
        // Ownership is NOT dropped here. close() only requests a close, so a
        // socket that ignores it would become unreachable by session close and
        // drain — exactly the wedged case forced termination exists for. The
        // entry stays tracked until its own 'close' handler untracks it, and
        // the bounded terminate below guarantees that handler runs.
        _scheduleForcedTerminate(entry.socket);
        _removeFromPool(poolKey, entry);
        return;
    }
    // A kept forceFresh socket likewise stays registered as unpooled (nothing
    // may reuse it) until its 'close' handler fires, so drain still reaches it
    // while it lingers under the idle timer.
    // Mark activity at release, then arm both the idle-close timer and the
    // periodic liveness ping so a socket that dies while pooled is evicted
    // before the next acquire can hand it out.
    entry.releaseSequence = ++_releaseSequence;
    entry.lastAliveAt = Date.now();
    _scheduleIdleClose(poolKey, entry);
    if (WS_PING_ENABLED) _armLiveness(poolKey, entry);
    // Idle pooled sockets retain reuse state without retaining the process.
    // acquireWebSocket re-refs the transport before probing or handing it out.
    _setTransportReferenced(entry, false);
    _releasePoolOwner(poolKey, entry);
}

export function closeOpenaiWsPoolForSession(poolKey, reason = 'session_closed') {
    if (!poolKey) return;
    _clearPoolOwnerScope(poolKey);
    clearCodexTurnStateScope(poolKey);
    const closeReason = String(reason || 'session_closed');
    const entries = _wsPool.get(poolKey);
    if (entries) {
        _wsPool.delete(poolKey);
        for (const entry of entries) {
            _shutdownEntry(entry, closeReason);
        }
    }
    // Force-fresh / cap-overflow sockets opened for this session are not in the
    // reuse map but are just as much this session's connections.
    for (const entry of [..._unpooledSockets]) {
        if (entry.poolKey !== poolKey) continue;
        _unpooledSockets.delete(entry);
        _shutdownEntry(entry, closeReason);
    }
}

// Close one entry for good: drop its shard pin and timers, request a graceful
// close, then terminate if the socket does not actually finish closing. A
// wedged/half-open socket ignores close() and would otherwise hold its FD (and
// keep the transport referenced) until the process dies.
function _shutdownEntry(entry, reason, { immediate = false } = {}) {
    if (!entry) return;
    entry.turnState = null;
    _clearIdle(entry);
    _clearLiveness(entry);
    try { entry.socket.close(1000, reason); } catch {}
    _scheduleForcedTerminate(entry.socket, { immediate });
}

// close() is a request, not a guarantee: a wedged/half-open socket never
// completes the handshake. Follow every close with a bounded terminate so the
// FD is released and the socket's own 'close' handler (which untracks it) runs.
function _scheduleForcedTerminate(socket, { immediate = false } = {}) {
    if (!socket) return;
    if (immediate) {
        try { socket.terminate?.(); } catch {}
        return;
    }
    try {
        const timer = setTimeout(() => {
            try {
                if (socket.readyState !== WebSocket.CLOSED) socket.terminate?.();
            } catch {}
        }, WS_CLOSE_TERMINATE_MS);
        timer.unref?.();
    } catch {
        try { socket.terminate?.(); } catch {}
    }
}

// True when the pool already holds a live socket for this key — used by the
// spawn-time prewarm to skip a redundant handshake without reserving (and
// ping-probing) an entry the way acquireWebSocket would.
export function hasPooledWebSocket(poolKey) {
    const entries = poolKey ? _wsPool.get(poolKey) : null;
    if (!entries) return false;
    return entries.some((entry) => _isOpen(entry) && !entry.closing);
}

export function _clearWebSocketPoolForTest() {
    _clearAllPoolOwners();
    for (const arr of _wsPool.values()) {
        for (const entry of arr) {
            entry.turnState = null;
            _clearIdle(entry);
            _clearLiveness(entry);
            try { entry.socket.close(1000, 'test_cleanup'); } catch {}
        }
    }
    for (const entry of _unpooledSockets) {
        entry.turnState = null;
        _clearIdle(entry);
        _clearLiveness(entry);
        try { entry.socket.close(1000, 'test_cleanup'); } catch {}
    }
    _unpooledSockets.clear();
    _wsPool.clear();
    clearAllCodexTurnStates();
    _releaseSequence = 0;
}

export function _setOpenSocketForTest(fn) {
    _openSocketImpl = typeof fn === 'function' ? fn : _openSocket;
}

// Drain-complete fence — set true once drainOpenaiWsPool runs so any
// in-flight acquire that resumes after drain throws instead of pushing a
// fresh socket into the cleared pool. Single-set, process-lifetime invariant.
let _drainComplete = false;

// Drain hook — self-registered exit drain.
// Force-closes pooled sockets and fences subsequent acquires.
export function drainOpenaiWsPool(reason = 'shutdown', { immediate = false } = {}) {
    _drainComplete = true;
    _clearAllPoolOwners();
    clearAllCodexTurnStates();
    for (const arr of _wsPool.values()) {
        // _shutdownEntry tears down per-entry timers before the map is dropped
        // (otherwise the idle-close and liveness-ping intervals outlive the
        // drained pool) and follows close() with terminate() so a wedged socket
        // that ignores the close handshake still releases its FD.
        for (const entry of arr) _shutdownEntry(entry, String(reason || 'shutdown'), { immediate });
    }
    // Force-fresh / poolKey-less / cap-overflow sockets live outside the map
    // and must drain too.
    for (const entry of _unpooledSockets) {
        _shutdownEntry(entry, String(reason || 'shutdown'), { immediate });
    }
    _unpooledSockets.clear();
    _wsPool.clear();
}
// Session-close / drain hooks are shared across provider transports (cursor-wire
// registers the same globals), so chain whatever is already installed instead of
// replacing it — import order must not decide which transport gets torn down.
const _priorPoolSessionCloseHook = globalThis.__mixdogCloseProviderConnectionsForSession;
globalThis.__mixdogCloseProviderConnectionsForSession = (poolKey, reason) => {
    try { _priorPoolSessionCloseHook?.(poolKey, reason); } finally {
        closeOpenaiWsPoolForSession(poolKey, reason);
    }
};
const _priorPoolDrainHook = globalThis.__mixdogDrainProviderConnections;
globalThis.__mixdogDrainProviderConnections = (reason) => {
    try { _priorPoolDrainHook?.(reason); } finally { drainOpenaiWsPool(reason); }
};
// 'exit' hands the listener an exit CODE, never a reason string, and no timer
// can fire after it: terminate immediately instead of scheduling.
process.on('exit', () => drainOpenaiWsPool('process-exit', { immediate: true }));
