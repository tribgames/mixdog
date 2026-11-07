//! The memory cycle's `cycle1-agent` dispatch (Node `memory/lib/cycle-llm-adapters.mjs` ->
//! `agent-ipc.mjs` `callAgentDispatch` -> `standalone/agent-dispatch-broker.mjs` ->
//! `session-runtime-inline-host/agent-dispatch.mjs`): the production [`Cycle1Llm`].
//!
//! Node's memory process reaches the daemon over an authenticated loopback request; here the
//! cycles run inside the daemon, so the request is the call itself and what remains of the broker
//! is what it decides before it hands the payload to the session host: the agent is `cycle1-agent`,
//! an empty prompt is refused with the broker's sentence, the preset is passed only when truthy,
//! and the idle timeout is `Math.max(1000, timeout)`. The payload the host receives is Node's
//! `dispatchAgent` payload (`fixtures/cycle1-dispatch`, from
//! `benchmarks/rust-core/recorders/record-cycle1-dispatch.mjs`).
//!
//! The request keeps Node's bounds: it fails at `timeout + 5000` ms with "agent broker request timed
//! out after Nms" and, when the caller's token ends it, with "agent broker request canceled" (the
//! token carries no reason, so Node's fallback sentence is used). Either way the run is cancelled
//! the way `/agent/cancel` did (`cancelAndWait`): the host's own token fires and the call waits up
//! to the cancel request's 1500 ms for the run to wind down before it fails.
//!
//! Divergence from Node (decisions.md D-c1-1): only the transport. The broker's fair scheduler
//! admits calls without a limit unless configured, and none is configured, so calls are not queued.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use mixdog_rt::{Scope, Scoped};
use mixdog_services::memory::cycles::{Cycle1Llm, Cycle1Request};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// The only agent the memory broker admits (`MEMORY_AGENTS`).
const AGENT: &str = "cycle1-agent";

/// `callAgentDispatch`'s floor for the dispatch timeout, in milliseconds.
const MIN_TIMEOUT_MS: f64 = 1000.0;

/// `abortError(signal)` for a signal with no reason.
const CANCELED: &str = "agent broker request canceled";

/// The transport's grace after the dispatch's own timeout (`timeoutMs + 5000` in `callAgentDispatch`).
const TRANSPORT_GRACE_MS: f64 = 5000.0;

/// How long a cancelled call waits for the run to wind down: the `/agent/cancel` request's own
/// `timeoutMs`.
const CANCEL_WAIT: Duration = Duration::from_millis(1500);

/// What `sessionRuntimeHost.agentDispatch(payload, { signal })` receives from the broker.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentDispatchPayload {
    /// The call's id; the host refuses a second run of an id that is still running.
    pub dispatch_id: String,
    pub agent: &'static str,
    /// `options.taskType`.
    pub task_type: &'static str,
    /// `options.sourceType`.
    pub source_type: &'static str,
    /// `options.brief`: `false` returns the synthesis uncapped.
    pub brief: bool,
    pub prompt: String,
    /// `params.preset`: absent when falsy.
    pub preset: Option<Value>,
    /// `params.cwd`: the cycle never sets one.
    pub cwd: Option<String>,
    /// `params.idleTimeoutMs`.
    pub idle_timeout_ms: Option<f64>,
}

/// The session host's agent dispatch: one ephemeral run of the named agent under the caller's
/// token, answering its reply text. A failure is the message Node's dispatch threw.
#[async_trait]
pub trait AgentDispatch: Send + Sync + 'static {
    async fn agent_dispatch(&self, payload: AgentDispatchPayload, cancel: &CancellationToken) -> Result<String, String>;
}

/// The cycles' [`Cycle1Llm`] over the session host.
pub struct Cycle1Dispatch {
    host: Arc<dyn AgentDispatch>,
    next: AtomicU64,
}

impl Cycle1Dispatch {
    pub fn new(host: Arc<dyn AgentDispatch>) -> Self {
        Self { host, next: AtomicU64::new(0) }
    }

    fn payload(&self, request: &Cycle1Request, prompt: &str) -> AgentDispatchPayload {
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        AgentDispatchPayload {
            dispatch_id: format!("mem-{}-{id}", std::process::id()),
            agent: AGENT,
            task_type: "maintenance",
            source_type: "memory-cycle",
            brief: false,
            prompt: prompt.to_owned(),
            preset: request.preset.clone().filter(|preset| mixdog_ai::service::admin_route::truthy(Some(preset))),
            cwd: None,
            idle_timeout_ms: Some(request.timeout_ms.max(MIN_TIMEOUT_MS)).filter(|timeout| timeout.is_finite()),
        }
    }
}

