//! Every shared conformance scenario against the engine over a real loopback WebSocket (`WsConnector`), with a test server
//! that plays the scripted peer.
//!
//! "Nothing happened" assertions cannot be decided by yielding on a real socket; `settle` therefore waits a short real
//! interval. Every positive wait (a frame, a connection) is event driven.

mod common;

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
    sync::{Mutex as AsyncMutex, mpsc},
    task::JoinHandle,
};
use tokio_tungstenite::{
    accept_async,
    tungstenite::{
        Message,
        protocol::{CloseFrame, frame::coding::CloseCode},
    },
};

/// How long `settle` lets in-flight frames land on loopback.
const SETTLE: Duration = Duration::from_millis(40);
/// Close code for "end the socket without a close handshake".
const ABNORMAL: u16 = 1006;

enum Out {
    Text(String),
    Close { code: u16, reason: String },
}

struct WsConn {
    from_client: AsyncMutex<mpsc::UnboundedReceiver<String>>,
    queued: Arc<AtomicUsize>,
    out: mpsc::UnboundedSender<Out>,
    client_close: Arc<Mutex<Option<u16>>>,
    server_closed: Arc<Mutex<bool>>,
    tasks: Vec<JoinHandle<()>>,
}

#[async_trait]
impl ServerConn for WsConn {
    async fn next_sent(&self) -> String {
        let t = self
            .from_client
            .lock()
            .await
            .recv()
            .await
            .expect("client connection ended");
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
            let _ = self.out.send(Out::Close {
                code,
                reason: reason.to_string(),
            });
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
    accepted: AsyncMutex<mpsc::UnboundedReceiver<WsConn>>,
    fail: Arc<AtomicUsize>,
    listener_task: JoinHandle<()>,
}

impl WsNet {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let fail = Arc::new(AtomicUsize::new(0));
        let (accepted_tx, accepted) = mpsc::unbounded_channel();
        let listener_task = tokio::spawn({
            let fail = fail.clone();
            async move {
                loop {
                    let (tcp, _) = listener.accept().await.unwrap();
                    if fail
                        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                        .is_ok()
                    {
                        drop(tcp); // the upgrade never completes: the client's open fails
                        continue;
                    }
                    let Ok(ws) = accept_async(tcp).await else { continue };
                    let _ = accepted_tx.send(WsConn::serve(ws));
                }
            }
        });
        Self {
            connector: Arc::new(WsConnector::new(Arc::new(FixedEndpoint(Endpoint {
                port,
                token: "t".into(),
            })))),
            accepted: AsyncMutex::new(accepted),
            fail,
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

        let reader = tokio::spawn({
            let (queued, client_close, server_closed) =
                (queued.clone(), client_close.clone(), server_closed.clone());
            async move {
                while let Some(Ok(message)) = stream.next().await {
                    match message {
                        Message::Text(t) => {
                            queued.fetch_add(1, Ordering::SeqCst);
                            let _ = to_test.send(t.to_string());
                        }
                        // A close that answers the server's own close is the handshake echo, not the client's decision.
                        Message::Close(frame) => {
                            if !*server_closed.lock().unwrap() {
                                *client_close.lock().unwrap() =
                                    Some(frame.map_or(1005, |f| u16::from(f.code)));
                            }
                        }
                        _ => {}
                    }
                }
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
                    Out::Close { code, reason } => {
                        let frame = CloseFrame {
                            code: CloseCode::from(code),
                            reason: reason.into(),
                        };
                        let _ = sink.send(Message::Close(Some(frame))).await;
                        // Keep the sink alive so the client's echo can arrive; the reader task ends with the socket.
                        std::future::pending::<()>().await;
                    }
                }
            }
        });
        Self {
            from_client: AsyncMutex::new(from_client),
            queued,
            out,
            client_close,
            server_closed,
            tasks: vec![reader, writer],
        }
    }
}

#[async_trait]
impl Net for WsNet {
    fn connector(&self) -> Arc<dyn Connector> {
        self.connector.clone()
    }
    async fn accept(&self) -> Box<dyn ServerConn> {
        Box::new(
            self.accepted
                .lock()
                .await
                .recv()
                .await
                .expect("listener ended"),
        )
    }
    fn fail_next(&self, n: usize) {
        self.fail.store(n, Ordering::SeqCst);
    }
    async fn settle(&self) {
        tokio::time::sleep(SETTLE).await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn conformance_scenarios_over_websocket() {
    common::run_all(|| async { Arc::new(WsNet::start().await) as Arc<dyn Net> }).await;
}
