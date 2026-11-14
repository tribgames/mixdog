//! The model proxy as the core serves it (DS §12.4).
//!
//! * `modelProxy/run` (this core is the PC): [`ProxyRunner`] runs the call on this machine's own
//!   providers; its events go to the asking connection as `modelProxy/run/event`, and a failed call is
//!   the result `Failed` (the error vocabulary has no place for a `ProxyFailure`).
//! * `model/proxy/event` (this core is the server): one event of a `model/proxy/execute` request,
//!   handed to the host channel, which matches it to the pending request.
//! * `model/proxy/heartbeat` (this core is the server): the PC vouches for the requests it runs; the
//!   first claims a request, each renews its lease (Node's claim and heartbeat operations).
//! * [`HostProxyTransport`]: `model/proxy/execute` to the connection that declared
//!   `capabilities.modelProxy`, as the broker's [`ModelProxyTransport`].

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use mixdog_ai::broker::{ModelProxyTransport, ProxyError};
use mixdog_app_protocol::v2::host::{ModelProxyResult, ModelProxyRunEventParams, ModelProxyRunParams};
use mixdog_app_protocol::v2::model_proxy as w;
use mixdog_core_api::ids::{ConnectionId, Method};
use mixdog_core_api::service::Admit;
use mixdog_core_api::{Caller, ConnectionNotifier, CoreError, CoreRequest, DomainService, HostCapability, HostChannel, HostError, Reply, model_proxy_unavailable_text};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError};

use super::model_proxy::{ProxyEvents, ProxyRunner, busy, failure_out, request_too_large};

const RUN: &str = "modelProxy/run";
const EVENT: &str = "model/proxy/event";
const HEARTBEAT: &str = "model/proxy/heartbeat";
const CANCEL: &str = "modelProxy/cancel";
const EXECUTE: Method = Method("model/proxy/execute");
/// The connection id of the runs `run_local` tracks: connection ids count up from 0, so none ever reaches it.
const LOCAL: ConnectionId = ConnectionId(u64::MAX);
const RUN_EVENT: Method = Method("modelProxy/run/event");

/// `model/proxy/execute` over the host channel.
pub struct HostProxyTransport {
    pub host: Arc<dyn HostChannel>,
}

#[async_trait]
impl ModelProxyTransport for HostProxyTransport {
    async fn execute(&self, call: Value, events: &mut (dyn FnMut(Value) + Send), cancel: &CancellationToken) -> Result<Value, ProxyError> {
        let request = self.host.request_streamed(HostCapability::ModelProxy, EXECUTE, json!({ "call": call }), events);
        // Biased: a call already cancelled is cancelled even when the request settles in the same poll.
        let reply = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(ProxyError::Cancelled),
            reply = request => reply,
        };
        match reply {
            Ok(mut result) => {
                let answer = result.get_mut("result").map(Value::take).unwrap_or(Value::Null);
                match answer.get("result").and_then(Value::as_str) {
                    Some("failed") => Err(ProxyError::Remote(answer.get("failure").cloned().unwrap_or(Value::Null))),
                    _ => Ok(answer),
                }
            }
            Err(HostError::Rpc { data, message, .. }) => Err(ProxyError::Remote(data.unwrap_or(Value::String(message)))),
            Err(HostError::Core(error @ CoreError::CapabilityUnavailable { .. })) => Err(ProxyError::Unavailable(model_proxy_unavailable_text(&error).to_owned())),
            Err(HostError::Core(_)) => Err(ProxyError::Cancelled),
        }
    }
}

/// The events of one run, to the connection that asked.
struct RunEvents {
    notifier: Arc<dyn ConnectionNotifier>,
    to: ConnectionId,
    run_id: String,
}

impl ProxyEvents for RunEvents {
    fn emit(&self, event: w::ProxyEvent) {
        let params = ModelProxyRunEventParams { run_id: self.run_id.clone(), event };
        // A connection that is gone no longer wants the events; the run ends with its cancel token.
        let _ = self.notifier.notify(self.to, RUN_EVENT, serde_json::to_value(params).expect("a typed event serializes"));
    }
}

pub struct ModelProxyService {
    runner: Arc<ProxyRunner>,
    host: Arc<dyn HostChannel>,
    notifier: Arc<dyn ConnectionNotifier>,
    /// The runs in flight by asking connection and run id, so modelProxy/cancel can stop one.
    runs: Mutex<HashMap<(ConnectionId, String), CancellationToken>>,
    /// `maxRequestBytes` and `maxInflightBytes` of the host's admission (model-proxy-host.ts).
    bounds: Bounds,
    /// The payload characters of the runs in flight (`inflight.bytes`).
    held: Mutex<usize>,
    /// Woken when a run leaves `runs`: `close` waits on it.
    settled: tokio::sync::Notify,
    /// Set by `close`: a run it aborts answers that the app is closing.
    closing: AtomicBool,
    /// Numbers the runs of `run_local` (their ids in `runs`).
    local_runs: AtomicU64,
}

