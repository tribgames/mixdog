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
use std::sync::atomic::{AtomicBool, Ordering};
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

use super::model_proxy::{ProxyEvents, ProxyRunner};

const RUN: &str = "modelProxy/run";
const EVENT: &str = "model/proxy/event";
const HEARTBEAT: &str = "model/proxy/heartbeat";
const CANCEL: &str = "modelProxy/cancel";
const EXECUTE: Method = Method("model/proxy/execute");
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
    /// Woken when a run leaves `runs`: `close` waits on it.
    settled: tokio::sync::Notify,
    /// Set by `close`: a run it aborts answers that the app is closing.
    closing: AtomicBool,
}

/// `appClosingError()` (model-proxy-host.ts `dispose`): what a run aborted by the closing app answers.
const APP_CLOSING: &str = "The desktop app is closing.";

impl ModelProxyService {
    pub fn new(runner: Arc<ProxyRunner>, host: Arc<dyn HostChannel>, notifier: Arc<dyn ConnectionNotifier>) -> Self {
        Self { runner, host, notifier, runs: Mutex::new(HashMap::new()), settled: tokio::sync::Notify::new(), closing: AtomicBool::new(false) }
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
        let ModelProxyRunParams { run_id, call, allowed_providers } = serde_json::from_value(req.params).map_err(|e| invalid("params", &e.to_string()))?;
        let cancel = req.ctx.cancel.child_token();
        self.runs.lock().unwrap_or_else(PoisonError::into_inner).insert((to, run_id.clone()), cancel.clone());
        let events = RunEvents { notifier: Arc::clone(&self.notifier), to, run_id: run_id.clone() };
        let ran = self.runner.run(call, allowed_providers.as_deref(), &events, &cancel).await;
        self.runs.lock().unwrap_or_else(PoisonError::into_inner).remove(&(to, run_id));
        self.settled.notify_waiters();
        let result = match ran {
            Ok(answer) => answer,
            Err(mut failure) => {
                if cancel.is_cancelled() && self.closing.load(Ordering::SeqCst) {
                    failure.message = APP_CLOSING.into();
                }
                w::ProxyAnswer::Failed { failure }
            }
        };
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
