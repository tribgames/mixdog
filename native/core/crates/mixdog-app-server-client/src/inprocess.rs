//! In-process transport: the client and the server core share a process, so frames cross a channel instead of a socket
//! (protocol.md §2.1: `app-server-client` in-process mode). The server side stays behind [`ServerEnd`]; the app-server's
//! acceptor turns it into a connection with Origin `InProcess` and applies its own admission, byte budgets and lanes.
//!
//! The client-to-server direction is bounded, so a server that stops reading pushes back on the writer. The server-to-client
//! direction never blocks the server (its writer never waits): the server's own byte budget bounds it.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::api::{
    Connector, Target, TransportClosed, TransportEvent, TransportHalves, TransportReader,
    TransportWriter,
};

/// Frames queued toward the server before the client's writer waits.
const TO_SERVER_QUEUE: usize = 256;

/// What the server reads from the client.
#[derive(Debug, PartialEq, Eq)]
pub enum FromClient {
    Frame(String),
    /// The client closed the connection (`close`, or its handle dropped: 1006).
    Closed { code: u16, reason: String },
}

/// The server's handle for sending to the client and closing the connection. Cheap to clone; never blocks.
#[derive(Clone)]
pub struct ServerSender {
    to_client: mpsc::UnboundedSender<TransportEvent>,
    closed: Arc<AtomicBool>,
}

impl ServerSender {
    /// `false` once the connection is closed from either side.
    pub fn send(&self, frame: String) -> bool {
        !self.closed.load(Ordering::Acquire)
            && self.to_client.send(TransportEvent::Frame(frame)).is_ok()
    }

    /// Delivers the client its one `Closed` event; later sends fail.
    pub fn close(&self, code: u16, reason: &str) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            let _ = self.to_client.send(TransportEvent::Closed {
                code,
                reason: reason.to_string(),
            });
        }
    }
}

/// The server half of one in-process connection.
pub struct ServerEnd {
    pub from_client: mpsc::Receiver<FromClient>,
    pub sender: ServerSender,
}

struct Writer {
    to_server: mpsc::Sender<FromClient>,
    server: ServerSender,
}

#[async_trait]
impl TransportWriter for Writer {
    async fn send(&mut self, text: String) -> Result<(), TransportClosed> {
        if self.server.closed.load(Ordering::Acquire) {
            return Err(TransportClosed);
        }
        self.to_server
            .send(FromClient::Frame(text))
            .await
            .map_err(|_| TransportClosed)
    }

    async fn close(&mut self, code: u16, reason: String) {
        // Whoever closes first decides: the server may already have closed.
        if !self.server.closed.swap(true, Ordering::AcqRel) {
            let _ = self.server.to_client.send(TransportEvent::Closed {
                code,
                reason: reason.clone(),
            });
            let _ = self.to_server.send(FromClient::Closed { code, reason }).await;
        }
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        // A dropped client without `close` is an abnormal end the server must see.
        if !self.server.closed.swap(true, Ordering::AcqRel) {
            let _ = self.to_server.try_send(FromClient::Closed {
                code: 1006,
                reason: "client dropped".into(),
            });
        }
    }
}

struct Reader(mpsc::UnboundedReceiver<TransportEvent>);

#[async_trait]
impl TransportReader for Reader {
    async fn recv(&mut self) -> TransportEvent {
        self.0.recv().await.unwrap_or(TransportEvent::Closed {
            code: 1006,
            reason: "server dropped".into(),
        })
    }
}

/// One connected pair: the client halves for `Connector::open`, the server end for the acceptor.
pub fn pair() -> (TransportHalves, ServerEnd) {
    let (to_server, from_client) = mpsc::channel(TO_SERVER_QUEUE);
    let (to_client, events) = mpsc::unbounded_channel();
    let sender = ServerSender {
        to_client,
        closed: Arc::new(AtomicBool::new(false)),
    };
    let halves = TransportHalves {
        writer: Box::new(Writer {
            to_server,
            server: sender.clone(),
        }),
        reader: Box::new(Reader(events)),
    };
    (halves, ServerEnd { from_client, sender })
}

/// The server's entry for new in-process connections. `Err` refuses (not serving, shutting down) and surfaces as
/// `ClientError::Connector`.
pub type Acceptor = dyn Fn(ServerEnd) -> Result<(), String> + Send + Sync;

pub struct InProcessConnector {
    accept: Arc<Acceptor>,
}

impl InProcessConnector {
    pub fn new(accept: Arc<Acceptor>) -> Self {
        Self { accept }
    }
}

#[async_trait]
impl Connector for InProcessConnector {
    async fn open(&self, _target: &Target) -> Result<TransportHalves, String> {
        let (halves, end) = pair();
        (self.accept)(end)?;
        Ok(halves)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_cross_both_ways_and_client_close_reaches_both_sides() {
        let (mut halves, mut end) = pair();
        halves.writer.send("a".into()).await.unwrap();
        assert_eq!(end.from_client.recv().await, Some(FromClient::Frame("a".into())));

        assert!(end.sender.send("b".into()));
        assert_eq!(halves.reader.recv().await, TransportEvent::Frame("b".into()));

        halves.writer.close(1000, "bye".into()).await;
        assert_eq!(
            halves.reader.recv().await,
            TransportEvent::Closed {
                code: 1000,
                reason: "bye".into()
            }
        );
        assert_eq!(
            end.from_client.recv().await,
            Some(FromClient::Closed {
                code: 1000,
                reason: "bye".into()
            })
        );
        assert!(!end.sender.send("late".into()));
        assert!(halves.writer.send("late".into()).await.is_err());
    }

    #[tokio::test]
    async fn server_close_is_delivered_once_and_stops_the_writer() {
        let (mut halves, end) = pair();
        end.sender.close(1001, "going away");
        end.sender.close(1002, "ignored");
        assert_eq!(
            halves.reader.recv().await,
            TransportEvent::Closed {
                code: 1001,
                reason: "going away".into()
            }
        );
        assert!(halves.writer.send("x".into()).await.is_err());
    }

    #[tokio::test]
    async fn a_dropped_client_is_an_abnormal_close_for_the_server() {
        let (halves, mut end) = pair();
        drop(halves);
        assert_eq!(
            end.from_client.recv().await,
            Some(FromClient::Closed {
                code: 1006,
                reason: "client dropped".into()
            })
        );
    }
}