/// `appClosingError()` (model-proxy-host.ts `dispose`): what a run aborted by the closing app answers.
const APP_CLOSING: &str = "The desktop app is closing.";

/// What this PC accepts of a server's calls, in payload characters: one call (`MODEL_PROXY_MAX_REQUEST_BYTES`, room for 64 MiB
/// of inlined attachments as base64 plus the transcript) and all the calls in flight together (`MODEL_PROXY_MAX_INFLIGHT_BYTES`).
/// There is no cap on how many calls run: Node's host refuses by these sizes alone.
#[derive(Clone, Copy)]
struct Bounds {
    max_request: usize,
    max_inflight: usize,
}

const MIB: usize = 1024 * 1024;

/// `JSON.stringify(value).length`: the UTF-16 length of the value's compact JSON text as JavaScript writes it, counted without
/// building the text. It is what Node's host measures of the string a server claimed (`payload.length`, `admitPayload`): the
/// text of a call the server's JavaScript wrote is exactly this, and a Rust sender's differs from it in no way that matters
/// (the whitespace it leaves out, and its number forms, which JavaScript spells its own way: `1e+21`, a whole 1e20 in full).
pub fn claimed_chars(value: &Value) -> usize {
    match value {
        Value::Null => 4,
        Value::Bool(true) => 4,
        Value::Bool(false) => 5,
        // A JSON number is a double to JavaScript, whose `String(number)` is the text.
        Value::Number(number) => mixdog_js::number_to_string(number.as_f64().expect("a JSON number is finite")).len(),
        Value::String(text) => quoted_len(text),
        Value::Array(items) => 2 + items.len().saturating_sub(1) + items.iter().map(claimed_chars).sum::<usize>(),
        Value::Object(fields) => 2 + fields.len().saturating_sub(1) + fields.iter().map(|(key, field)| quoted_len(key) + 1 + claimed_chars(field)).sum::<usize>(),
    }
}

/// The length of a string as `JSON.stringify` writes it: quoted, with `"`, `\` and the control characters escaped.
fn quoted_len(text: &str) -> usize {
    2 + text
        .chars()
        .map(|c| match c {
            '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
            c if c < ' ' => 6,
            c => c.len_utf16(),
        })
        .sum::<usize>()
}

/// The payload a run holds until it ends; dropping it gives the share back.
struct Held<'a> {
    service: &'a ModelProxyService,
    chars: usize,
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        *self.service.held.lock().unwrap_or_else(PoisonError::into_inner) -= self.chars;
    }
}

impl ModelProxyService {
    pub fn new(runner: Arc<ProxyRunner>, host: Arc<dyn HostChannel>, notifier: Arc<dyn ConnectionNotifier>) -> Self {
        Self {
            runner,
            host,
            notifier,
            runs: Mutex::new(HashMap::new()),
            bounds: Bounds { max_request: 128 * MIB, max_inflight: 256 * MIB },
            held: Mutex::new(0),
            settled: tokio::sync::Notify::new(),
            closing: AtomicBool::new(false),
            local_runs: AtomicU64::new(0),
        }
    }

    /// The bound of all calls in flight together, in payload characters (Node's `maxInflightBytes` option).
    pub fn with_inflight_bound(mut self, max_inflight: usize) -> Self {
        self.bounds.max_inflight = max_inflight;
        self
    }

    /// The bound of one call, in payload characters (Node's `maxRequestBytes` option).
    pub fn with_request_bound(mut self, max_request: usize) -> Self {
        self.bounds.max_request = max_request;
        self
    }

