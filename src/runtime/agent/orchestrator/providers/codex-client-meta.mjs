/**
 * codex-client-meta.mjs — codex client identity headers for the OpenAI OAuth
 * transports.
 *
 * The reference client sends two client-identity headers on EVERY request,
 * including the WS handshake:
 *  - `User-Agent: codex_cli_rs/<version> (<os> <ver>; <arch>) <terminal>`
 *  - `version: <CARGO_PKG_VERSION>` via the built-in provider http_headers
 *    merged into the WS handshake.
 * The backend uses these for client gating (model catalog visibility measured
 * 2026-07-03) and plausibly for x-codex-turn-state issuance / sticky
 * cache-node routing, so mixdog mirrors both.
 */
import os from 'node:os';
import { createNpmVersionSource, maxSemver } from './npm-cli-version.mjs';

// Offline fallback only; live value refreshes from npm (24h TTL) and the last
// live answer is kept on disk, so the floor is only a first-run default.
// The backend gates model exposure AND per-request model access on the client
// version (gpt-6.1-sol requires >= 0.159.0, measured 2026-10-09), so the
// release workflow raises this to the published CLI version on every release
// (scripts/sync-client-version-floors.mjs).
export const CODEX_CLIENT_VERSION_FLOOR = '0.162.1';
export const CODEX_CLI_NPM_PACKAGE = '@openai/codex';
const live = createNpmVersionSource(CODEX_CLI_NPM_PACKAGE, { persistKey: 'codex-cli' });

/**
 * Sync accessor for hot request paths: the live npm version (or the newest one
 * this machine has seen), never below the floor. A stale value kicks a
 * background refresh; the handshake must never await a registry fetch.
 */
export function codexClientVersionSync() {
  return maxSemver(CODEX_CLIENT_VERSION_FLOOR, live.sync());
}

/**
 * Awaitable warmup for cold-start paths: resolves the live npm version (or
 * floor on failure) and fills the shared cache so codexClientVersionSync()
 * and codexVersionHeader() stop reporting the floor. Never rejects; dedupes
 * with the in-flight background refresh. First turns await this so the
 * backend's minimal_client_version gate never sees a stale floor.
 */
export async function warmCodexClientVersion() {
  return maxSemver(CODEX_CLIENT_VERSION_FLOOR, await live.warm());
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
 * Originator token codex sends on every request.
 *
 * Opt-in parity override: an operator can pin the exact originator a known-good
 * codex build reports via MIXDOG_CODEX_ORIGINATOR when the backend fingerprints
 * on it. Default is the interactive CLI's `codex_cli_rs`, which is also what
 * the User-Agent is built from.
 */
export function codexOriginator() {
  const override = String(process.env.MIXDOG_CODEX_ORIGINATOR || '').trim();
  return override || 'codex_cli_rs';
}

/**
 * <originator>/<version> (<os> <ver>; <arch>) <terminal>
 *
 * The reference client derives its User-Agent FROM the originator, so the two
 * can never disagree: pinning the exec originator while advertising the
 * interactive CLI agent would produce a pair no real client build sends.
 */
export function codexUserAgent() {
  // Opt-in parity override: pin an exact codex User-Agent string
  // (MIXDOG_CODEX_USER_AGENT) when the auto-derived os/arch/terminal tuple
  // drifts from the real codex build the backend expects. Unset = default.
  const override = String(process.env.MIXDOG_CODEX_USER_AGENT || '').trim();
  if (override) return override;
  const terminal = String(process.env.TERM_PROGRAM || 'unknown').trim() || 'unknown';
  return `${codexOriginator()}/${codexClientVersionSync()} (${_osType()} ${os.release()}; ${_arch()}) ${terminal}`;
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
