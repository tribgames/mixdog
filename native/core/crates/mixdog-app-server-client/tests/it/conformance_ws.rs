use crate::common;

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use common::{Net, ServerConn};
use futures::{SinkExt, StreamExt};
use mixdog_app_server_client::{
    Connector, Json,
    discovery::Endpoint,
    ws::{FixedEndpoint, WsConnector},
};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot},
    task::JoinHandle,
};
use tokio_tungstenite::{
    accept_async,
    tungstenite::{
        Message,
        protocol::{CloseFrame, frame::coding::CloseCode},
    },
};

/// How long `settle` lets in-flight client frames land on loopback.
const SETTLE: Duration = Duration::from_millis(40);
/// The longest `settle` waits for the client to read up to its ping.
const BARRIER: Duration = Duration::from_secs(10);

/// The server side of the latest connection as `settle` reaches it: a ping the client answers once it has read every
/// frame before it.
#[derive(Clone)]
struct Barrier {
    out: mpsc::UnboundedSender<Out>,
    server_closed: Arc<Mutex<bool>>,
}
/// Close code for "end the socket without a close handshake".
const ABNORMAL: u16 = 1006;

enum Out {
    Text(String),
    Close {
        code: u16,
        reason: String,
    },
    /// A ping; `answered` is told when its pong arrives, and dropped when the socket ends first.
    Ping {
        answered: oneshot::Sender<()>,
    },
}

struct WsConn {
    /// The test peer is single-waiter: a waiter takes the receiver for its await and puts it back.
    from_client: Mutex<Option<mpsc::UnboundedReceiver<String>>>,
    queued: Arc<AtomicUsize>,
    out: mpsc::UnboundedSender<Out>,
    client_close: Arc<Mutex<Option<u16>>>,
    server_closed: Arc<Mutex<bool>>,
    tasks: Vec<JoinHandle<()>>,
}

#[async_trait]
impl ServerConn for WsConn {
    async fn next_sent(&self) -> String {
        let mut from_client = self.from_client.lock().unwrap().take().expect("one waiter at a time");
        let t = from_client.recv().await.expect("client connection ended");
        *self.from_client.lock().unwrap() = Some(from_client);
        self.queued.fetch_sub(1, Ordering::SeqCst);
        t
    }
    fn queued(&self) -> usize {
        self.queued.load(Ordering::SeqCst)
    }
    fn server_send(&self, frame: &Json) {
        let _ = self.out.send(Out::Text(frame.to_string()));
    }
    fn server_send_raw(&self, text: &str) {
        let _ = self.out.send(Out::Text(text.to_string()));
    }
    fn server_close(&self, code: u16, reason: &str) {
        *self.server_closed.lock().unwrap() = true;
        if code == ABNORMAL {
            for t in &self.tasks {
                t.abort();
            }
        } else {
            let _ = self.out.send(Out::Close { code, reason: reason.to_string() });
        }
    }
    fn client_close(&self) -> Option<u16> {
        *self.client_close.lock().unwrap()
    }
}

impl Drop for WsConn {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

struct WsNet {
    connector: Arc<WsConnector>,
    /// Single-waiter, as `WsConn::from_client`.
    accepted: Mutex<Option<mpsc::UnboundedReceiver<WsConn>>>,
    fail: Arc<AtomicUsize>,
    latest: Arc<Mutex<Option<Barrier>>>,
    listener_task: JoinHandle<()>,
}

impl WsNet {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let fail = Arc::new(AtomicUsize::new(0));
        let (accepted_tx, accepted) = mpsc::unbounded_channel();
        let latest = Arc::new(Mutex::new(None));
        let listener_task = tokio::spawn({
            let (fail, latest) = (fail.clone(), latest.clone());
            async move {
                loop {
                    let (tcp, _) = listener.accept().await.unwrap();
                    if fail.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok() {
                        drop(tcp); // the upgrade never completes: the client's open fails
                        continue;
                    }
                    let Ok(ws) = accept_async(tcp).await else { continue };
                    let conn = WsConn::serve(ws);
                    *latest.lock().unwrap() = Some(Barrier { out: conn.out.clone(), server_closed: conn.server_closed.clone() });
                    let _ = accepted_tx.send(conn);
                }
            }
        });
        Self {
            connector: Arc::new(WsConnector::new(Arc::new(FixedEndpoint(Endpoint { port, token: "t".into() })))),
            accepted: Mutex::new(Some(accepted)),
            fail,
            latest,
            listener_task,
        }
    }
}

