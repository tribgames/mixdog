//! The `client` domain: the two client notifications `client/activity` and `client/perfLog`.
//! Neither has a reply or loads a session.
//!
//! `client/activity{at}` is today's `noteUserInput(at)` the desktop window reports at most
//! once per 60 s; the heartbeat's idle gate reads it. `client/perfLog{line}` is today's
//! `perfLog`, which writes `[mixdog-service] <line>` to stderr and only when
//! `MIXDOG_DESKTOP_PERF=1`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::host::ClientActivityParams;
use mixdog_app_protocol::v2::host::ClientPerfLogParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use serde_json::Value;

use super::support::wrong_method;

/// The consumer of the user's last input: the Mixy heartbeat (`noteUserInput`), which clamps
/// the time to now, keeps the latest and persists it.
pub trait AppInputSink: Send + Sync {
    /// `at_ms`: milliseconds since the Unix epoch, always positive.
    fn note_user_input(&self, at_ms: i64);
}

/// Where a renderer perf line goes.
pub trait PerfSink: Send + Sync {
    fn line(&self, line: &str);
}

/// `console.error("[mixdog-service] " + line)` when the desktop's perf switch is on.
pub struct StderrPerf {
    enabled: bool,
}

impl StderrPerf {
    /// `enabled`: `MIXDOG_DESKTOP_PERF == "1"`.
    pub fn new(enabled: bool) -> Self {
        Self { enabled }
    }
}

impl PerfSink for StderrPerf {
    fn line(&self, line: &str) {
        if self.enabled {
            eprintln!("[mixdog-service] {line}");
        }
    }
}

pub struct ClientService {
    input: Arc<dyn AppInputSink>,
    perf: Arc<dyn PerfSink>,
}

impl ClientService {
    pub fn new(input: Arc<dyn AppInputSink>, perf: Arc<dyn PerfSink>) -> Arc<Self> {
        Arc::new(Self { input, perf })
    }
}

#[async_trait]
impl DomainService for ClientService {
    /// The namespace has notifications only.
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        Err(wrong_method("client", req.method.as_str()))
    }

    fn notify(&self, method: Method, params: Value, _from: ConnectionId) -> Admit {
        // A notification has no reply to carry a refusal: params that do not decode, and a
        // time that is not positive (`ipc-validation.ts`), are dropped.
        match method.as_str() {
            "client/activity" => {
                if let Ok(ClientActivityParams { at }) = serde_json::from_value(params)
                    && at > 0
                {
                    self.input.note_user_input(at);
                }
            }
            "client/perfLog" => {
                if let Ok(ClientPerfLogParams { line }) = serde_json::from_value(params) {
                    self.perf.line(&line);
                }
            }
            _ => {}
        }
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests;
