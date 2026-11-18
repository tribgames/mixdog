//! Public xAI Responses socket. Grok OAuth uses its own HTTP-only proxy adapter.

use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ErrorResponse, ModelRequest, ModelStream, ProviderError, StreamEvent, TransportFault, WireCodec, WsPhase};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};

use super::adapter::CompatAdapter;
use super::profile::Wire;
use super::responses::CompatResponsesCodec;
use crate::providers::connect::stream::DecodedStream;
use crate::providers::openai::pool::{Checkout, Compat, WsPool};
use crate::providers::openai::transport_policy::{self, Mode};
use crate::registry::keys::Environment;
use crate::transport::ws::{CallerHeaders, ConnectError, Message};
use crate::transport::{BodyStream, WsDial};

pub(super) fn api_wire(value: &str) -> Wire {
    match value.trim().to_ascii_lowercase().as_str() {
        "0" | "false" | "off" | "chat" | "chat-completions" | "chat_completions" => Wire::Chat,
        _ => Wire::Responses,
    }
}

pub(crate) fn request_wire(value: Option<&str>, default: Wire) -> Wire {
    value.map_or(default, api_wire)
}

pub(crate) struct XaiSocket {
    pub codec: CompatResponsesCodec,
    dial: Arc<dyn WsDial>,
    configured: Option<String>,
    env: Arc<dyn Environment>,
    pool: Arc<WsPool>,
}

impl XaiSocket {
    pub fn new(http: &CompatResponsesCodec, dial: Arc<dyn WsDial>, configured: Option<String>, env: Arc<dyn Environment>) -> Self {
        Self { codec: http.xai_websocket(), dial, configured, env, pool: Arc::default() }
    }

    pub fn release_session(&self, session_id: &str) {
        self.pool.release_session(session_id);
    }

    /// `None` selects HTTP, `Some` opts into a socket and says whether it may fall back to HTTP.
    pub fn selection(&self, explicit: Option<&str>) -> Option<bool> {
        let raw = explicit.map(str::to_owned).or_else(|| self.configured.clone())
            .or_else(|| self.env.var("MIXDOG_XAI_RESPONSES_TRANSPORT"))
            .or_else(|| self.env.var("MIXDOG_XAI_TRANSPORT"));
        let shared = self.env.var("MIXDOG_OAI_TRANSPORT");
        let fallback = self.env.var("MIXDOG_XAI_WS_HTTP_FALLBACK");
        select(raw.as_deref(), shared.as_deref(), fallback.as_deref())
    }

    pub async fn open(&self, account: &CompatAdapter, request: &ModelRequest) -> Result<Box<dyn ModelStream>, ProviderError> {
        let mut wire = self.codec.encode(request)?;
        let key = account.gateway_key().await?.filter(|key| !key.is_empty()).ok_or_else(|| {
            let mut error = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
            error.message = "xAI API key not configured".into();
            error
        })?;
        let body: serde_json::Value = serde_json::from_slice(&wire.body).expect("encoded Responses JSON");
        let lane = body.get("prompt_cache_key").and_then(serde_json::Value::as_str).unwrap_or_default();
        let compat = Compat::new("xai", &key, lane);
        let scope = request.options.transport_scope.as_ref().or(request.options.session_id.as_ref()).filter(|scope| !scope.is_empty());
        let (scope, shared) = scope.map_or_else(|| (format!("\0shared:{}:{}", compat.auth, compat.cache_key), true), |scope| (scope.clone(), false));
        request.options.send_identity.raise_requesting_once();
        let mut checkout = self.pool.checkout(&scope, &compat, shared, false).await;
        if checkout.socket.is_none() {
            wire.headers.retain(|(name, _)| !name.eq_ignore_ascii_case("authorization"));
            wire.headers.push(("Authorization".into(), format!("Bearer {key}")));
            let socket = self.connect(&wire.url, wire.headers).await?;
            if !checkout.attach(socket) {
                let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
                error.unsafe_to_retry = true;
                error.message = "xAI WebSocket session closed before sending".into();
                return Err(error);
            }
        }
        let frame = Message::Text(String::from_utf8(wire.body).expect("encoded JSON is UTF-8").into());
        if let Err(fault) = checkout.socket.as_ref().expect("socket attached").send(frame).await {
            let mut error = ProviderError::transport(fault, DeliveryState::Ambiguous);
            error.ws_phase = Some(WsPhase::Stream);
            return Err(error);
        }
        request.options.send_identity.raise_stage("transport");
        let outcome = Arc::new(AtomicU8::new(PENDING));
        let body = SocketBody { lease: Some(checkout), outcome: outcome.clone() };
        let inner = DecodedStream::new(Box::new(body), self.codec.decoder(request));
        Ok(Box::new(SocketResponse { inner, outcome }))
    }