/// `wait` from now on the runtime's clock. `Scope` sleeps on that clock, so a deadline taken from
/// `std::time::Instant::now()` is already past once the clock has been advanced (a paused test
/// clock): the wind-down wait would end before the cancelled run was polled.
fn after(wait: Duration) -> Instant {
    (tokio::time::Instant::now() + wait).into_std()
}

#[async_trait]
impl Cycle1Llm for Cycle1Dispatch {
    async fn call(&self, request: &Cycle1Request, cancel: &CancellationToken, prompt: &str) -> Result<String, String> {
        // A caller already cancelled never reaches the broker (`requestBroker` rejects before it sends).
        if cancel.is_cancelled() {
            return Err(CANCELED.to_owned());
        }
        if prompt.is_empty() {
            return Err(format!("agent dispatch prompt required for \"{AGENT}\""));
        }
        let payload = self.payload(request, prompt);
        let request_ms = payload.idle_timeout_ms.map(|timeout| timeout + TRANSPORT_GRACE_MS);
        let deadline = request_ms.map(|ms| after(Duration::from_secs_f64(ms / 1000.0)));
        let run = CancellationToken::new();
        let mut work = Box::pin(self.host.agent_dispatch(payload, &run));
        let ended = match Scope::new().cancel(cancel).deadline(deadline).run(&mut work).await {
            Scoped::Done(reply) => return reply,
            ended => ended,
        };
        run.cancel();
        // The run's own answer is dropped: the failure is the one the request ended with.
        let _ = Scope::new().deadline(Some(after(CANCEL_WAIT))).run(&mut work).await;
        Err(match ended {
            Scoped::DeadlineExceeded => format!("agent broker request timed out after {}ms", mixdog_js::number_to_string(request_ms.unwrap_or_default())),
            _ => CANCELED.to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;

    const GOLDEN: &str = include_str!("../../../../fixtures/cycle1-dispatch/golden.json");

    /// The host: records the payload it receives and answers the case's recorded behaviour.
    struct Host {
        seen: Mutex<Vec<AgentDispatchPayload>>,
        answer: Result<String, String>,
    }

    #[async_trait]
    impl AgentDispatch for Host {
        async fn agent_dispatch(&self, payload: AgentDispatchPayload, _: &CancellationToken) -> Result<String, String> {
            self.seen.lock().unwrap().push(payload);
            self.answer.clone()
        }
    }

    /// Node's `dispatchAgent` payload shape for a payload; `dispatchId` is only checked present.
    fn recorded_shape(payload: &AgentDispatchPayload) -> Value {
        let mut params = serde_json::Map::new();
        params.insert("prompt".into(), json!(payload.prompt));
        if let Some(preset) = &payload.preset {
            params.insert("preset".into(), preset.clone());
        }
        if let Some(cwd) = &payload.cwd {
            params.insert("cwd".into(), json!(cwd));
        }
        if let Some(idle) = payload.idle_timeout_ms {
            params.insert("idleTimeoutMs".into(), json!(idle));
        }
        json!({
            "dispatchId": !payload.dispatch_id.is_empty(),
            "agent": payload.agent,
            "options": { "taskType": payload.task_type, "sourceType": payload.source_type, "brief": payload.brief },
            "params": params,
        })
    }

    /// `serde_json` keeps `120000` and `120000.0` apart; JavaScript has one number type.
    fn numbers_as_floats(value: Value) -> Value {
        match value {
            Value::Number(n) => json!(n.as_f64().unwrap()),
            Value::Array(items) => Value::Array(items.into_iter().map(numbers_as_floats).collect()),
            Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, numbers_as_floats(v))).collect()),
            other => other,
        }
    }

