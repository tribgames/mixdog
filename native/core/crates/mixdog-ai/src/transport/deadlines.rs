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

use std::sync::Mutex;
use std::sync::PoisonError;
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
/// The timer is `AbortSignal.timeout` at Anthropic (`anthropic-oauth-credentials.mjs:609`), Antigravity
/// (`antigravity-oauth-tokens.mjs:341`) and Cursor (`cursor-auth.mjs:359`): a miss reads as the `TimeoutError`.
pub const TOKEN_EXCHANGE: Exchange = credential_signal(secs(30));

/// An auth call under `AbortSignal.timeout(wait)` that refuses redirects.
pub const fn credential_signal(wait: Duration) -> Exchange {
    Exchange::new(Liveness::unary(wait), Redirect::Error, Surface::FetchSignal)
}

/// OpenAI's token refresh: the same 30_000 on a bare `setTimeout(() => controller.abort())`
/// (`openai-oauth-tokens.mjs:225`), so a miss reads as the `AbortError`.
pub const TOKEN_OPENAI: Exchange = Exchange::new(Liveness::unary(secs(30)), Redirect::Error, Surface::FetchAborted);

/// Anthropic's token refresh: the same 30_000 on a bare `setTimeout(() => controller.abort())`
/// (`anthropic-oauth-credentials.mjs:313`), so a miss reads as the `AbortError`; its authorization-code exchange
/// (`:609`) is [`TOKEN_EXCHANGE`].
pub const TOKEN_ANTHROPIC_REFRESH: Exchange = Exchange::new(Liveness::unary(secs(30)), Redirect::Error, Surface::FetchAborted);

/// The 15_000 `AbortSignal.timeout` calls: the Mimo Token Plan probe (`mimo-oauth-tokens.mjs:138`, `:25`) and Command
/// Code's identity and credits reads (`command-code-oauth-tokens.mjs:81`, `:23`).
pub const TOKEN_PROBE: Exchange = Exchange::new(Liveness::unary(secs(15)), Redirect::Error, Surface::FetchSignal);

/// The Muse Code key mint: `muse-code-oauth-tokens.mjs:137` `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`, `:23` 20_000,
/// `redirect: 'error'` (`:142`).
pub const MUSE_KEY: Exchange = Exchange::new(Liveness::unary(secs(20)), Redirect::Error, Surface::FetchSignal);

/// Grok's refresh: `createTimeoutSignal(null, TOKEN_TIMEOUT_MS, 'grok-oauth refresh')`
/// (`grok-oauth-tokens.mjs:304`), whose reason the fetch rejects with. Its authorization-code exchange is
/// [`TOKEN_EXCHANGE`] (`grok-oauth-login.mjs:76` `AbortSignal.timeout`).
pub const TOKEN_GROK: Exchange =
    Exchange::new(Liveness::unary(secs(30)), Redirect::Error, Surface::FetchLabeled("grok-oauth refresh"));

/// Antigravity project lookup: `antigravity-oauth-tokens.mjs:78` 30_000; raw `fetch`
/// (`antigravity-oauth-catalog.mjs:48-58` `postInternalJson`, `withTimeoutSignal` = `AbortSignal.timeout`).
pub const ANTIGRAVITY_PROJECT: Exchange = Exchange::new(Liveness::unary(secs(30)), Redirect::Error, Surface::FetchSignal);

/// Devin's unary RPCs (`devinUnary`, `devin-wire-transport.mjs:469`): a raw `fetch` with `redirect: 'error'` (`:453`)
/// and only the caller's own signal, so no timer of its own and the shared dispatcher's ceiling like [`DEVIN_STREAM`].
/// (The login's code exchange, `devin-auth.mjs:176` `AbortSignal.timeout` 30_000, is [`TOKEN_EXCHANGE`].)
pub const DEVIN_EXCHANGE: Exchange = Exchange::new(Liveness::unary(secs(600)), Redirect::Error, Surface::Fetch);