    async fn connect(&self, url: &str, headers: Vec<(String, String)>) -> Result<Box<dyn crate::transport::WsSocket>, ProviderError> {
        let invalid = |_| ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
        let mut handshake = url.into_client_request().map_err(invalid)?;
        for (name, value) in &headers {
            handshake.headers_mut().append(
                HeaderName::from_bytes(name.as_bytes()).map_err(|_| ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent))?,
                HeaderValue::from_str(value).map_err(|_| ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent))?,
            );
        }
        handshake.extensions_mut().insert(CallerHeaders(headers));
        match mixdog_rt::time::timeout(Duration::from_secs(30), self.dial.dial(handshake)).await {
            Ok(Ok((socket, _))) => Ok(socket),
            Ok(Err(err)) => Err(self.handshake_error(err)),
            Err(_) => {
                let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
                error.ws_phase = Some(WsPhase::Handshake);
                error.timed_out = true;
                error.message = "xAI WebSocket handshake timed out".into();
                Err(error)
            }
        }
    }

    fn handshake_error(&self, failure: ConnectError) -> ProviderError {
        let mut error = match failure {
            ConnectError::Transport(fault) => ProviderError::transport(fault, DeliveryState::NotSent),
            ConnectError::Proxy { code, message } => {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
                error.code = Some(code);
                error.message = message;
                error
            }
            ConnectError::Rejected(response) => {
                let (head, body) = response.into_parts();
                let headers = head.headers.iter().filter_map(|(name, value)| Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned()))).collect();
                self.codec.classify(&ErrorResponse { status: Some(head.status.as_u16()), headers, body: body.unwrap_or_default() })
            }
        };
        error.ws_phase = Some(WsPhase::Handshake);
        error
    }
}

fn select(raw: Option<&str>, shared: Option<&str>, fallback: Option<&str>) -> Option<bool> {
    let raw = raw?.trim().to_ascii_lowercase();
    if matches!(raw.as_str(), "" | "0" | "false" | "off" | "http" | "https" | "responses-http" | "sdk") {
        return None;
    }
    let policy = transport_policy::resolve_openai(shared);
    (policy.mode != Mode::HttpSse).then(|| policy.allow_http_fallback && !fallback.is_some_and(|value| {
        matches!(value.trim().to_ascii_lowercase().as_str(), "0" | "false" | "off" | "no")
    }))
}

pub(crate) fn can_fallback(error: &ProviderError) -> bool {
    if error.kind.is_quota() || matches!(error.kind, ErrorKind::Auth | ErrorKind::Permission | ErrorKind::RateLimited) {
        return false;
    }
    match error.status {
        Some(426 | 408 | 409 | 425) => true,
        Some(525 | 526) => false,
        Some(500..=599) => !error.kind.is_deterministic(),
        Some(_) => false,
        None => match error.transport.as_ref() {
            Some(TransportFault::WsClose { code: Some(code) }) => matches!(*code, 1000 | 1001 | 1005 | 1006 | 1009 | 1011 | 1012),
            Some(_) => true,
            None => error.timed_out || error.code.as_deref() == Some("websocket_connection_limit_reached"),
        },
    }
}

const PENDING: u8 = 0;
const COMPLETED: u8 = 1;
const FAILED: u8 = 2;

struct SocketBody {
    lease: Option<Checkout>,
    outcome: Arc<AtomicU8>,
}

impl Drop for SocketBody {
    fn drop(&mut self) {
        let Some(mut lease) = self.lease.take() else { return };
        match self.outcome.load(Ordering::Relaxed) {
            COMPLETED => lease.finish(Default::default()),
            PENDING => lease.abandon(4002, "aborted"),
            _ => {}
        }
    }
}

#[async_trait]
impl BodyStream for SocketBody {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        loop {
            match self.lease.as_mut()?.socket.as_mut()?.recv().await? {
                Ok(Message::Text(text)) => return Some(Ok(Bytes::copy_from_slice(text.as_bytes()))),
                Ok(Message::Binary(bytes)) => return Some(Ok(Bytes::copy_from_slice(&bytes))),
                Ok(_) => continue,
                Err(error) => return Some(Err(error)),
            }
        }
    }
}

struct SocketResponse {
    inner: DecodedStream,
    outcome: Arc<AtomicU8>,
}

#[async_trait]
impl ModelStream for SocketResponse {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        match self.inner.next().await {
            result @ Some(Ok(StreamEvent::Completed { .. })) => {
                self.outcome.store(COMPLETED, Ordering::Relaxed);
                result
            }
            Some(Err(mut error)) => {
                self.outcome.store(FAILED, Ordering::Relaxed);
                error.ws_phase = Some(WsPhase::Stream);
                Some(Err(error))
            }
            result => result,
        }
    }

    fn delivery(&self) -> DeliveryState { self.inner.delivery() }

    fn on_wire_left(&mut self, left: Arc<dyn Fn() + Send + Sync>) { self.inner.on_wire_left(left); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_xai_explicit_options_preserve_http_default_and_allow_only_selected_fallback() {
        assert_eq!(request_wire(None, Wire::Chat), Wire::Chat);
        assert_eq!(request_wire(Some("responses"), Wire::Chat), Wire::Responses);
        assert_eq!(request_wire(Some("chat-completions"), Wire::Responses), Wire::Chat);
        assert_eq!(select(None, None, None), None);
        assert_eq!(select(Some("https"), None, None), None);
        assert_eq!(select(Some("websocket"), Some("http-sse"), None), None);
        assert_eq!(select(Some("websocket"), None, None), Some(true));
        assert_eq!(select(Some("websocket"), Some("ws-full"), None), Some(false));
        assert_eq!(select(Some("websocket"), None, Some("0")), Some(false));
    }
}
