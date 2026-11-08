//! Every shared conformance scenario against the engine over the in-process transport (`InProcessConnector`), with a test
//! server end that plays the scripted peer.

use crate::common;

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use async_trait::async_trait;
use common::{Net, ServerConn};
use mixdog_app_server_client::{
    Connector, Json,
    inprocess::{FromClient, InProcessConnector, ServerEnd, ServerSender},
};
use tokio::{sync::mpsc, task::JoinHandle};

struct InConn {
    from_client: Mutex<Option<mpsc::UnboundedReceiver<String>>>,
    queued: Arc<AtomicUsize>,
    sender: ServerSender,
    client_close: Arc<Mutex<Option<u16>>>,
    server_closed: Arc<Mutex<bool>>,
    pump: JoinHandle<()>,
}

impl InConn {
    fn serve(mut end: ServerEnd) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let queued = Arc::new(AtomicUsize::new(0));
        let client_close = Arc::new(Mutex::new(None));
        let server_closed = Arc::new(Mutex::new(false));
        let pump = tokio::spawn({
            let (queued, client_close, server_closed) =
                (queued.clone(), client_close.clone(), server_closed.clone());
            async move {
                while let Some(m) = end.from_client.recv().await {
                    match m {
                        FromClient::Frame(t) => {
                            queued.fetch_add(1, Ordering::SeqCst);
                            let _ = tx.send(t);
                        }
                        FromClient::Closed { code, .. } => {
                            if !*server_closed.lock().unwrap() {
                                *client_close.lock().unwrap() = Some(code);
                            }
                        }
                    }
                }
            }
        });
        Self {
            from_client: Mutex::new(Some(rx)),
            queued,
            sender: end.sender,
            client_close,
            server_closed,
            pump,
        }
    }
}

impl Drop for InConn {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

#[async_trait]
impl ServerConn for InConn {
    async fn next_sent(&self) -> String {
        let mut rx = self.from_client.lock().unwrap().take().expect("one waiter");
        let t = rx.recv().await.expect("client connection ended");
        *self.from_client.lock().unwrap() = Some(rx);
        self.queued.fetch_sub(1, Ordering::SeqCst);
        t
    }
    fn queued(&self) -> usize {
        self.queued.load(Ordering::SeqCst)
    }
    fn server_send(&self, frame: &Json) {
        self.sender.send(frame.to_string());
    }
    fn server_send_raw(&self, text: &str) {
        self.sender.send(text.to_string());
    }
    fn server_close(&self, code: u16, reason: &str) {
        *self.server_closed.lock().unwrap() = true;
        self.sender.close(code, reason);
    }
    fn client_close(&self) -> Option<u16> {
        *self.client_close.lock().unwrap()
    }
}

struct InNet {
    connector: Arc<InProcessConnector>,
    accepted: Mutex<Option<mpsc::UnboundedReceiver<InConn>>>,
    fail: Arc<AtomicUsize>,
}

impl InNet {
    fn new() -> Self {
        let fail = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = mpsc::unbounded_channel();
        let connector = InProcessConnector::new(Arc::new({
            let fail = fail.clone();
            move |end: ServerEnd| {
                if fail
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                    .is_ok()
                {
                    return Err("refused".to_string());
                }
                let _ = tx.send(InConn::serve(end));
                Ok(())
            }
        }));
        Self {
            connector: Arc::new(connector),
            accepted: Mutex::new(Some(rx)),
            fail,
        }
    }
}

#[async_trait]
impl Net for InNet {
    fn connector(&self) -> Arc<dyn Connector> {
        self.connector.clone()
    }
    async fn accept(&self) -> Box<dyn ServerConn> {
        let mut rx = self.accepted.lock().unwrap().take().expect("one waiter");
        let c = rx.recv().await.expect("connector dropped");
        *self.accepted.lock().unwrap() = Some(rx);
        Box::new(c)
    }
    fn fail_next(&self, n: usize) {
        self.fail.store(n, Ordering::SeqCst);
    }
    async fn settle(&self) {
        for _ in 0..60 {
            tokio::task::yield_now().await;
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn conformance_scenarios_in_process() {
    common::run_all(|| async { Arc::new(InNet::new()) as Arc<dyn Net> }).await;
}
