//! The [`Liveness`] of each request class. Every value is a Node timeout, cited by
//! its `src/runtime/...` line; a class Node gives no timeout of its own rides
//! Node's shared dispatcher ceiling (`NODE_DISPATCHER`).
//!
//! Redirects follow the Node call site: `fetch` follows by default (model calls, model lists, the
//! updater, the cache); `redirect: 'error'` where the request bears credentials or is an auth call
//! (every token exchange and login `*-oauth-*.mjs`, `devin-auth.mjs:184`, `devin-wire-transport.mjs:453`,
//! `grok-oauth.mjs:512`, `antigravity-oauth-catalog.mjs:57`); the Cursor wire is raw HTTP/2, which never
//! follows, so its answers are returned as they are (`Manual`).
//!
//! The text of a connection failure ([`Surface`]) follows the Node call site too, as `golden/connect_errors.json`
//! records it: a raw `fetch` rejects `TypeError: fetch failed` for a refused, unresolved or reset connection and for
//! a restricted port alike (`Fetch`); the OpenAI / Anthropic SDK wraps that as `APIConnectionError: Connection
//! error.` (`Sdk`); Cursor's `http2` socket errors name the resolved address (`Socket`). Each class cites the call
//! that decides it, beside its deadline.

use std::time::Duration;

use mixdog_rt::Liveness;

use super::link::Exchange;
use super::link::Redirect;
use super::link::Surface;

const fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

/// A model response through the SDKs: only the head is bounded, the body is content (SPEC §4.9).
/// `shared/llm/http-agent.mjs:413` `headersTimeout` 600_000. Text: `Connection error.` from the SDK call
/// (`anthropic.mjs:208` `client.messages.create`, `openai-compat-chat-send.mjs:163,282`
/// `client.chat.completions.create`; Grok, local and custom providers ride these engines).
pub const MODEL_STREAM: Exchange = Exchange::new(Liveness::stream(secs(600)), Redirect::Follow, Surface::Sdk);

/// A model response through a raw `fetch`: the OpenAI HTTP stream (`openai-http-sse-request.mjs:108`
/// `fetchFn(responsesUrl, …)`, the error rethrown as it is at `:116-118`) and Gemini REST
/// (`gemini.mjs:798,824` `this._fetch`). Same head bound as [`MODEL_STREAM`]; text `fetch failed`.
pub const MODEL_STREAM_FETCH: Exchange = Exchange::new(Liveness::stream(secs(600)), Redirect::Follow, Surface::Fetch);

/// A unary request that Node gives no timeout of its own: its fetch still rides
/// the LLM dispatcher (`shared/llm/http-agent.mjs:413-414`, headers and body 600_000). Raw `fetch`
/// (`anthropic.mjs:464` model list, `shared/llm/model-catalog.mjs:268` models.dev, the CLI client versions).
pub const NODE_DISPATCHER: Exchange = Exchange::new(Liveness::unary(secs(600)), Redirect::Follow, Surface::Fetch);

/// Token exchange and refresh: `agent/orchestrator/providers/anthropic-oauth-credentials.mjs:79`,
/// `openai-oauth-tokens.mjs:40`, `grok-oauth-tokens.mjs:91`, `cursor-auth.mjs:21`,
/// `antigravity-oauth-tokens.mjs:77` (all 30_000). Text: every one is a raw `fetch`
/// (`anthropic-oauth-credentials.mjs:315,612`, `openai-oauth-tokens.mjs:227`, `grok-oauth-tokens.mjs:313`,
/// `cursor-auth.mjs:222`, `antigravity-oauth-tokens.mjs:330`).
pub const TOKEN_EXCHANGE: Exchange = Exchange::new(Liveness::unary(secs(30)), Redirect::Error, Surface::Fetch);

/// Antigravity project lookup: `antigravity-oauth-tokens.mjs:78` 30_000; raw `fetch`
/// (`antigravity-oauth-catalog.mjs:48-49` `postInternalJson`, `fetchFn = fetch`).
pub const ANTIGRAVITY_PROJECT: Exchange = Exchange::new(Liveness::unary(secs(30)), Redirect::Error, Surface::Fetch);

/// Devin session exchange: `devin-auth.mjs:32` 30_000; raw `fetch` (`devin-auth.mjs:175-179`).
pub const DEVIN_EXCHANGE: Exchange = Exchange::new(Liveness::unary(secs(30)), Redirect::Error, Surface::Fetch);

