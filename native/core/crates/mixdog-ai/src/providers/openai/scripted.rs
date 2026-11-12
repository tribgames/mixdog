//! The real OpenAI adapter over a scripted network, for replays of what Node's WebSocket sender did over a recorded
//! outage. Only the dial is scripted: the acquire's hedge legs, the pool, the delta frames, the decoder and the error
//! classification are the product's own. Compiled for tests only (`test-support`).

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::LinkLiveness;
use mixdog_core_api::domain::keepalive::TransportKeepalive;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_protocol::ProviderId;
use mixdog_rt::CpuBulk;
use tokio_tungstenite::tungstenite::http::Response;

use super::adapter::AdapterLinks;
use super::adapter::Credential;
use super::adapter::CredentialSource;
use super::adapter::OpenAiAdapter;
use super::adapter::SessionContext;
use super::codec::OpenAiCodec;
use super::config::NoFacts;
use super::config::OpenAiConfig;
use super::switch::TransportMode;
use crate::catalog::ListingLookup;
use crate::transport::BodyStream;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;
use crate::transport::WsDial;
use crate::transport::WsSocket;
use crate::transport::ws::ConnectError;
use crate::transport::ws::Message;
use crate::transport::ws::WsEnding;

/// What one dial gets.
pub enum Dialed {
    /// The upgrade completes. The server sends `frames` (text), then ends the link with `close`.
    Socket { frames: Vec<String>, close: (u16, String) },
    /// The upgrade is refused with this status and body.
    Rejected { status: u16, body: String },
    /// The upgrade is never answered.
    Stuck,
    /// The connection is reset before the upgrade is answered.
    Reset,
}

/// What reached the server, in the order it arrived.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Wire {
    /// An upgrade request: its method, target and the headers the product put on it (the WebSocket client library adds
    /// its own handshake headers below the dial).
    Upgrade { method: String, target: String, headers: Vec<(String, String)> },
    /// A text frame a socket received.
    Frame(String),
}

/// The dial: each call takes the next scripted answer; every upgrade request and request frame is kept in arrival order.
#[derive(Default)]
pub struct ScriptedDial {
    script: Mutex<VecDeque<Dialed>>,
    wire: Arc<Mutex<Vec<Wire>>>,
}

impl ScriptedDial {
    pub fn with(script: Vec<Dialed>) -> Arc<Self> {
        Arc::new(Self { script: Mutex::new(script.into()), ..Self::default() })
    }

    /// The upgrade requests and request frames the server saw, in order.
    pub fn wire(&self) -> Vec<Wire> {
        self.wire.lock().unwrap().clone()
    }
}

struct Alive;

impl TransportKeepalive for Alive {
    fn kind(&self) -> TransportKind {
        TransportKind::WebSocket
    }
    fn arm(&self, _: &KeepaliveSchedule) -> Result<(), TransportFault> {
        Ok(())
    }
    fn liveness(&self) -> LinkLiveness {
        LinkLiveness::Alive
    }
    fn may_start_response(&self) -> bool {
        true
    }
}

struct Socket {
    sent: Arc<Mutex<Vec<Wire>>>,
    frames: VecDeque<String>,
    close: (u16, String),
    ended: bool,
}

#[async_trait]
impl WsSocket for Socket {
    async fn send(&self, message: Message) -> Result<(), TransportFault> {
        if let Message::Text(text) = message {
            self.sent.lock().unwrap().push(Wire::Frame(text.as_str().to_owned()));
        }
        Ok(())
    }
    async fn recv(&mut self) -> Option<Result<Message, TransportFault>> {
        if let Some(frame) = self.frames.pop_front() {
            return Some(Ok(Message::text(frame)));
        }
        if std::mem::replace(&mut self.ended, true) {
            return None;
        }
        Some(Err(TransportFault::WsClose { code: Some(self.close.0) }))
    }
    fn link(&self) -> Arc<dyn TransportKeepalive> {
        Arc::new(Alive)
    }
    fn ending(&self) -> Option<WsEnding> {
        self.ended.then(|| WsEnding::Close { code: self.close.0, reason: self.close.1.clone() })
    }
}

#[async_trait]
impl WsDial for ScriptedDial {
    async fn dial(
        &self,
        request: tokio_tungstenite::tungstenite::handshake::client::Request,
    ) -> Result<(Box<dyn WsSocket>, Response<Option<Vec<u8>>>), ConnectError> {
        self.wire.lock().unwrap().push(Wire::Upgrade {
            method: request.method().as_str().to_owned(),
            target: request.uri().path_and_query().map_or_else(String::new, |p| p.as_str().to_owned()),
            headers: request.headers().iter().map(|(name, value)| (name.as_str().to_owned(), String::from_utf8_lossy(value.as_bytes()).into_owned())).collect(),
        });
        let next = self.script.lock().unwrap().pop_front().expect("a scripted dial");
        match next {
            Dialed::Stuck => std::future::pending().await,
            Dialed::Reset => Err(ConnectError::Transport(TransportFault::Reset)),
            Dialed::Socket { frames, close } => Ok((
                Box::new(Socket { sent: self.wire.clone(), frames: frames.into(), close, ended: false }),
                Response::builder().status(101).body(None).unwrap(),
            )),
            Dialed::Rejected { status, body } => {
                Err(ConnectError::Rejected(Response::builder().status(status).body(Some(body.into_bytes())).unwrap()))
            }
        }
    }
}

struct NoHttp;

struct EmptyBody;

#[async_trait]
impl BodyStream for EmptyBody {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, TransportFault>> {
        None
    }
}

#[async_trait]
impl HttpSend for NoHttp {
    async fn send(&self, _: WireRequest, _: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        Ok(HttpResponse { status: 200, headers: vec![], body: Box::new(EmptyBody) })
    }
}

struct Creds;

#[async_trait]
impl CredentialSource for Creds {
    async fn current(&self) -> Result<Credential, ProviderError> {
        Ok(Credential { bearer: "fixture-key".into(), account_id: None })
    }
    /// A key source that reads the same key again, as Node's `reloadApiKey` does for a configured key: unchanged.
    async fn after_rejection(&self, _: &Credential) -> Result<Option<Credential>, ProviderError> {
        Ok(None)
    }
}

/// The API-key adapter (key `fixture-key`, the recorders') on the WebSocket in `mode` (a pinned mode never moves to
/// HTTP/SSE), over `dial`.
pub fn adapter(dial: Arc<ScriptedDial>, compress_lane: CpuBulk, mode: TransportMode) -> Arc<dyn ProviderAdapter> {
    let context = Arc::new(SessionContext::new());
    let config = OpenAiConfig::api_key(true, Arc::new(NoFacts), context.clone());
    Arc::new(
        OpenAiAdapter::new(
            ProviderId::from("openai"),
            OpenAiCodec::new(config, TransportKind::WebSocket),
            AdapterLinks { http: Arc::new(NoHttp), dial, compress_lane, credentials: Arc::new(Creds), context, listing: ListingLookup::new() },
        )
        .with_mode(mode),
    )
}
