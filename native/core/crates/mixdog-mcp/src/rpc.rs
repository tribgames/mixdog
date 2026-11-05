//! JSON-RPC 2.0 client over a [`Transport`]. One reader task per connection resolves pending
//! requests by id; a request is bounded by an idle timeout that every progress notification
//! resets, a total ceiling, and a cancel token (which sends `notifications/cancelled`).
//! Server-initiated requests are answered here: `ping` succeeds, everything else (sampling,
//! roots, elicitation) is answered with the typed `unsupported` error.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_rt::TaskClass;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::transport::CloseCause;
use crate::transport::Incoming;
use crate::transport::IncomingRx;
use crate::transport::Transport;

/// JSON-RPC "method not found"; the message is the typed `unsupported` marker.
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const UNSUPPORTED: &str = "unsupported";

/// Far enough that "no timeout" never fires, close enough for the timer wheel.
const FOREVER: Duration = Duration::from_secs(60 * 60 * 24 * 365);

#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
pub enum RpcError {
    #[error("server error {code}: {message}")]
    Server {
        code: i64,
        message: String,
        data: Option<Value>,
    },
    #[error("connection closed: {0}")]
    Closed(String),
    #[error("no response or progress within the call timeout")]
    IdleTimeout,
    #[error("call exceeded its total time limit")]
    TotalTimeout,
    #[error("call cancelled")]
    Cancelled,
    #[error("transport error: {0}")]
    Transport(String),
}

#[derive(Default, Clone, Copy)]
pub struct RequestOptions<'a> {
    /// Idle bound, reset by progress. `None`: unbounded.
    pub idle_timeout: Option<Duration>,
    /// Ceiling regardless of progress. `None`: unbounded.
    pub max_total: Option<Duration>,
    pub cancel: Option<&'a CancellationToken>,
}

struct Pending {
    tx: oneshot::Sender<Result<Value, RpcError>>,
    progress: Arc<Notify>,
}

pub struct RpcClient {
    transport: Arc<dyn Transport>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
    closed: watch::Sender<Option<CloseCause>>,
    tools_changed: Notify,
}

async fn cancelled(token: Option<&CancellationToken>) {
    match token {
        Some(token) => token.cancelled().await,
        None => std::future::pending().await,
    }
}

impl RpcClient {
    /// Starts the reader task over `incoming`.
    pub fn start(transport: Arc<dyn Transport>, incoming: IncomingRx) -> Arc<Self> {
        let (closed, _) = watch::channel(None);
        let client = Arc::new(Self {
            transport,
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            closed,
            tools_changed: Notify::new(),
        });
        mixdog_rt::spawn("mcp.rpc.read", TaskClass::Work, Arc::clone(&client).read_loop(incoming));
        client
    }

    pub fn transport(&self) -> &Arc<dyn Transport> {
        &self.transport
    }

    /// Completes when the connection ends, with the cause.
    pub fn closed(&self) -> watch::Receiver<Option<CloseCause>> {
        self.closed.subscribe()
    }

    pub fn is_closed(&self) -> bool {
        self.closed.borrow().is_some()
    }

    /// Resolves each time the server announced `notifications/tools/list_changed`.
    pub async fn tools_changed(&self) {
        self.tools_changed.notified().await;
    }