/// Model lists. OpenAI `openai-oauth-catalog.mjs:23` 10_000; compat
/// `openai-compat-models.mjs:7` 10_000; Antigravity `antigravity-oauth-catalog.mjs:28` 15_000;
/// Grok discovery `grok-oauth-tokens.mjs:90` 15_000; Cursor `cursor-wire-models.mjs:30` 15_000;
/// Devin `devin-wire-models.mjs:482` 5_000; Gemini `lib/gemini-model-catalog.mjs:37` 60_000.
///
/// Text, each by its call: OpenAI `openai-oauth-catalog.mjs:117` raw `fetch`; compat and custom discovery
/// `openai-compat-models.mjs:107` (`fetchCompatModelItems`) / `custom-provider.mjs:117` (`discoverAnthropicModels`) raw `fetch`, which is
/// what `discoverCustomProviderModels` shows (`fetch failed`); Antigravity `antigravity-oauth-catalog.mjs:48`;
/// Grok `grok-oauth-tokens.mjs:117`; Devin `devin-wire-models.mjs:494`; Gemini `gemini-model-catalog.mjs:35`, all
/// raw `fetch`. Cursor's list is `callCursorUnary` over `http2` (`cursor-wire-transport.mjs:265`).
pub const OPENAI_CATALOG: Exchange = Exchange::new(Liveness::unary(secs(10)), Redirect::Follow, Surface::Fetch);
pub const COMPAT_MODEL_LIST: Exchange = Exchange::new(Liveness::unary(secs(10)), Redirect::Follow, Surface::Fetch);
pub const ANTIGRAVITY_MODELS: Exchange = Exchange::new(Liveness::unary(secs(15)), Redirect::Error, Surface::Fetch);
pub const GROK_DISCOVERY: Exchange = Exchange::new(Liveness::unary(secs(15)), Redirect::Error, Surface::Fetch);
pub const CURSOR_MODELS: Exchange = Exchange::new(Liveness::unary(secs(15)), Redirect::Manual, Surface::Socket);
pub const DEVIN_DISCOVERY: Exchange = Exchange::new(Liveness::unary(secs(5)), Redirect::Error, Surface::Fetch);
pub const GEMINI_MODELS: Exchange = Exchange::new(Liveness::unary(secs(60)), Redirect::Follow, Surface::Fetch);

/// Devin run: `devin-wire-transport.mjs:453` POSTs with `redirect: 'error'`; the same raw `fetch` call.
pub const DEVIN_STREAM: Exchange = Exchange::new(Liveness::stream(secs(600)), Redirect::Error, Surface::Fetch);

/// Cursor run over HTTP/2 (`cursor-wire-transport.mjs`): no redirect handling in Node, and the errors are
/// the `http2` session's own (`openCursorStream`, `request.on('error')` `:231-232`).
pub const CURSOR_RUN: Exchange = Exchange::new(Liveness::stream(secs(600)), Redirect::Manual, Surface::Socket);

/// The OpenCode Console requests (device code and token, refresh, `/api/user`, `/api/orgs`, config):
/// `opencode-go-oauth-tokens.mjs:39` `REQUEST_TIMEOUT_MS` 20_000 on `AbortSignal.timeout` (`:188`), and
/// `redirect: 'error'` (`consoleRequest`); raw `fetch` (`:187-189`, `fetchFn = fetch`).
pub const OPENCODE_CONSOLE: Exchange = Exchange::new(Liveness::unary(secs(20)), Redirect::Error, Surface::Fetch);

/// Grok model list: `grok-oauth.mjs:509` 10_000 and `:512` `redirect: 'error'`; raw `fetch` (`:507`, `:541`).
pub const GROK_LISTING: Exchange = Exchange::new(Liveness::unary(secs(10)), Redirect::Error, Surface::Fetch);

/// Vertex service-account token: Node reaches it through google-auth-library / `fetch`, no `redirect`
/// option (`vertex-ai-auth.mjs`), so it follows. Raw `fetch` (`vertex-ai-auth.mjs:569` `this.fetchFn`,
/// `fetchFn = fetch` at `:370`).
pub const VERTEX_TOKEN: Exchange = Exchange::new(Liveness::unary(secs(30)), Redirect::Follow, Surface::Fetch);

/// Google cache create: `stall-policy.mjs:92` `PROVIDER_CACHE_CREATE_TOTAL_TIMEOUT_MS`
/// (default `min(180_000, generate total)`); raw `fetch` (`gemini.mjs:519` `this._fetch`).
pub const CACHE_CREATE: Exchange = Exchange::new(Liveness::unary(secs(180)), Redirect::Follow, Surface::Fetch);

/// The registry check of the self-updater: `runtime/shared/update-checker.mjs:22`
/// `FETCH_TIMEOUT_MS` 5_000; raw `fetch` (`update-checker.mjs:99`).
pub const UPDATE_CHECK: Exchange = Exchange::new(Liveness::unary(secs(5)), Redirect::Follow, Surface::Fetch);

/// The local whisper `/inference` exchange: no timer, because no input bounds it (Node's `fetch`
/// carries none, `whisper-server.mjs:536-540`; D-hang-services-3). The caller cancels by dropping.
/// Raw `fetch` (`whisper-server.mjs:535`).
pub const VOICE_INFERENCE: Exchange = Exchange::new(Liveness::cancel_only(), Redirect::Follow, Surface::Fetch);

/// GCE metadata server: `vertex-ai-auth.mjs:18` `METADATA_PROBE_MS` 1000; raw `fetch`
/// (`vertex-ai-auth.mjs:247-253` `probeVertexMetadata`).
pub const VERTEX_METADATA: Exchange = Exchange::new(
    Liveness::unary(Duration::from_millis(1000)),
    Redirect::Follow,
    Surface::Fetch,
);

/// One shared credential refresh (lock wait plus token call): Node holds the credential
/// lock at most `anthropic-oauth-credentials.mjs:470` 120_000 and then calls the token
/// endpoint for at most `:79` 30_000.
pub const REFRESH_FLIGHT: Liveness = Liveness::unary(secs(150));

/// The Cursor dashboard unary calls (`GetCurrentPeriodUsage`, `GetPlanInfo`): `callCursorUnary`'s default
/// `timeoutMs` 5_000 (`cursor-wire-transport.mjs:265`); the raw HTTP/2 request handles no redirect and
/// fails with the session's own error (`:308-309`).
pub const CURSOR_USAGE: Exchange = Exchange::new(Liveness::unary(secs(5)), Redirect::Manual, Surface::Socket);