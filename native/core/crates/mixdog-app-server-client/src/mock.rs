//! Mock transport for the conformance suite: a scripted peer behind the `Connector` seam.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::api::*;

/// A receiver one waiter at a time reads from. The receiver is taken out for the wait, so no lock is held across it.
struct Inbox<T>(Mutex<Option<mpsc::UnboundedReceiver<T>>>);

impl<T> Inbox<T> {
    fn new(rx: mpsc::UnboundedReceiver<T>) -> Self {
        Self(Mutex::new(Some(rx)))
    }
    async fn recv(&self) -> Option<T> {
        let mut rx = self
            .0
            .lock()
            .unwrap()
            .take()
            .expect("one waiter at a time");
        let item = rx.recv().await;
        *self.0.lock().unwrap() = Some(rx);
        item
    }
}

/// The server side of one mock connection.
pub struct MockConn {
    from_client: Inbox<String>,
    to_client: mpsc::UnboundedSender<TransportEvent>,
    closed: Arc<AtomicBool>,
    client_close: Arc<Mutex<Option<u16>>>,
    queued: Arc<AtomicUsize>,
}

impl MockConn {
    /// Next frame the client wrote.
    pub async fn next_sent(&self) -> String {
        let t = self
            .from_client
            .recv()
            .await
            .expect("client dropped the mock connection");
        self.queued.fetch_sub(1, Ordering::SeqCst);
        t
    }
    pub fn queued(&self) -> usize {
        self.queued.load(Ordering::SeqCst)
    }
    pub fn server_send(&self, frame: &Json) {
        let _ = self
            .to_client
            .send(TransportEvent::Frame(frame.to_string()));
    }
    /// A frame as raw text, for payloads that are not valid JSON.
    pub fn server_send_raw(&self, text: &str) {
        let _ = self.to_client.send(TransportEvent::Frame(text.to_string()));
    }
    pub fn server_close(&self, code: u16, reason: &str) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            let _ = self.to_client.send(TransportEvent::Closed {
                code,
                reason: reason.to_string(),
            });
        }
    }
    /// Close code the client sent, if it closed the socket.
    pub fn client_close(&self) -> Option<u16> {
        *self.client_close.lock().unwrap()
    }
}

struct Writer {
    to_server: mpsc::UnboundedSender<String>,
    to_client: mpsc::UnboundedSender<TransportEvent>,
    closed: Arc<AtomicBool>,
    client_close: Arc<Mutex<Option<u16>>>,
    queued: Arc<AtomicUsize>,
}
struct Reader(mpsc::UnboundedReceiver<TransportEvent>);

#[async_trait]
impl TransportWriter for Writer {
    async fn send(&mut self, text: String) -> Result<(), TransportClosed> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(TransportClosed);
        }
        self.queued.fetch_add(1, Ordering::SeqCst);
        self.to_server.send(text).map_err(|_| TransportClosed)
    }
    async fn close(&mut self, code: u16, reason: String) {
        *self.client_close.lock().unwrap() = Some(code);
        if !self.closed.swap(true, Ordering::SeqCst) {
            let _ = self.to_client.send(TransportEvent::Closed { code, reason });
        }
    }
}
#[async_trait]
impl TransportReader for Reader {
    async fn recv(&mut self) -> TransportEvent {
        self.0.recv().await.unwrap_or(TransportEvent::Closed {
            code: 1006,
            reason: "mock dropped".into(),
        })
    }
}

pub struct MockNetwork {
    fail_next: AtomicUsize,
    opens: AtomicUsize,
    opened_tx: mpsc::UnboundedSender<MockConn>,
    opened_rx: Inbox<MockConn>,
}

impl Default for MockNetwork {
    fn default() -> Self {
        let (opened_tx, opened_rx) = mpsc::unbounded_channel();
        Self {
            fail_next: AtomicUsize::new(0),
            opens: AtomicUsize::new(0),
            opened_tx,
            opened_rx: Inbox::new(opened_rx),
        }
    }
}

impl MockNetwork {
    /// The next `n` opens fail.
    pub fn fail_next(&self, n: usize) {
        self.fail_next.store(n, Ordering::SeqCst);
    }
    /// Connections the client has opened so far.
    pub fn opened(&self) -> usize {
        self.opens.load(Ordering::SeqCst)
    }
    /// The next connection the client opened (in order).
    pub async fn accept(&self) -> MockConn {
        self.opened_rx
            .recv()
            .await
            .expect("network dropped")
    }
}

#[async_trait]
impl Connector for MockNetwork {
    async fn open(&self, _target: &Target) -> Result<TransportHalves, String> {
        if self.fail_next.load(Ordering::SeqCst) > 0 {
            self.fail_next.fetch_sub(1, Ordering::SeqCst);
            return Err("mock open failure".into());
        }
        self.opens.fetch_add(1, Ordering::SeqCst);
        let (to_server, from_client) = mpsc::unbounded_channel();
        let (to_client, events) = mpsc::unbounded_channel();
        let closed = Arc::new(AtomicBool::new(false));
        let client_close = Arc::new(Mutex::new(None));
        let queued = Arc::new(AtomicUsize::new(0));
        let conn = MockConn {
            from_client: Inbox::new(from_client),
            to_client: to_client.clone(),
            closed: closed.clone(),
            client_close: client_close.clone(),
            queued: queued.clone(),
        };
        let _ = self.opened_tx.send(conn);
        Ok(TransportHalves {
            writer: Box::new(Writer {
                to_server,
                to_client,
                closed,
                client_close,
                queued,
            }),
            reader: Box::new(Reader(events)),
        })
    }
}