    async fn read_loop(self: Arc<Self>, mut incoming: IncomingRx) {
        let cause = loop {
            match incoming.recv().await {
                Some(Incoming::Message(message)) => self.handle(message),
                Some(Incoming::Closed(cause)) => break cause,
                None => {
                    break CloseCause {
                        reason: "transport dropped".to_owned(),
                        stderr_tail: String::new(),
                    };
                }
            }
        };
        let detail = if cause.stderr_tail.is_empty() {
            cause.reason.clone()
        } else {
            format!("{}\n{}", cause.reason, cause.stderr_tail)
        };
        // The cause is published before pending is drained, so a request registered after
        // the drain sees `closed` when it re-checks.
        self.closed.send_replace(Some(cause));
        let drained: Vec<Pending> = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, p)| p)
            .collect();
        for pending in drained {
            let _ = pending.tx.send(Err(RpcError::Closed(detail.clone())));
        }
    }

    fn handle(self: &Arc<Self>, message: Value) {
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").filter(|v| !v.is_null());
        match (method, id) {
            (Some(method), Some(id)) => self.answer_request(method, id.clone()),
            (Some(method), None) => self.handle_notification(method, &message),
            (None, Some(id)) => self.resolve(id, &message),
            (None, None) => {}
        }
    }

    fn answer_request(self: &Arc<Self>, method: &str, id: Value) {
        let reply = if method == "ping" {
            json!({"jsonrpc": "2.0", "id": id, "result": {}})
        } else {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {"code": METHOD_NOT_FOUND, "message": UNSUPPORTED, "data": {"method": method}},
            })
        };
        let transport = Arc::clone(&self.transport);
        mixdog_rt::spawn("mcp.rpc.reply", TaskClass::Work, async move {
            let _ = transport.send(reply).await;
        });
    }

    fn handle_notification(&self, method: &str, message: &Value) {
        match method {
            "notifications/progress" => {
                let token = message
                    .pointer("/params/progressToken")
                    .and_then(Value::as_u64);
                if let Some(token) = token {
                    let progress = self
                        .pending
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .get(&token)
                        .map(|p| Arc::clone(&p.progress));
                    if let Some(progress) = progress {
                        progress.notify_one();
                    }
                }
            }
            "notifications/tools/list_changed" => self.tools_changed.notify_one(),
            _ => {}
        }
    }

    fn resolve(&self, id: &Value, message: &Value) {
        let Some(id) = id.as_u64() else { return };
        let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        let Some(pending) = pending else { return };
        let outcome = match message.get("error") {
            Some(error) => Err(RpcError::Server {
                code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                data: error.get("data").cloned(),
            }),
            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = pending.tx.send(outcome);
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), RpcError> {
        self.transport
            .send(json!({"jsonrpc": "2.0", "method": method, "params": params}))
            .await
            .map_err(|e| RpcError::Transport(e.to_string()))
    }

    pub async fn request(&self, method: &str, params: Value, options: RequestOptions<'_>) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, mut rx) = oneshot::channel();
        let progress = Arc::new(Notify::new());
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, Pending { tx, progress: Arc::clone(&progress) });
        if let Some(cause) = self.closed.borrow().as_ref() {
            self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            return Err(RpcError::Closed(cause.reason.clone()));
        }

        let mut params = params;
        if let Some(map) = params.as_object_mut() {
            let meta = map.entry("_meta").or_insert_with(|| json!({}));
            if let Some(meta) = meta.as_object_mut() {
                meta.insert("progressToken".to_owned(), json!(id));
            }
        }
        let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});

        let outcome = self.drive(message, &mut rx, &progress, options).await;
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        if matches!(outcome, Err(RpcError::IdleTimeout | RpcError::TotalTimeout | RpcError::Cancelled)) {
            let reason = match &outcome {
                Err(RpcError::Cancelled) => "cancelled",
                _ => "timed out",
            };
            let _ = self
                .notify("notifications/cancelled", json!({"requestId": id, "reason": reason}))
                .await;
        }
        outcome
    }

    async fn drive(
        &self,
        message: Value,
        rx: &mut oneshot::Receiver<Result<Value, RpcError>>,
        progress: &Notify,
        options: RequestOptions<'_>,
    ) -> Result<Value, RpcError> {
        let idle_for = options.idle_timeout.unwrap_or(FOREVER);
        let send = self.transport.send(message);
        tokio::pin!(send);
        let mut sent = false;
        let idle = tokio::time::sleep(idle_for);
        tokio::pin!(idle);
        let total = tokio::time::sleep(options.max_total.unwrap_or(FOREVER));
        tokio::pin!(total);
        loop {
            tokio::select! {
                result = &mut send, if !sent => {
                    sent = true;
                    if let Err(error) = result {
                        return Err(RpcError::Transport(error.to_string()));
                    }
                }
                result = &mut *rx => {
                    return result.unwrap_or_else(|_| Err(RpcError::Closed("connection ended".to_owned())));
                }
                () = cancelled(options.cancel) => return Err(RpcError::Cancelled),
                () = progress.notified() => idle.as_mut().reset(Instant::now() + idle_for),
                () = &mut idle => return Err(RpcError::IdleTimeout),
                () = &mut total => return Err(RpcError::TotalTimeout),
            }
        }
    }

    pub async fn close(&self) {
        self.transport.close().await;
    }
}