/// Model lists. OpenAI `openai-oauth-catalog.mjs:23` 10_000; compat
/// `openai-compat-models.mjs:7` 10_000; Antigravity `antigravity-oauth-catalog.mjs:28` 15_000;
/// Grok discovery `grok-oauth-tokens.mjs:90` 15_000; Cursor `cursor-wire-models.mjs:30` 15_000;
/// Devin `devin-wire-models.mjs:482` 5_000; Gemini `lib/gemini-model-catalog.mjs:37` 60_000.
///
/// Text, each by its call: OpenAI `openai-oauth-catalog.mjs:117` raw `fetch`; compat discovery
/// `openai-compat-models.mjs:107` (`fetchCompatModelItems`), and custom discovery on the Anthropic protocol
/// `custom-provider.mjs:117` (`discoverAnthropicModels`), raw `fetch`, which is what `discoverCustomProviderModels`
/// shows (`fetch failed`); Anthropic's own list `anthropic.mjs:464`; Grok `grok-oauth-tokens.mjs:117`; Gemini
/// `gemini-model-catalog.mjs:35`, all raw `fetch`. Cursor's list is `callCursorUnary` over `http2`
/// (`cursor-wire-transport.mjs:265`). Devin's and Antigravity's lists are not fetched by the Rust core.
///
/// Timer, each by its call: OpenAI `AbortSignal.timeout` (`:118`); Anthropic's list (`anthropic.mjs:465`), custom
/// Anthropic discovery (`custom-provider.mjs:116`, `DISCOVERY_TIMEOUT_MS` `:35`) and Gemini (`gemini-model-catalog.mjs:37`)
/// `AbortSignal.timeout` too: a miss reads as the `TimeoutError`; Grok `createTimeoutSignal`
/// (`grok-oauth-tokens.mjs:115`) as its labelled `ProviderTimeoutError`; compat is `createTimeoutSignal` too
/// (`openai-compat-models.mjs:104`), labelled `"<provider> model list"` (see [`compat_model_list`]).
pub const OPENAI_CATALOG: Exchange = Exchange::new(Liveness::unary(secs(10)), Redirect::Follow, Surface::FetchSignal);
pub const ANTHROPIC_MODELS: Exchange = Exchange::new(Liveness::unary(secs(10)), Redirect::Follow, Surface::FetchSignal);

/// A model list's default window: `MODEL_LIST_TIMEOUT_MS` (`openai-compat-models.mjs:7`) and `DISCOVERY_TIMEOUT_MS`
/// (`custom-provider.mjs:35`). An interactive caller passes its own (`listModels({ timeoutMs })`).
pub const MODEL_LIST_WAIT: Duration = secs(10);

/// A raw `fetch` under `AbortSignal.timeout(wait)` that follows redirects: custom discovery on the Anthropic protocol
/// (`custom-provider.mjs:116`), the models.dev and pricing catalogs (`shared/llm/model-catalog.mjs:270` 10_000), the
/// CLI version reads (`npm-cli-version.mjs:51` 4_000, `antigravity-oauth-tokens.mjs:133` 5_000).
pub const fn abort_signal(wait: Duration) -> Exchange {
    Exchange::new(Liveness::unary(wait), Redirect::Follow, Surface::FetchSignal)
}

/// The Gemini cache delete: `gemini.mjs:640` `AbortSignal.timeout(10_000)` on a raw `fetch` (`:636`), errors dropped.
pub const CACHE_DELETE: Exchange = abort_signal(secs(10));

pub fn compat_model_list(provider: &str) -> Exchange {
    compat_model_list_within(provider, MODEL_LIST_WAIT)
}

/// [`compat_model_list`] under the window the caller passed (`fetchCompatModelItems({ timeoutMs })`).
pub fn compat_model_list_within(provider: &str, wait: Duration) -> Exchange {
    // The label is `"<provider> model list"`; provider ids are a small closed set, so each is leaked once.
    static LABELS: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
    let label = format!("{provider} model list");
    let mut known = LABELS.lock().unwrap_or_else(PoisonError::into_inner);
    let label = match known.iter().find(|seen| **seen == label) {
        Some(seen) => *seen,
        None => {
            let leaked: &'static str = Box::leak(label.into_boxed_str());
            known.push(leaked);
            leaked
        }
    };
    Exchange::new(Liveness::unary(wait), Redirect::Follow, Surface::FetchLabeled(label))
}
pub const GROK_DISCOVERY: Exchange =
    Exchange::new(Liveness::unary(secs(15)), Redirect::Error, Surface::FetchLabeled("grok-oauth discovery"));
/// Cursor's unary calls are `callCursorUnary` over `http2` (`cursor-wire-transport.mjs:265`), whose timer rejects
/// `providerTimeoutError('Cursor request', timeoutMs)` (`:274`): the model list passes 15_000
/// (`cursor-wire-models.mjs:30`), the dashboard reads keep the default ([`CURSOR_USAGE`]).
pub const CURSOR_MODELS: Exchange =
    Exchange::new(Liveness::unary(secs(15)), Redirect::Manual, Surface::SocketLabeled("Cursor request"));
pub const GEMINI_MODELS: Exchange = Exchange::new(Liveness::unary(secs(60)), Redirect::Follow, Surface::FetchSignal);

/// Devin run: `devin-wire-transport.mjs:453` POSTs with `redirect: 'error'`; the same raw `fetch` call.
pub const DEVIN_STREAM: Exchange = Exchange::new(Liveness::stream(secs(600)), Redirect::Error, Surface::Fetch);

