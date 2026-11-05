//! The shared outbound seams of every provider package, and their one
//! implementation: an HTTP exchange that returns the response head and a
//! streaming body ([`HttpSend`]), a request-streaming exchange ([`BidiOpen`]),
//! and a WebSocket dial ([`WsDial`]). Connections carry the keepalive
//! schedule; nothing behind these seams measures time between bytes.

use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKeepalive;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::Response;

use super::fault::fault_from_reqwest;
use super::fault::provider_error_from_reqwest;
use super::http::client_builder;
use super::ws;
use super::ws::ConnectError;
use super::ws::Message;
use super::ws::WsConnection;

#[async_trait]
pub trait BodyStream: Send {
    /// The next body chunk; `None` at a clean end of body. A fault is the
    /// transport fact that ended the body.
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>>;
}

pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Box<dyn BodyStream>,
}

impl HttpResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// The whole body. A fault mid-body is a transport error with `Accepted`
    /// delivery: the caller holds a status and no content.
    pub async fn read_all(mut self) -> Result<ErrorResponse, ProviderError> {
        let mut body = Vec::new();
        while let Some(chunk) = self.body.next().await {
            match chunk {
                Ok(bytes) => body.extend_from_slice(&bytes),
                Err(fault) => {
                    return Err(ProviderError::transport(fault, DeliveryState::Accepted));
                }
            }
        }
        Ok(ErrorResponse {
            status: Some(self.status),
            headers: self.headers,
            body,
        })
    }
}

#[async_trait]
pub trait HttpSend: Send + Sync {
    /// One request. A failure before a status arrived carries the delivery
    /// state the connection reached (`NotSent` / `Ambiguous`).
    async fn send(&self, request: WireRequest) -> Result<HttpResponse, ProviderError>;
}

/// Writes request-body frames of an open exchange.
pub trait FrameSink: Send + Sync {
    /// Queues a frame; the fault says why the exchange is gone.
    fn send(&self, frame: Vec<u8>) -> Result<(), TransportFault>;
}

#[async_trait]
pub trait BidiOpen: Send + Sync {
    /// Opens the exchange with `first` queued as the first body frame
    /// (`request.body` is ignored). Dropping the sink ends the request body;
    /// dropping the response aborts the exchange.
    async fn open(
        &self,
        request: WireRequest,
        first: Vec<u8>,
    ) -> Result<(HttpResponse, Arc<dyn FrameSink>), ProviderError>;
}

/// The shared `reqwest` client as both HTTP seams. Redirects are never
/// followed: the request carries credentials nobody validated the target of.
pub struct ReqwestLink {
    client: reqwest::Client,
}

impl ReqwestLink {
    /// `http2_only` speaks HTTP/2 without negotiation (Connect streams need
    /// it, and so do the h2c peers of tests).
    pub fn new(schedule: &KeepaliveSchedule, http2_only: bool) -> Result<Self, reqwest::Error> {
        let mut builder = client_builder(schedule).redirect(reqwest::redirect::Policy::none());
        if http2_only {
            builder = builder.http2_prior_knowledge();
        }
        Ok(Self {
            client: builder.build()?,
        })
    }

    #[allow(clippy::result_large_err, reason = "ProviderError is the contract's error type")]
    fn builder(&self, request: &WireRequest) -> Result<reqwest::RequestBuilder, ProviderError> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|_| {
            let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
            error.message = format!("invalid HTTP method {}", request.method);
            error
        })?;
        let mut builder = self.client.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        Ok(builder)
    }
}

struct ReqwestBody(reqwest::Response);

#[async_trait]
impl BodyStream for ReqwestBody {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        match self.0.chunk().await {
            Ok(Some(bytes)) => Some(Ok(bytes)),
            Ok(None) => None,
            Err(err) => Some(Err(fault_from_reqwest(&err).0)),
        }
    }
}

fn response_of(response: reqwest::Response) -> HttpResponse {
    let headers = response
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned())))
        .collect();
    HttpResponse {
        status: response.status().as_u16(),
        headers,
        body: Box::new(ReqwestBody(response)),
    }
}

#[async_trait]
impl HttpSend for ReqwestLink {
    async fn send(&self, request: WireRequest) -> Result<HttpResponse, ProviderError> {
        let builder = self.builder(&request)?.body(request.body);
        let response = builder
            .send()
            .await
            .map_err(|err| provider_error_from_reqwest(&err))?;
        Ok(response_of(response))
    }
}

struct ChannelSink(mpsc::UnboundedSender<Bytes>);

impl FrameSink for ChannelSink {
    fn send(&self, frame: Vec<u8>) -> Result<(), TransportFault> {
        self.0
            .send(Bytes::from(frame))
            .map_err(|_| TransportFault::Closed)
    }
}

#[async_trait]
impl BidiOpen for ReqwestLink {
    async fn open(
        &self,
        request: WireRequest,
        first: Vec<u8>,
    ) -> Result<(HttpResponse, Arc<dyn FrameSink>), ProviderError> {
        let (tx, rx) = mpsc::unbounded_channel::<Bytes>();
        let _ = tx.send(Bytes::from(first));
        let stream = futures::stream::unfold(rx, |mut rx| async move {
            rx.recv()
                .await
                .map(|bytes| (Ok::<_, std::io::Error>(bytes), rx))
        });
        let builder = self
            .builder(&request)?
            .body(reqwest::Body::wrap_stream(stream));
        let response = builder
            .send()
            .await
            .map_err(|err| provider_error_from_reqwest(&err))?;
        Ok((response_of(response), Arc::new(ChannelSink(tx))))
    }
}

/// An open WebSocket as the adapters use it.
#[async_trait]
pub trait WsSocket: Send {
    async fn send(&self, message: Message) -> Result<(), TransportFault>;
    /// The next data frame, or the one fault that ended the link, then `None`.
    async fn recv(&mut self) -> Option<Result<Message, TransportFault>>;
    fn link(&self) -> Arc<dyn TransportKeepalive>;
}

#[async_trait]
impl WsSocket for WsConnection {
    async fn send(&self, message: Message) -> Result<(), TransportFault> {
        WsConnection::send(self, message).await
    }

    async fn recv(&mut self) -> Option<Result<Message, TransportFault>> {
        WsConnection::recv(self).await
    }

    fn link(&self) -> Arc<dyn TransportKeepalive> {
        WsConnection::link(self)
    }
}

#[async_trait]
pub trait WsDial: Send + Sync {
    /// Connects and upgrades. The upgrade response carries the handshake
    /// headers the adapter may read.
    async fn dial(
        &self,
        request: Request,
    ) -> Result<(Box<dyn WsSocket>, Response<Option<Vec<u8>>>), ConnectError>;
}

/// Dials with the keepalive schedule on the socket and the PING driver.
pub struct KeepaliveDialer {
    schedule: KeepaliveSchedule,
}

impl KeepaliveDialer {
    pub fn new(schedule: KeepaliveSchedule) -> Self {
        Self { schedule }
    }
}

#[async_trait]
impl WsDial for KeepaliveDialer {
    async fn dial(
        &self,
        request: Request,
    ) -> Result<(Box<dyn WsSocket>, Response<Option<Vec<u8>>>), ConnectError> {
        let (connection, response) = ws::connect(request, &self.schedule).await?;
        Ok((Box::new(connection), response))
    }
}