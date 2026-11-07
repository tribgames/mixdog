//! The [`Liveness`] of each request class. Every value is a Node timeout, cited by
//! its `src/runtime/...` line; a class Node gives no timeout of its own rides
//! Node's shared dispatcher ceiling (`NODE_DISPATCHER`).
//!
//! Redirects follow the Node call site: `fetch` follows by default (model calls, model lists, the
//! updater, the cache); `redirect: 'error'` where the request bears credentials or is an auth call
//! (every token exchange and login `*-oauth-*.mjs`, `devin-auth.mjs:184`, `devin-wire-transport.mjs:453`,
//! `grok-oauth.mjs:512`, `antigravity-oauth-catalog.mjs:57`); the Cursor wire is raw HTTP/2, which never
//! follows, so its answers are returned as they are (`Manual`).

use std::time::Duration;

use mixdog_rt::Liveness;

use super::link::Exchange;
use super::link::Redirect;

const fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

/// A model response: only the head is bounded, the body is content (SPEC §4.9).
/// `shared/llm/http-agent.mjs:413` `headersTimeout` 600_000.
pub const MODEL_STREAM: Exchange = Exchange::new(Liveness::stream(secs(600)), Redirect::Follow);

/// A unary request that Node gives no timeout of its own: its fetch still rides
/// the LLM dispatcher (`shared/llm/http-agent.mjs:413-414`, headers and body 600_000).
pub const NODE_DISPATCHER: Exchange = Exchange::new(Liveness::unary(secs(600)), Redirect::Follow);

/// Token exchange and refresh: `agent/orchestrator/providers/anthropic-oauth-credentials.mjs:79`,
/// `openai-oauth-tokens.mjs:40`, `grok-oauth-tokens.mjs:91`, `cursor-auth.mjs:21`,
/// `antigravity-oauth-tokens.mjs:77` (all 30_000).
pub const TOKEN_EXCHANGE: Exchange = Exchange::new(Liveness::unary(secs(30)), Redirect::Error);

/// Antigravity project lookup: `antigravity-oauth-tokens.mjs:78` 30_000.
pub const ANTIGRAVITY_PROJECT: Exchange = Exchange::new(Liveness::unary(secs(30)), Redirect::Error);

/// Devin session exchange: `devin-auth.mjs:32` 30_000.
pub const DEVIN_EXCHANGE: Exchange = Exchange::new(Liveness::unary(secs(30)), Redirect::Error);

/// Model lists. OpenAI `openai-oauth-catalog.mjs:23` 10_000; compat
/// `openai-compat-models.mjs:7` 10_000; Antigravity `antigravity-oauth-catalog.mjs:28` 15_000;
/// Grok discovery `grok-oauth-tokens.mjs:90` 15_000; Cursor `cursor-wire-models.mjs:30` 15_000;
/// Devin `devin-wire-models.mjs:482` 5_000; Gemini `lib/gemini-model-catalog.mjs:37` 60_000.
pub const OPENAI_CATALOG: Exchange = Exchange::new(Liveness::unary(secs(10)), Redirect::Follow);
pub const COMPAT_MODEL_LIST: Exchange = Exchange::new(Liveness::unary(secs(10)), Redirect::Follow);
pub const ANTIGRAVITY_MODELS: Exchange = Exchange::new(Liveness::unary(secs(15)), Redirect::Error);
pub const GROK_DISCOVERY: Exchange = Exchange::new(Liveness::unary(secs(15)), Redirect::Error);
pub const CURSOR_MODELS: Exchange = Exchange::new(Liveness::unary(secs(15)), Redirect::Manual);
pub const DEVIN_DISCOVERY: Exchange = Exchange::new(Liveness::unary(secs(5)), Redirect::Error);
pub const GEMINI_MODELS: Exchange = Exchange::new(Liveness::unary(secs(60)), Redirect::Follow);

/// Devin run: `devin-wire-transport.mjs:453` POSTs with `redirect: 'error'`.
pub const DEVIN_STREAM: Exchange = Exchange::new(Liveness::stream(secs(600)), Redirect::Error);

/// Cursor run over HTTP/2 (`cursor-wire-transport.mjs`): no redirect handling in Node.
pub const CURSOR_RUN: Exchange = Exchange::new(Liveness::stream(secs(600)), Redirect::Manual);

/// Grok model list: `grok-oauth.mjs:509` 10_000 and `:512` `redirect: 'error'`.
pub const GROK_LISTING: Exchange = Exchange::new(Liveness::unary(secs(10)), Redirect::Error);

/// Vertex service-account token: Node reaches it through google-auth-library / `fetch`, no `redirect`
/// option (`vertex-ai-auth.mjs`), so it follows.
pub const VERTEX_TOKEN: Exchange = Exchange::new(Liveness::unary(secs(30)), Redirect::Follow);

/// Google cache create: `stall-policy.mjs:92` `PROVIDER_CACHE_CREATE_TOTAL_TIMEOUT_MS`
/// (default `min(180_000, generate total)`).
pub const CACHE_CREATE: Exchange = Exchange::new(Liveness::unary(secs(180)), Redirect::Follow);

/// The registry check of the self-updater: `runtime/shared/update-checker.mjs:22`
/// `FETCH_TIMEOUT_MS` 5_000.
pub const UPDATE_CHECK: Exchange = Exchange::new(Liveness::unary(secs(5)), Redirect::Follow);

/// The local whisper `/inference` exchange: no timer, because no input bounds it (Node's `fetch`
/// carries none, `whisper-server.mjs:536-540`; D-hang-services-3). The caller cancels by dropping.
pub const VOICE_INFERENCE: Exchange = Exchange::new(Liveness::cancel_only(), Redirect::Follow);

/// GCE metadata server: `vertex-ai-auth.mjs:18` `METADATA_PROBE_MS` 1000.
pub const VERTEX_METADATA: Exchange = Exchange::new(
    Liveness::unary(Duration::from_millis(1000)),
    Redirect::Follow,
);

/// One shared credential refresh (lock wait plus token call): Node holds the credential
/// lock at most `anthropic-oauth-credentials.mjs:470` 120_000 and then calls the token
/// endpoint for at most `:79` 30_000.
pub const REFRESH_FLIGHT: Liveness = Liveness::unary(secs(150));