/// Cursor run over HTTP/2 (`cursor-wire-transport.mjs`): no redirect handling in Node, and the errors are
/// the `http2` session's own (`openCursorStream`, `request.on('error')` `:231-232`). The only timer before the response
/// head is `CONNECT_TIMEOUT_MS` 30_000 (`:21`, armed `:151`, cleared by the head `:223`); the body has none unless
/// `MIXDOG_CURSOR_H2_IDLE_TIMEOUT_MS` is set (`:155`).
pub const CURSOR_RUN: Exchange = Exchange::new(Liveness::stream(secs(30)), Redirect::Manual, Surface::SocketConnect);

/// The OpenCode Console requests (device code and token, refresh, `/api/user`, `/api/orgs`, config):
/// `opencode-go-oauth-tokens.mjs:39` `REQUEST_TIMEOUT_MS` 20_000 on `AbortSignal.timeout` (`:188`), and
/// `redirect: 'error'` (`consoleRequest`); raw `fetch` (`:187-189`, `fetchFn = fetch`).
pub const OPENCODE_CONSOLE: Exchange = Exchange::new(Liveness::unary(secs(20)), Redirect::Error, Surface::FetchSignal);

/// Grok model list: `grok-oauth.mjs:509` 10_000 and `:512` `redirect: 'error'`; raw `fetch` (`:507`, `:541`) under
/// `createTimeoutSignal(null, 10_000, 'grok-oauth model list')` (`:505`).
pub const GROK_LISTING: Exchange =
    Exchange::new(Liveness::unary(secs(10)), Redirect::Error, Surface::FetchLabeled("grok-oauth model list"));

/// Vertex token requests (service account, impersonation, the metadata server's mint): `_post` runs a raw `fetch` with no
/// `redirect` option and no timer (`vertex-ai-auth.mjs:569` `this.fetchFn`, `fetchFn = fetch` at `:370`), so it follows
/// and rides the shared dispatcher like [`NODE_DISPATCHER`] (`setGlobalDispatcher`, `http-agent.mjs:73`).
pub const VERTEX_TOKEN: Exchange = NODE_DISPATCHER;

/// The proxy model list of Grok: `grok-oauth.mjs:538` `createTimeoutSignal(null, 10_000, 'grok-oauth proxy model list')`.
pub const GROK_PROXY_LISTING: Exchange =
    Exchange::new(Liveness::unary(secs(10)), Redirect::Error, Surface::FetchLabeled("grok-oauth proxy model list"));

/// Google cache create: `stall-policy.mjs:92` `PROVIDER_CACHE_CREATE_TOTAL_TIMEOUT_MS`
/// (default `min(180_000, generate total)`); raw `fetch` (`gemini.mjs:519` `this._fetch`).
/// The timer is `createTimeoutSignal(null, …, 'Gemini cachedContents.create total')` (`gemini.mjs:511`).
pub const CACHE_CREATE: Exchange =
    Exchange::new(Liveness::unary(secs(180)), Redirect::Follow, Surface::FetchLabeled("Gemini cachedContents.create total"));

/// The registry check of the self-updater: `runtime/shared/update-checker.mjs:22`
/// `FETCH_TIMEOUT_MS` 5_000; raw `fetch` (`update-checker.mjs:99`) on a bare `setTimeout(() => controller.abort())`.
pub const UPDATE_CHECK: Exchange = Exchange::new(Liveness::unary(secs(5)), Redirect::Follow, Surface::FetchAborted);

/// The local whisper `/inference` exchange: no timer, because no input bounds it (Node's `fetch`
/// carries none, `whisper-server.mjs:536-540`; D-hang-services-3). The caller cancels by dropping.
/// Raw `fetch` (`whisper-server.mjs:535`).
pub const VOICE_INFERENCE: Exchange = Exchange::new(Liveness::cancel_only(), Redirect::Follow, Surface::Fetch);

/// GCE metadata server: `vertex-ai-auth.mjs:18` `METADATA_PROBE_MS` 1000; raw `fetch`
/// (`vertex-ai-auth.mjs:247-253` `probeVertexMetadata`).
pub const VERTEX_METADATA: Exchange = Exchange::new(
    Liveness::unary(Duration::from_millis(1000)),
    Redirect::Follow,
    Surface::FetchSignal,
);

/// One shared credential refresh (lock wait plus token call): Node holds the credential
/// lock at most `anthropic-oauth-credentials.mjs:470` 120_000 and then calls the token
/// endpoint for at most `:79` 30_000.
pub const REFRESH_FLIGHT: Liveness = Liveness::unary(secs(150));

/// The Cursor dashboard unary calls (`GetCurrentPeriodUsage`, `GetPlanInfo`): `callCursorUnary`'s default
/// `timeoutMs` 5_000 (`cursor-wire-transport.mjs:265`); the raw HTTP/2 request handles no redirect and
/// fails with the session's own error (`:308-309`).
pub const CURSOR_USAGE: Exchange =
    Exchange::new(Liveness::unary(secs(5)), Redirect::Manual, Surface::SocketLabeled("Cursor request"));