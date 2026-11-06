//! WebSocket transport (protocol.md §4.1): `ws://127.0.0.1:<port>/rpc`, `Authorization: Bearer <token>` on the upgrade, no
//! `Origin`. One writer task per connection owns the sink, so a slow socket flush never stops the driver from reading;
//! the reader yields exactly one `Closed`.
//!
//! Remote cores arrive here as a loopback port (an SSH tunnel's local end, the relay's local bridge), so the resolver is the
//! only per-target part.

use std::{path::PathBuf, sync::Arc};

use async_trait::async_trait;
use futures::{SinkExt, StreamExt, stream::SplitStream};
use tokio::{net::TcpStream, sync::mpsc};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        http::{HeaderValue, header::AUTHORIZATION},
        protocol::{CloseFrame, WebSocketConfig, frame::coding::CloseCode},
    },
};

use crate::{
    api::{
        Connector, Target, TransportClosed, TransportEvent, TransportHalves, TransportReader,
        TransportWriter,
    },
    discovery::{Discovery, Endpoint},
};

/// Largest message the client accepts from the core. The core caps its own inbound text at 256 KiB (SPEC R1); outbound
/// snapshots and blob pages are bounded by `Limits`, so this is a guard against a broken peer, not a working limit.
const MAX_INBOUND_BYTES: usize = 16 << 20;
/// Frames queued for the writer task before `send` waits.
const WRITE_QUEUE: usize = 256;

/// Close code 1003: the peer sent a binary frame, which only a host-role connection receives (X17) and this client is not one.
const UNSUPPORTED_DATA: u16 = 1003;
/// RFC 6455: no status code was present in the peer's Close frame.
const NO_STATUS: u16 = 1005;
const ABNORMAL: u16 = 1006;

/// Where a target listens and the token that opens it. Called on every `open` (the token changes with the core).
#[async_trait]
pub trait EndpointResolver: Send + Sync {
    async fn resolve(&self, target: &Target) -> Result<Endpoint, String>;
}

/// The local core, from the discovery file; `serving` cores only.
pub struct DiscoveryResolver {
    path: PathBuf,
}

impl DiscoveryResolver {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
    /// `<runtime root>/daemon.json`.
    pub fn local() -> Self {
        Self::new(crate::discovery::discovery_path())
    }
}

#[async_trait]
impl EndpointResolver for DiscoveryResolver {
    async fn resolve(&self, _target: &Target) -> Result<Endpoint, String> {
        Discovery::read(&self.path)
            .and_then(|d| d.rpc_endpoint())
            .map_err(|e| e.to_string())
    }
}

/// A known endpoint (a tunnel's local port, a test server).
pub struct FixedEndpoint(pub Endpoint);

#[async_trait]
impl EndpointResolver for FixedEndpoint {
    async fn resolve(&self, _target: &Target) -> Result<Endpoint, String> {
        Ok(self.0.clone())
    }
}

pub struct WsConnector {
    resolver: Arc<dyn EndpointResolver>,
}

impl WsConnector {
    pub fn new(resolver: Arc<dyn EndpointResolver>) -> Self {
        Self { resolver }
    }
    /// The local core through its discovery file.
    pub fn local() -> Self {
        Self::new(Arc::new(DiscoveryResolver::local()))
    }
}

enum WriteCmd {
    Text(String),
    Close { code: u16, reason: String },
}

struct Writer {
    queue: mpsc::Sender<WriteCmd>,
    /// Hands the reader the local close, so it reports `Closed` without waiting for a peer that may never answer.
    local_close: mpsc::UnboundedSender<(u16, String)>,
}

#[async_trait]
impl TransportWriter for Writer {
    async fn send(&mut self, text: String) -> Result<(), TransportClosed> {
        self.queue
            .send(WriteCmd::Text(text))
            .await
            .map_err(|_| TransportClosed)
    }

    async fn close(&mut self, code: u16, reason: String) {
        let _ = self.local_close.send((code, reason.clone()));
        let _ = self.queue.send(WriteCmd::Close { code, reason }).await;
    }
}

struct Reader {
    stream: SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>,
    local_close: mpsc::UnboundedReceiver<(u16, String)>,
    /// To ask the writer task for a protocol-level close (1003).
    queue: mpsc::Sender<WriteCmd>,
    done: Option<TransportEvent>,
}

impl Reader {
    fn finish(&mut self, event: TransportEvent) -> TransportEvent {
        self.done = Some(event.clone());
        event
    }
}

#[async_trait]
impl TransportReader for Reader {
    async fn recv(&mut self) -> TransportEvent {
        if let Some(done) = &self.done {
            return done.clone();
        }
        loop {
            let message = tokio::select! {
                biased;
                Some((code, reason)) = self.local_close.recv() => {
                    return self.finish(TransportEvent::Closed { code, reason });
                }
                m = self.stream.next() => m,
            };
            match message {
                Some(Ok(Message::Text(text))) => return TransportEvent::Frame(text.to_string()),
                Some(Ok(Message::Binary(_))) => {
                    let reason = "binary frame".to_string();
                    let _ = self
                        .queue
                        .send(WriteCmd::Close {
                            code: UNSUPPORTED_DATA,
                            reason: reason.clone(),
                        })
                        .await;
                    return self.finish(TransportEvent::Closed {
                        code: UNSUPPORTED_DATA,
                        reason,
                    });
                }
                // Ping/pong/continuation are handled inside the protocol layer.
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame.map_or((NO_STATUS, String::new()), |f| {
                        (u16::from(f.code), f.reason.to_string())
                    });
                    return self.finish(TransportEvent::Closed { code, reason });
                }
                Some(Err(e)) => {
                    return self.finish(TransportEvent::Closed {
                        code: ABNORMAL,
                        reason: e.to_string(),
                    });
                }
                None => {
                    return self.finish(TransportEvent::Closed {
                        code: ABNORMAL,
                        reason: "connection ended".into(),
                    });
                }
            }
        }
    }
}