    /// `admitPayload`: a payload past one call's bound is refused as too large, one that would take the data held past the
    /// in-flight bound as busy. The check and the claim of the share are one step.
    fn admit(&self, chars: usize) -> Result<Held<'_>, w::ProxyFailure> {
        if chars > self.bounds.max_request {
            return Err(request_too_large());
        }
        let mut held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
        if *held + chars > self.bounds.max_inflight {
            return Err(busy());
        }
        *held += chars;
        Ok(Held { service: self, chars })
    }

    /// One admitted run, as `modelProxy/run` and `run_local` share it: the payload is admitted (a refusal is the answer `Failed`),
    /// the run is tracked under `key` so `modelProxy/cancel` and `close` can stop it, and a failure is the answer `Failed`.
    async fn run_admitted(&self, chars: usize, call: w::ProxyCall, allowed: Option<&[String]>, events: &dyn ProxyEvents, cancel: CancellationToken, key: (ConnectionId, String)) -> w::ProxyAnswer {
        let _held = match self.admit(chars) {
            Ok(held) => held,
            Err(failure) => return w::ProxyAnswer::Failed { failure },
        };
        self.runs.lock().unwrap_or_else(PoisonError::into_inner).insert(key.clone(), cancel.clone());
        let ran = self.runner.run(call, allowed, events, &cancel).await;
        self.runs.lock().unwrap_or_else(PoisonError::into_inner).remove(&key);
        self.settled.notify_waiters();
        match ran {
            Ok(answer) => answer,
            Err(mut failure) => {
                if cancel.is_cancelled() && self.closing.load(Ordering::SeqCst) {
                    failure.message = APP_CLOSING.into();
                }
                w::ProxyAnswer::Failed { failure }
            }
        }
    }

    /// `modelProxy/run` for a caller inside this core (the in-core relay): the same admission, the same run and the same answer,
    /// without a connection. The events go to `events`; the run is tracked under a key of its own, so `close` waits for it and
    /// aborts it like any other. A call that does not decode is the answer `Failed`, as a plain error.
    pub async fn run_local(&self, call: Value, allowed: Option<Vec<String>>, events: Arc<dyn ProxyEvents + Send + Sync>, cancel: CancellationToken) -> w::ProxyAnswer {
        let chars = claimed_chars(&call);
        let call = match serde_json::from_value::<w::ProxyCall>(call) {
            Ok(call) => call,
            Err(error) => {
                let mut failed = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
                failed.message = format!("invalid model call: {error}");
                return w::ProxyAnswer::Failed { failure: failure_out(&failed, w::ProxyOutcome::Provider) };
            }
        };
        let key = (LOCAL, format!("local-{}", self.local_runs.fetch_add(1, Ordering::Relaxed)));
        self.run_admitted(chars, call, allowed.as_deref(), events.as_ref(), cancel.child_token(), key).await
    }

    /// `modelProxyBridge.close` (daemon.mjs:302), the first step of Node's shutdown: every relayed model call is aborted, then this waits for the calls to settle, before
    /// anything they depend on goes away.
    pub async fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        for token in self.runs.lock().unwrap_or_else(PoisonError::into_inner).values() {
            token.cancel();
        }
        loop {
            let woken = self.settled.notified();
            if self.runs.lock().unwrap_or_else(PoisonError::into_inner).is_empty() {
                return;
            }
            woken.await;
        }
    }
}

fn invalid(path: &str, expected: &str) -> CoreError {
    CoreError::InvalidParams { path: path.into(), expected: expected.into() }
}

#[async_trait]
impl DomainService for ModelProxyService {
    fn methods(&self) -> &'static [&'static str] {
        &[RUN, EVENT, HEARTBEAT, CANCEL]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        if req.method.as_str() != RUN {
            return Err(CoreError::CapabilityUnavailable { capability: req.method.as_str().into(), detail: "notARequest".into() });
        }
        let Caller::Connection(to) = req.ctx.caller else {
            return Err(invalid("caller", "a connection: the events of the run go to it"));
        };
        // The payload is sized as the server claimed it (`payload.length`), not as the typed call it decodes to, which leaves out
        // what the type does not read; before the run is registered or any provider is looked up.
        let chars = req.params.get("call").map_or(0, claimed_chars);
        let ModelProxyRunParams { run_id, call, allowed_providers } = serde_json::from_value(req.params).map_err(|e| invalid("params", &e.to_string()))?;
        let key = (to, run_id.clone());
        let events = RunEvents { notifier: Arc::clone(&self.notifier), to, run_id };
        let result = self.run_admitted(chars, call, allowed_providers.as_deref(), &events, req.ctx.cancel.child_token(), key).await;
        Ok(Reply::Value(serde_json::to_value(ModelProxyResult { result }).expect("a typed result serializes")))
    }

    fn notify(&self, method: Method, params: Value, from: ConnectionId) -> Admit {
        match method.as_str() {
            EVENT => {
                if let Some(request) = params.get("requestId") {
                    // An event of a request that is over or never was is dropped.
                    self.host.stream_event(from, request, params.get("event").cloned().unwrap_or(Value::Null));
                }
            }
            HEARTBEAT => {
                // Each id claims or renews its request; one that is over or never was is dropped.
                for request in params.get("requestIds").and_then(Value::as_array).into_iter().flatten() {
                    self.host.stream_alive(from, request);
                }
            }
            CANCEL => {
                if let Some(run_id) = params.get("runId").and_then(Value::as_str)
                    && let Some(token) = self.runs.lock().unwrap_or_else(PoisonError::into_inner).get(&(from, run_id.to_owned()))
                {
                    token.cancel();
                }
            }
            _ => {}
        }
        Admit::Accepted
    }
}

#[cfg(test)]
#[path = "model_proxy_service_tests.rs"]
mod tests;
