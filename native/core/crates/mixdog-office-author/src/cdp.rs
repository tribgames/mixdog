//! A Chrome DevTools Protocol client for the authoring routes: one WebSocket to the shared render browser's endpoint,
//! flat sessions, request/response correlation and an event stream. It is what puppeteer-core's connection was to the
//! Node routes; the page-level calls built on it are in [`crate::page`].
//!
//! Dropping the client closes the connection, and with it every browser context created with `disposeOnDetach`, so a
//! run that is dropped half way leaves nothing open in the browser.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures::SinkExt;
use futures::StreamExt;
use mixdog_rt::TaskClass;
use serde_json::Value;
use serde_json::json;
use tokio::sync::broadcast;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

/// One protocol event: its method, parameters and the session it came from (none for the browser's own).
#[derive(Debug)]
pub struct Event {
    pub method: String,
    pub params: Value,
    pub session: Option<String>,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// A connection to the browser.
pub struct Cdp {
    outgoing: mpsc::UnboundedSender<String>,
    pending: Pending,
    next_id: AtomicU64,
    events: broadcast::Sender<Arc<Event>>,
    closed: watch::Receiver<bool>,
    _tasks: [AbortOnDrop; 2],
}

/// The text a call or a wait fails with once the browser's socket is gone.
pub const CONNECTION_CLOSED: &str = "Connection closed.";

/// The sentence puppeteer's `TimeoutError` carries.
pub fn timed_out(ms: u128) -> String {
    format!("Timed out after waiting {ms}ms")
}

impl Cdp {
    /// Opens the connection to the DevTools WebSocket `endpoint`.
    pub async fn connect(endpoint: &str) -> Result<Self, String> {
        let (socket, _) = tokio_tungstenite::connect_async(endpoint).await.map_err(|error| error.to_string())?;
        let (mut sink, mut stream) = socket.split();
        let (outgoing, mut queue) = mpsc::unbounded_channel::<String>();
        let pending: Pending = Arc::default();
        let (events, _) = broadcast::channel(4096);
        let (close_mark, closed) = watch::channel(false);
        let writer = mixdog_rt::spawn("office-cdp-writer", TaskClass::Work, async move {
            while let Some(text) = queue.recv().await {
                if sink.send(Message::text(text)).await.is_err() {
                    break;
                }
            }
        });
        let reader = {
            let pending = pending.clone();
            let events = events.clone();
            mixdog_rt::spawn("office-cdp-reader", TaskClass::Work, async move {
                while let Some(Ok(message)) = stream.next().await {
                    let Message::Text(text) = message else { continue };
                    let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                    if let Some(id) = frame.get("id").and_then(Value::as_u64) {
                        let reply = match frame.get("error") {
                            Some(error) => Err(error.get("message").and_then(Value::as_str).unwrap_or("protocol error").to_string()),
                            None => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let waiter = pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
                        if let Some(waiter) = waiter {
                            let _ = waiter.send(reply);
                        }
                    } else if let Some(method) = frame.get("method").and_then(Value::as_str) {
                        let _ = events.send(Arc::new(Event {
                            method: method.to_string(),
                            params: frame.get("params").cloned().unwrap_or(Value::Null),
                            session: frame.get("sessionId").and_then(Value::as_str).map(str::to_string),
                        }));
                    }
                }
                close_mark.send_replace(true);
                let waiters: Vec<_> = pending.lock().unwrap_or_else(|p| p.into_inner()).drain().collect();
                for (_, waiter) in waiters {
                    let _ = waiter.send(Err(CONNECTION_CLOSED.to_string()));
                }
            })
        };
        Ok(Self {
            outgoing,
            pending,
            next_id: AtomicU64::new(1),
            events,
            closed,
            _tasks: [AbortOnDrop(writer), AbortOnDrop(reader)],
        })
    }

    /// A receiver of every event from now on. Subscribe before the call whose events are awaited.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Event>> {
        self.events.subscribe()
    }

    /// Sends `method` (to `session`'s page, or the browser itself without one) and returns its `result`; a protocol
    /// error is the text puppeteer throws: `Protocol error (method): message`.
    pub async fn send(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, String> {
        let failed = |message: &str| format!("Protocol error ({method}): {message}");
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply, answer) = oneshot::channel();
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).insert(id, reply);
        let mut frame = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            frame["sessionId"] = json!(session);
        }
        if self.outgoing.send(frame.to_string()).is_err() {
            self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
            return Err(failed(CONNECTION_CLOSED));
        }
        match answer.await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(message)) => Err(failed(&message)),
            Err(_) => Err(failed(CONNECTION_CLOSED)),
        }
    }

    /// The first event `want` accepts, or an error when the socket closes first or `limit` passes.
    pub async fn wait_event(
        &self,
        events: &mut broadcast::Receiver<Arc<Event>>,
        limit: Duration,
        mut want: impl FnMut(&Event) -> bool,
    ) -> Result<Arc<Event>, String> {
        let mut closed = self.closed.clone();
        let wait = async {
            loop {
                tokio::select! {
                    event = events.recv() => match event {
                        Ok(event) if want(&event) => return Ok(event),
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => return Err(CONNECTION_CLOSED.to_string()),
                    },
                    // The guard `wait_for` hands back is dropped at once: it must not live across a later await.
                    () = async { let _ = closed.wait_for(|gone| *gone).await; } => return Err(CONNECTION_CLOSED.to_string()),
                }
            }
        };
        mixdog_rt::time::timeout(limit, wait).await.unwrap_or_else(|_| Err(timed_out(limit.as_millis())))
    }
}
