//! A minimal Chrome DevTools Protocol client: one WebSocket to the browser
//! endpoint, flat sessions, request/response correlation and an event stream.
//! Dropping the client closes the connection.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use futures::SinkExt;
use futures::StreamExt;
use serde_json::Value;
use serde_json::json;
use tokio::sync::broadcast;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

use super::error::FetchError;
use super::error::FetchKind;

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

pub struct Cdp {
    outgoing: mpsc::UnboundedSender<String>,
    pending: Pending,
    next_id: AtomicU64,
    events: broadcast::Sender<Arc<Event>>,
    _tasks: [AbortOnDrop; 2],
}

fn closed() -> String {
    "browser connection closed".to_string()
}

impl Cdp {
    pub async fn connect(endpoint: &str) -> Result<Self, String> {
        let (socket, _) = tokio_tungstenite::connect_async(endpoint)
            .await
            .map_err(|error| error.to_string())?;
        let (mut sink, mut stream) = socket.split();
        let (outgoing, mut queue) = mpsc::unbounded_channel::<String>();
        let pending: Pending = Arc::default();
        let (events, _) = broadcast::channel(4096);
        let writer = tokio::spawn(async move {
            while let Some(text) = queue.recv().await {
                if sink.send(Message::text(text)).await.is_err() {
                    break;
                }
            }
        });
        let reader = {
            let pending = pending.clone();
            let events = events.clone();
            tokio::spawn(async move {
                while let Some(Ok(message)) = stream.next().await {
                    let Message::Text(text) = message else { continue };
                    let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                    if let Some(id) = frame.get("id").and_then(Value::as_u64) {
                        let reply = match frame.get("error") {
                            Some(error) => Err(error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("protocol error")
                                .to_string()),
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
                let waiters: Vec<_> = pending.lock().unwrap_or_else(|p| p.into_inner()).drain().collect();
                for (_, waiter) in waiters {
                    let _ = waiter.send(Err(closed()));
                }
            })
        };
        Ok(Self {
            outgoing,
            pending,
            next_id: AtomicU64::new(1),
            events,
            _tasks: [AbortOnDrop(writer), AbortOnDrop(reader)],
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Event>> {
        self.events.subscribe()
    }

    pub async fn send(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, FetchError> {
        let failed = |message: String| FetchError::new(FetchKind::Network, format!("browser {method}: {message}"));
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply, answer) = oneshot::channel();
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).insert(id, reply);
        let mut frame = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            frame["sessionId"] = json!(session);
        }
        if self.outgoing.send(frame.to_string()).is_err() {
            self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
            return Err(failed(closed()));
        }
        match answer.await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(message)) => Err(failed(message)),
            Err(_) => Err(failed(closed())),
        }
    }
}
