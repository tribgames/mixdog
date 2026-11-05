//! When a WebSocket exchange moves to HTTP/SSE: the decisions of
//! `openai-oauth-dispatch.mjs` (`shouldUseHttpFallback`), `openai-ws.mjs`
//! (`shouldFallbackDirectTransport`) and the shared `shouldFallbackTransport`,
//! over the typed facts of a [`ProviderError`]. Pure.

use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;

use super::config::Route;

/// `HANDSHAKE_MAX_ATTEMPTS`: attempts of one WebSocket send before its retry
/// budget is spent (the first plus the five of the stream budget).
pub const WS_ATTEMPTS: u32 = 6;

/// The transport policy switch (`MIXDOG_OAI_TRANSPORT`) for a WebSocket
/// codec: `ws-full` and `ws-delta` pin the socket, `auto` may fall back.
/// (`http-sse` is an HTTP codec.)
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum TransportMode {
    /// WebSocket first, delta frames, HTTP/SSE fallback.
    #[default]
    Auto,
    /// WebSocket only, delta frames.
    WsDelta,
    /// WebSocket only, every frame full.
    WsFull,
}

impl TransportMode {
    pub const fn delta(self) -> bool {
        !matches!(self, Self::WsFull)
    }

    pub const fn http_fallback(self) -> bool {
        matches!(self, Self::Auto)
    }
}

/// Close code of a server that refused the request frame as too big.
const MESSAGE_TOO_BIG: u16 = 1009;
/// Close codes that count as a transient link loss.
const TRANSIENT_CLOSES: [u16; 7] = [1000, 1001, 1005, 1006, 1011, 1012, 4000];

pub fn too_big_close(error: &ProviderError) -> bool {
    matches!(error.transport, Some(TransportFault::WsClose { code: Some(MESSAGE_TOO_BIG) }))
}

/// `shouldFallbackTransport` without its enable switch: a replay-safe failure
/// of a typed transient kind.
pub fn eligible(error: &ProviderError) -> bool {
    let exposed = error.exposure.text_emitted || error.exposure.tool_dispatched || error.exposure.tool_input_cut;
    if exposed || error.unsafe_to_retry {
        return false;
    }
    if let Some(status) = error.status {
        return match status {
            401 | 525 | 526 => false,
            426 | 408 | 409 | 425 | 500..=599 => true,
            _ => false,
        };
    }
    match &error.transport {
        Some(TransportFault::WsClose { code: Some(code) }) => *code == MESSAGE_TOO_BIG || TRANSIENT_CLOSES.contains(code),
        Some(TransportFault::WsClose { code: None }) => true,
        Some(_) => true,
        None => false,
    }
}

/// The upgrade statuses the route treats as "this endpoint does not do
/// WebSocket" (`handshakeErrorPolicy`).
fn upgrade_refusal(route: Route, status: u16) -> bool {
    match route {
        Route::Codex => status == 404,
        Route::ApiKey => matches!(status, 403 | 404 | 429),
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Fallback {
    /// Every later request of the session goes to HTTP/SSE too.
    pub sticky: bool,
}

/// What to do with a WebSocket failure. `handshake`: the upgrade itself was
/// refused; `exhausted`: the send's WebSocket retry budget is spent.
pub fn decide(route: Route, error: &ProviderError, handshake: bool, exhausted: bool) -> Option<Fallback> {
    let exposed = error.exposure.text_emitted || error.exposure.tool_dispatched || error.exposure.tool_input_cut;
    if exposed || error.unsafe_to_retry {
        return None;
    }
    let status = error.status;
    if handshake && status.is_some_and(|s| upgrade_refusal(route, s)) {
        return Some(Fallback { sticky: route == Route::Codex });
    }
    match route {
        Route::Codex => {
            if status == Some(429) {
                return None;
            }
            (eligible(error) && (status == Some(426) || exhausted || too_big_close(error)))
                .then_some(Fallback { sticky: true })
        }
        Route::ApiKey => {
            if status.is_some_and(|s| (400..500).contains(&s)) {
                return None;
            }
            (eligible(error) && (exhausted || too_big_close(error))).then_some(Fallback { sticky: too_big_close(error) })
        }
    }
}