    #[tokio::test]
    async fn every_recorded_call_hands_the_host_what_node_hands_it() {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        for case in golden["cases"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap();
            let outcome = &case["outcome"];
            let answer = match outcome.get("error") {
                Some(error) => Err(error.as_str().unwrap().to_owned()),
                None => Ok(outcome["ok"].as_str().unwrap().to_owned()),
            };
            let host = Arc::new(Host { seen: Mutex::default(), answer: answer.clone() });
            let dispatch = Cycle1Dispatch::new(host.clone());
            let request = Cycle1Request {
                preset: Some(case["request"]["preset"].clone()).filter(|preset| !preset.is_null()),
                timeout_ms: case["request"]["timeout"].as_f64().unwrap(),
            };
            let got = dispatch.call(&request, &CancellationToken::new(), case["prompt"].as_str().unwrap()).await;
            assert_eq!(got, answer, "{id}: outcome");
            let seen = host.seen.lock().unwrap();
            match case["dispatched"].as_object() {
                None => assert!(seen.is_empty(), "{id}: nothing reaches the host"),
                Some(_) => {
                    assert_eq!(seen.len(), 1, "{id}");
                    assert_eq!(numbers_as_floats(recorded_shape(&seen[0])), numbers_as_floats(case["dispatched"].clone()), "{id}: payload");
                }
            }
        }
    }

    /// A run that only ends when it is cancelled (or never, when `ignores_cancel`).
    struct Hanging {
        seen: AtomicU64,
        started: tokio::sync::Notify,
        cancelled: std::sync::atomic::AtomicBool,
        ignores_cancel: bool,
    }

    impl Hanging {
        fn new(ignores_cancel: bool) -> Arc<Self> {
            Arc::new(Self { seen: AtomicU64::new(0), started: tokio::sync::Notify::new(), cancelled: Default::default(), ignores_cancel })
        }
    }

    #[async_trait]
    impl AgentDispatch for Hanging {
        async fn agent_dispatch(&self, _: AgentDispatchPayload, cancel: &CancellationToken) -> Result<String, String> {
            self.seen.fetch_add(1, Ordering::SeqCst);
            self.started.notify_one();
            if self.ignores_cancel {
                std::future::pending::<()>().await;
            }
            cancel.cancelled().await;
            self.cancelled.store(true, Ordering::SeqCst);
            Err("run cancelled".to_owned())
        }
    }

    /// The failures Node's request ends with, and the run it cancels (`ended` of the golden).
    /// The clock is paused, so the 6 s deadline passes without waiting.
    #[tokio::test(start_paused = true)]
    async fn a_request_that_ends_fails_as_node_fails_it_and_cancels_the_run() {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        for case in golden["ended"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap();
            let host = Hanging::new(false);
            let dispatch = Cycle1Dispatch::new(host.clone());
            let request = Cycle1Request { preset: Some(json!("test")), timeout_ms: case["request"]["timeout"].as_f64().unwrap() };
            let cancel = CancellationToken::new();
            if id == "cancelled-before-the-call" {
                cancel.cancel();
            }
            let caller = async {
                if id == "cancelled-while-running" {
                    host.started.notified().await;
                    cancel.cancel();
                }
            };
            let (got, ()) = tokio::join!(dispatch.call(&request, &cancel, "p"), caller);
            assert_eq!(got, Err(case["outcome"]["error"].as_str().unwrap().to_owned()), "{id}: failure");
            assert_eq!(host.seen.load(Ordering::SeqCst) > 0, case["dispatched"].as_bool().unwrap(), "{id}: reached the host");
            assert_eq!(host.cancelled.load(Ordering::SeqCst), case["run"]["aborted"].as_bool().unwrap_or(false), "{id}: run cancelled");
        }
    }

    /// Node's `/agent/cancel` waited for the run only as long as its own request lasted (1500 ms).
    #[tokio::test(start_paused = true)]
    async fn a_run_that_ignores_its_cancel_is_given_up_after_the_cancel_wait() {
        let host = Hanging::new(true);
        let dispatch = Cycle1Dispatch::new(host.clone());
        let request = Cycle1Request { preset: None, timeout_ms: 60000.0 };
        let cancel = CancellationToken::new();
        let caller = async {
            host.started.notified().await;
            cancel.cancel();
        };
        let (got, ()) = tokio::join!(dispatch.call(&request, &cancel, "p"), caller);
        assert_eq!(got, Err(CANCELED.to_owned()));
    }
    #[tokio::test]
    async fn each_call_has_its_own_dispatch_id() {
        let host = Arc::new(Host { seen: Mutex::default(), answer: Ok(String::new()) });
        let dispatch = Cycle1Dispatch::new(host.clone());
        let request = Cycle1Request { preset: None, timeout_ms: 60000.0 };
        for _ in 0..2 {
            dispatch.call(&request, &CancellationToken::new(), "p").await.unwrap();
        }
        let seen = host.seen.lock().unwrap();
        assert_ne!(seen[0].dispatch_id, seen[1].dispatch_id);
    }
}
