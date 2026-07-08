/*
 * openai-transport-policy.mjs — single source of truth for the shared
 * Responses-API transport policy switch (OpenAI OAuth/direct + xAI/compat).
 *
 * One env knob, MIXDOG_OAI_TRANSPORT, selects among the transport modes:
 *   - 'ws-delta'  (DEFAULT): WS transport, refs-compatible delta ON.
 *   - 'ws-full'   WS transport, delta OFF (always full frames).
 *   - 'http-sse'  force the HTTP/SSE transport directly (delta is WS-only, so
 *                 it stays off).
 *   - 'auto'      compatibility spelling for the default ws-delta route.
 *
 * No mode performs an implicit HTTP fallback: explicit modes pin their
 * transport. Delta is selected solely via MIXDOG_OAI_TRANSPORT=ws-delta
 * (or by leaving the env unset).
 */

// Normalize the transport mode token. Underscores/spaces and a few common
// spellings collapse to the canonical modes. Unknown/empty → null so the
// caller falls back to the default 'ws-delta'.
export function _normalizeTransportMode(raw) {
    const v = String(raw || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    switch (v) {
        case 'ws-full': case 'wsfull': case 'full': case 'ws': case 'websocket-full':
            return 'ws-full';
        case 'ws-delta': case 'wsdelta': case 'delta': case 'websocket-delta':
            return 'ws-delta';
        case 'http-sse': case 'httpsse': case 'http': case 'sse': case 'http/sse':
            return 'http-sse';
        case 'auto':
            return 'ws-delta';
        default:
            return null;
    }
}

const DELTA_OFF = Object.freeze({ force: false, refs: false, optIn: false });
const DELTA_REFS = Object.freeze({ force: false, refs: true, optIn: true });

// Per-provider transport capabilities for the shared Responses policy. Every
// Responses backend can speak WS and HTTP/SSE, and the WS *delta* continuation
// (previous_response_id + incremental input in openai-ws-delta.mjs) is enabled
// for BOTH OpenAI and xAI/Grok — but they use it for different reasons and
// with different risk profiles:
//   - OpenAI/codex: delta is the prefix-stripping optimization that is only
//     fully cache-safe with the x-codex-turn-state sticky token; the refs-mode
//     structural guards (openai-ws-delta.mjs) exist to bound that risk.
//   - xAI/Grok: the official xAI Responses WebSocket guide *documents*
//     previous_response_id + incremental input as the standard continuation
//     shape (no Codex turn-state, no prefix-strip caveat). Enabling delta here
//     mirrors that guidance rather than a codex-only hack, so 'ws-delta' drives
//     the official continuation instead of collapsing to 'ws-full'.
// Unknown providers get the permissive full-capability default.
export const FULL_RESPONSES_TRANSPORT_CAPS = Object.freeze({ ws: true, http: true, delta: true });
export const RESPONSES_TRANSPORT_CAPABILITIES = Object.freeze({
    'openai-oauth': Object.freeze({ ws: true, http: true, delta: true }),
    'openai':       Object.freeze({ ws: true, http: true, delta: true }), // direct
    'xai':          Object.freeze({ ws: true, http: true, delta: true }), // official WS continuation
});

// Down-shift a requested mode to the nearest mode the provider actually
// supports. Pure/idempotent: full-capability providers pass every mode through
// unchanged, so the OpenAI OAuth/direct resolution stays byte-identical.
export function _gateTransportMode(mode, caps) {
    let m = mode;
    // Delta unsupported → keep WS transport but force full frames.
    if (m === 'ws-delta' && !caps.delta) m = 'ws-full';
    // WS unsupported → prefer HTTP, else defer to auto.
    if ((m === 'ws-full' || m === 'ws-delta') && !caps.ws) m = caps.http ? 'http-sse' : 'ws-delta';
    // HTTP unsupported → prefer full-frame WS, else defer to auto.
    if (m === 'http-sse' && !caps.http) m = caps.ws ? 'ws-full' : 'auto';
    return m;
}

/**
 * Resolve the shared Responses transport policy from the environment, gated by
 * per-provider capabilities.
 * @param {Record<string,string|undefined>} [env=process.env]
 * @param {{ws?:boolean,http?:boolean,delta?:boolean}} [capabilities=FULL_RESPONSES_TRANSPORT_CAPS]
 * @returns {{ mode: 'ws-full'|'ws-delta'|'http-sse',
 *             requestedMode: 'ws-full'|'ws-delta'|'http-sse',
 *             transport: 'auto'|'ws'|'http',
 *             allowHttpFallback: boolean,
 *             delta: { force: boolean, refs: boolean, optIn: boolean },
 *             capabilities: {ws:boolean,http:boolean,delta:boolean} }}
 */
export function resolveResponsesTransportPolicy(env = process.env, capabilities = FULL_RESPONSES_TRANSPORT_CAPS) {
    const caps = { ...FULL_RESPONSES_TRANSPORT_CAPS, ...(capabilities || {}) };
    const requestedMode = _normalizeTransportMode(env?.MIXDOG_OAI_TRANSPORT) || 'ws-delta';
    const mode = _gateTransportMode(requestedMode, caps);
    let transport;
    let delta;
    switch (mode) {
        case 'http-sse':
            transport = 'http';
            delta = DELTA_OFF;      // delta is a WS-only optimization
            break;
        case 'ws-full':
            transport = 'ws';
            delta = DELTA_OFF;      // explicit full frames
            break;
        case 'ws-delta':
            transport = 'ws';
            // Reachable only when caps.delta is true (else gated to ws-full).
            delta = caps.delta ? DELTA_REFS : DELTA_OFF;
            break;
        default:
            transport = 'ws';
            delta = caps.delta ? DELTA_REFS : DELTA_OFF;
            break;
    }
    return {
        mode,
        requestedMode,
        transport,
        // No mode performs an implicit HTTP fallback; explicit http-sse pins the
        // HTTP transport instead. Kept as a field so existing callers gate off.
        allowHttpFallback: false,
        delta,
        capabilities: caps,
    };
}

/**
 * Backward-compatible OpenAI OAuth/direct resolver — a thin full-capability
 * wrapper over the shared policy so existing callers (openai-oauth/openai-ws/
 * openai-ws-delta) and their tests keep byte-identical behavior.
 * @param {Record<string,string|undefined>} [env=process.env]
 */
export function resolveOpenAiTransportPolicy(env = process.env) {
    return resolveResponsesTransportPolicy(env, FULL_RESPONSES_TRANSPORT_CAPS);
}