#[async_trait]
impl Connector for WsConnector {
    async fn open(&self, target: &Target) -> Result<TransportHalves, String> {
        let endpoint = self.resolver.resolve(target).await?;
        let mut request = format!("ws://127.0.0.1:{}/rpc", endpoint.port)
            .into_client_request()
            .map_err(|e| e.to_string())?;
        request.headers_mut().insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", endpoint.token))
                .map_err(|e| e.to_string())?,
        );
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_INBOUND_BYTES))
            .max_frame_size(Some(MAX_INBOUND_BYTES));
        let (socket, _response) = connect_async_with_config(request, Some(config), true)
            .await
            .map_err(|e| e.to_string())?;
        let (mut sink, stream) = socket.split();

        let (queue, mut commands) = mpsc::channel::<WriteCmd>(WRITE_QUEUE);
        let (local_close, local_close_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(cmd) = commands.recv().await {
                match cmd {
                    WriteCmd::Text(text) => {
                        if sink.send(Message::text(text)).await.is_err() {
                            return;
                        }
                    }
                    WriteCmd::Close { code, reason } => {
                        let frame = CloseFrame {
                            code: CloseCode::from(code),
                            reason: reason.into(),
                        };
                        let _ = sink.send(Message::Close(Some(frame))).await;
                        let _ = sink.close().await;
                        return;
                    }
                }
            }
            // Every writer handle is gone without `close`: end the socket.
            let _ = sink.close().await;
        });

        Ok(TransportHalves {
            writer: Box::new(Writer {
                queue: queue.clone(),
                local_close,
            }),
            reader: Box::new(Reader {
                stream,
                local_close: local_close_rx,
                queue,
                done: None,
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use tokio::net::TcpListener;
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::handshake::server::{Request, Response},
    };

    use super::*;

    async fn connector_to(listener: &TcpListener) -> WsConnector {
        let port = listener.local_addr().unwrap().port();
        WsConnector::new(Arc::new(FixedEndpoint(Endpoint {
            port,
            token: "secret".into(),
        })))
    }

    fn target() -> Target {
        Target { id: "t".into() }
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)] // the handshake callback's error type is fixed by tungstenite
    async fn upgrade_carries_the_bearer_token_and_no_origin_and_text_frames_round_trip() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let connector = connector_to(&listener).await;
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut seen = None;
            let mut ws = accept_hdr_async(tcp, |req: &Request, resp: Response| {
                seen = Some((
                    req.uri().path().to_string(),
                    req.headers()
                        .get(AUTHORIZATION)
                        .map(|v| v.to_str().unwrap().to_string()),
                    req.headers().contains_key("origin"),
                ));
                Ok(resp)
            })
            .await
            .unwrap();
            let Some(Ok(Message::Text(t))) = ws.next().await else {
                panic!("no text frame")
            };
            ws.send(Message::text(format!("echo:{t}"))).await.unwrap();
            // A client close is answered by the library; drain until the stream ends.
            while ws.next().await.is_some() {}
            seen.unwrap()
        });

        let mut halves = connector.open(&target()).await.unwrap();
        halves.writer.send("hello".into()).await.unwrap();
        assert_eq!(
            halves.reader.recv().await,
            TransportEvent::Frame("echo:hello".into())
        );
        halves.writer.close(1000, "done".into()).await;
        assert_eq!(
            halves.reader.recv().await,
            TransportEvent::Closed {
                code: 1000,
                reason: "done".into()
            }
        );
        let (path, auth, origin) = server.await.unwrap();
        assert_eq!(path, "/rpc");
        assert_eq!(auth.as_deref(), Some("Bearer secret"));
        assert!(!origin);
    }

    #[tokio::test]
    async fn a_server_close_frame_is_reported_once_with_its_code() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let connector = connector_to(&listener).await;
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            ws.close(Some(CloseFrame {
                code: CloseCode::from(4000),
                reason: "slowConsumer".into(),
            }))
            .await
            .unwrap();
            while ws.next().await.is_some() {}
        });
        let mut halves = connector.open(&target()).await.unwrap();
        let closed = TransportEvent::Closed {
            code: 4000,
            reason: "slowConsumer".into(),
        };
        assert_eq!(halves.reader.recv().await, closed);
        assert_eq!(halves.reader.recv().await, closed);
    }

    #[tokio::test]
    async fn a_refused_upgrade_is_a_connector_error() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let connector = connector_to(&listener).await;
        tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut tcp, &mut buf).await;
            let _ = tokio::io::AsyncWriteExt::write_all(
                &mut tcp,
                b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n",
            )
            .await;
        });
        assert!(connector.open(&target()).await.is_err());
    }
}