impl Drop for WsNet {
    fn drop(&mut self) {
        self.listener_task.abort();
    }
}

impl WsConn {
    fn serve(ws: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> Self {
        let (mut sink, mut stream) = ws.split();
        let (to_test, from_client) = mpsc::unbounded_channel();
        let (out, mut out_rx) = mpsc::unbounded_channel::<Out>();
        let queued = Arc::new(AtomicUsize::new(0));
        let client_close = Arc::new(Mutex::new(None));
        let server_closed = Arc::new(Mutex::new(false));
        // The pings awaiting their pong; none once the client's side has ended.
        let pings: Arc<Mutex<Option<std::collections::VecDeque<oneshot::Sender<()>>>>> = Arc::new(Mutex::new(Some(Default::default())));

        let reader = tokio::spawn({
            let (queued, client_close, server_closed, pings) = (queued.clone(), client_close.clone(), server_closed.clone(), pings.clone());
            async move {
                while let Some(Ok(message)) = stream.next().await {
                    match message {
                        Message::Text(t) => {
                            queued.fetch_add(1, Ordering::SeqCst);
                            let _ = to_test.send(t.to_string());
                        }
                        Message::Pong(_) => {
                            if let Some(answered) = pings.lock().unwrap().as_mut().and_then(std::collections::VecDeque::pop_front) {
                                let _ = answered.send(());
                            }
                        }
                        // A close that answers the server's own close is the handshake echo, not the client's decision.
                        Message::Close(frame) if !*server_closed.lock().unwrap() => {
                            *client_close.lock().unwrap() = Some(frame.map_or(1005, |f| u16::from(f.code)));
                        }
                        _ => {}
                    }
                }
                *pings.lock().unwrap() = None;
            }
        });
        let writer = tokio::spawn(async move {
            while let Some(cmd) = out_rx.recv().await {
                match cmd {
                    Out::Text(t) => {
                        if sink.send(Message::text(t)).await.is_err() {
                            return;
                        }
                    }
                    Out::Ping { answered } => {
                        {
                            let mut pings = pings.lock().unwrap();
                            let Some(waiting) = pings.as_mut() else { continue };
                            waiting.push_back(answered);
                        }
                        if sink.send(Message::Ping(Default::default())).await.is_err() {
                            *pings.lock().unwrap() = None;
                            return;
                        }
                    }
                    Out::Close { code, reason } => {
                        let frame = CloseFrame { code: CloseCode::from(code), reason: reason.into() };
                        let _ = sink.send(Message::Close(Some(frame))).await;
                        // Keep the sink alive so the client's echo can arrive; the reader task ends with the socket.
                        std::future::pending::<()>().await;
                    }
                }
            }
        });
        Self { from_client: Mutex::new(Some(from_client)), queued, out, client_close, server_closed, tasks: vec![reader, writer] }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn conformance_scenarios_over_websocket() {
    common::run_all(|| async { Arc::new(WsNet::start().await) as Arc<dyn Net> }).await;
}

#[async_trait]
impl Net for WsNet {
    fn connector(&self) -> Arc<dyn Connector> {
        self.connector.clone()
    }
    async fn accept(&self) -> Box<dyn ServerConn> {
        let mut accepted = self.accepted.lock().unwrap().take().expect("one waiter at a time");
        let conn = accepted.recv().await.expect("listener ended");
        *self.accepted.lock().unwrap() = Some(accepted);
        Box::new(conn)
    }
    fn fail_next(&self, n: usize) {
        self.fail.store(n, Ordering::SeqCst);
    }
    /// Client frames get [`SETTLE`] to land. The server's own frames have reached the client once it has read up to a
    /// ping sent after them: it answers on its next read, which it makes only after handing over the frames before. A
    /// socket that ends first has nothing more to hand over; one that stays open without answering fails the test.
    async fn settle(&self) {
        mixdog_rt::time::sleep(SETTLE).await;
        let barrier = self.latest.lock().unwrap().clone();
        let Some(barrier) = barrier.filter(|b| !*b.server_closed.lock().unwrap()) else { return };
        let (answered, pong) = oneshot::channel();
        if barrier.out.send(Out::Ping { answered }).is_err() {
            return;
        }
        // The pong, or the socket's end (the waiter dropped), both settle; only the wait running out does not.
        assert!(mixdog_rt::time::timeout(BARRIER, pong).await.is_ok(), "the client left the ping unanswered for {BARRIER:?} on an open connection");
    }
}
