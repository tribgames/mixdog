/**
 * codex-client-meta.mjs — codex client identity headers for the OpenAI OAuth
 * transports.
 *
 * codex-rs sends two client-identity headers on EVERY request including the
 * WS handshake:
 *  - `User-Agent: codex_cli_rs/<version> (<os> <ver>; <arch>) <terminal>`
 *    (login/src/auth/default_client.rs get_codex_user_agent + default_headers)
 *  - `version: <CARGO_PKG_VERSION>` via the built-in provider http_headers
 *    (model-provider-info/src/lib.rs:339-343), merged into the WS handshake by
 *    merge_request_headers (codex-api/src/endpoint/responses_websocket.rs).
 * The backend uses these for client gating (model catalog visibility measured
 * 2026-07-03) and plausibly for x-codex-turn-state issuance / sticky
 * cache-node routing, so mixdog mirrors both.
 */
import os from 'node:os';

// Offline fallback only; live value refreshes from npm (24h TTL, in-process).
export const CODEX_CLIENT_VERSION_FLOOR = '0.142.5';
const VERSION_TTL_MS = 24 * 60 * 60_000;
let _cache = { value: null, fetchedAt: 0 };
let _refreshInFlight = null;

async function _refresh() {
    try {
        const res = await fetch('https://registry.npmjs.org/@openai/codex/latest', {
            signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
            const j = await res.json();
            const v = String(j?.version || '').trim();
            if (/^\d+\.\d+\.\d+/.test(v)) {
                _cache = { value: v, fetchedAt: Date.now() };
                return v;
            }
        }
    } catch { /* offline — keep floor */ }
    _cache = { value: CODEX_CLIENT_VERSION_FLOOR, fetchedAt: Date.now() };
    return CODEX_CLIENT_VERSION_FLOOR;
}

/**
 * Sync accessor for hot request paths: returns the cached npm version when
 * fresh, otherwise kicks a background refresh and returns the floor. The
 * handshake must never await a registry fetch.
 */
export function codexClientVersionSync() {
    if (_cache.value && Date.now() - _cache.fetchedAt < VERSION_TTL_MS) return _cache.value;
    if (!_refreshInFlight) {
        _refreshInFlight = _refresh().finally(() => { _refreshInFlight = null; });
    }
    return _cache.value || CODEX_CLIENT_VERSION_FLOOR;
}

function _osType() {
    // codex os_info reports "Windows"/"Mac OS"/"Linux"; node os.type() gives
    // Windows_NT/Darwin/Linux. Map to codex's vocabulary.
    const t = os.type();
    if (t === 'Windows_NT') return 'Windows';
    if (t === 'Darwin') return 'Mac OS';
    return t;
}

function _arch() {
    // codex reports rust-style arch tokens.
    const a = os.arch();
    if (a === 'x64') return 'x86_64';
    if (a === 'arm64') return 'aarch64';
    return a;
}

/**
 * Originator token codex sends on every request (`codex_cli_rs`).
 *
 * Opt-in parity override: an operator can pin the exact originator a known-good
 * codex build reports via MIXDOG_CODEX_ORIGINATOR when the backend fingerprints
 * on it. Unset (default) keeps `codex_cli_rs`, so wire behavior is unchanged.
 */
export function codexOriginator() {
    const override = String(process.env.MIXDOG_CODEX_ORIGINATOR || '').trim();
    return override || 'codex_cli_rs';
}

/** codex_cli_rs/<version> (<os> <ver>; <arch>) <terminal> */
export function codexUserAgent() {
    // Opt-in parity override: pin an exact codex User-Agent string
    // (MIXDOG_CODEX_USER_AGENT) when the auto-derived os/arch/terminal tuple
    // drifts from the real codex build the backend expects. Unset = default.
    const override = String(process.env.MIXDOG_CODEX_USER_AGENT || '').trim();
    if (override) return override;
    const terminal = String(process.env.TERM_PROGRAM || 'unknown').trim() || 'unknown';
    return `codex_cli_rs/${codexClientVersionSync()} (${_osType()} ${os.release()}; ${_arch()}) ${terminal}`;
}

/** Bare version header value — codex built-in provider http_headers "version". */
export function codexVersionHeader() {
    // Opt-in parity override: pin an exact `version` header
    // (MIXDOG_CODEX_VERSION) instead of the npm-derived value. Unset = default
    // (live npm version, floor fallback), so behavior is unchanged.
    const override = String(process.env.MIXDOG_CODEX_VERSION || '').trim();
    if (override) return override;
    return codexClientVersionSync();
}
