//! A scripted host for the tests of the engine: it answers `host/browser/*` calls in a fixed order, and pushes the facts, events and
//! user-input notes a real host would send between them. Two ways to build one: [`FakeHost::scripted`] from [`Expect`] rows, and
//! [`FakeHost::from_transcript`] from a JSONL recording. Test support only (`cfg(any(test, feature = "test-support"))`).
//!
//! A call that is not the next expected one is answered `Failed` and recorded; [`FakeHost::finish`] reports it, so a test that
//! swallowed the failure still fails.
//!
//! Transcript rows, one JSON object per line (blank lines are skipped):
//! - `{"method": "host/browser/...", "params": {..}?, "result": ..}`: the next call, with `params` matched as a subset;
//! - `{"method": "...", "params": {..}?, "error": {"code": -32011, "message": "", "data": ..}}`: the same, failing;
//! - `{"push": "events" | "facts" | "userInput", "params": {..}}`: a notification delivered to the sink right before the next
//!   call's answer.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_app_protocol::v2::browser_engine::HostBrowserEventsParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserPageFactsParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserUserInputParams;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;

use crate::error::HostCallError;
use crate::port::EngineSink;
use crate::port::HostWire;

/// A notification the host sends.
#[derive(Debug, Clone, PartialEq)]
pub enum Push {
    Events(HostBrowserEventsParams),
    Facts(HostBrowserPageFactsParams),
    UserInput(HostBrowserUserInputParams),
}

/// One scripted call: the wire name, optionally a subset the params must contain, the answer, and what is pushed before it.
#[derive(Debug, Clone)]
pub struct Expect {
    method: String,
    params: Option<Value>,
    answer: Result<Value, HostCallError>,
    pushes: Vec<Push>,
}

impl Expect {
    pub fn ok(method: &str, result: Value) -> Self {
        Self { method: method.to_string(), params: None, answer: Ok(result), pushes: Vec::new() }
    }

    pub fn err(method: &str, error: HostCallError) -> Self {
        Self { method: method.to_string(), params: None, answer: Err(error), pushes: Vec::new() }
    }

    /// The call's params must contain this (every key of an object, every element of an array position, equal scalars).
    pub fn with_params(mut self, params: Value) -> Self {
        self.params = Some(params);
        self
    }

    /// Delivered to the sink, in order, right before this call is answered.
    pub fn push(mut self, push: Push) -> Self {
        self.pushes.push(push);
        self
    }
}

/// One call the fake host received.
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub method: String,
    pub params: Value,
}

#[derive(Default)]
struct State {
    expected: VecDeque<Expect>,
    calls: Vec<Call>,
    notifications: Vec<Call>,
    mismatches: Vec<String>,
}

/// The scripted host. It is a [`HostWire`], so it is a `BrowserHost` too.
pub struct FakeHost {
    state: Mutex<State>,
    sink: Mutex<Option<Arc<dyn EngineSink>>>,
}

fn contains(actual: &Value, wanted: &Value) -> bool {
    match (actual, wanted) {
        (Value::Object(actual), Value::Object(wanted)) => wanted.iter().all(|(key, wanted)| actual.get(key).is_some_and(|actual| contains(actual, wanted))),
        (Value::Array(actual), Value::Array(wanted)) => actual.len() == wanted.len() && actual.iter().zip(wanted).all(|(actual, wanted)| contains(actual, wanted)),
        (actual, wanted) => actual == wanted,
    }
}

impl FakeHost {
    pub fn scripted(expected: Vec<Expect>) -> Self {
        Self { state: Mutex::new(State { expected: expected.into(), ..State::default() }), sink: Mutex::new(None) }
    }

    /// A host that replays the JSONL recording at `path` (rows described in the module doc).
    pub fn from_transcript(path: &Path) -> Result<Self, String> {
        Self::from_transcript_str(&mixdog_testkit::read_string(path))
    }

    /// [`Self::from_transcript`] over the text itself.
    pub fn from_transcript_str(text: &str) -> Result<Self, String> {
        let mut expected = Vec::new();
        let mut pushes = Vec::new();
        for (index, line) in text.lines().enumerate().filter(|(_, line)| !line.trim().is_empty()) {
            let row: Value = serde_json::from_str(line).map_err(|error| format!("line {}: {error}", index + 1))?;
            let params = row.get("params").cloned();
            if let Some(kind) = row.get("push").and_then(Value::as_str) {
                let params = params.ok_or_else(|| format!("line {}: a push has no params", index + 1))?;
                let bad = |error: serde_json::Error| format!("line {}: {error}", index + 1);
                pushes.push(match kind {
                    "events" => Push::Events(serde_json::from_value(params).map_err(bad)?),
                    "facts" => Push::Facts(serde_json::from_value(params).map_err(bad)?),
                    "userInput" => Push::UserInput(serde_json::from_value(params).map_err(bad)?),
                    other => return Err(format!("line {}: unknown push {other:?}", index + 1)),
                });
                continue;
            }
            let method = row.get("method").and_then(Value::as_str).ok_or_else(|| format!("line {}: no method", index + 1))?;
            let answer = match (row.get("result"), row.get("error")) {
                (Some(result), None) => Ok(result.clone()),
                (None, Some(error)) => {
                    let code = error.get("code").and_then(Value::as_i64).ok_or_else(|| format!("line {}: the error has no code", index + 1))?;
                    let message = error.get("message").and_then(Value::as_str).unwrap_or_default();
                    Err(HostCallError::from_rpc(code, message, error.get("data")))
                }
                _ => return Err(format!("line {}: a call row has exactly one of result and error", index + 1)),
            };
            expected.push(Expect { method: method.to_string(), params, answer, pushes: std::mem::take(&mut pushes) });
        }
        if !pushes.is_empty() {
            return Err("a push follows the last call".to_string());
        }
        Ok(Self::scripted(expected))
    }

    /// The sink the pushes are delivered to.
    pub fn attach_sink(&self, sink: Arc<dyn EngineSink>) {
        *self.sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(sink);
    }

    /// Every call received, in order.
    pub fn calls(&self) -> Vec<Call> {
        self.state().calls.clone()
    }

    /// Every notification the engine sent the host (lease releases), in order.
    pub fn notifications(&self) -> Vec<Call> {
        self.state().notifications.clone()
    }

    /// `Ok` when every scripted call was made, in order, and none was unexpected.
    pub fn finish(&self) -> Result<(), String> {
        let state = self.state();
        if let Some(first) = state.mismatches.first() {
            return Err(first.clone());
        }
        match state.expected.front() {
            Some(left) => Err(format!("{} scripted call(s) never made, the next {}", state.expected.len(), left.method)),
            None => Ok(()),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn deliver(&self, pushes: &[Push]) {
        let sink = self.sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        let Some(sink) = sink else { return };
        for push in pushes {
            match push {
                Push::Events(params) => sink.events(params.clone()),
                Push::Facts(params) => sink.facts(params.clone()),
                Push::UserInput(params) => sink.user_input(params.clone()),
            }
        }
    }
}

#[async_trait]
impl HostWire for FakeHost {
    async fn call(&self, method: &'static str, params: Value, cancel: &CancellationToken) -> Result<Value, HostCallError> {
        if cancel.is_cancelled() {
            return Err(HostCallError::Cancelled);
        }
        let (answer, pushes) = {
            let mut state = self.state();
            state.calls.push(Call { method: method.to_string(), params: params.clone() });
            let problem = match state.expected.front() {
                None => Some(format!("{method}: no call is scripted")),
                Some(next) if next.method != method => Some(format!("{method}: the script expects {}", next.method)),
                Some(next) if next.params.as_ref().is_some_and(|wanted| !contains(&params, wanted)) => Some(format!("{method}: the params do not hold what the script expects")),
                Some(_) => None,
            };
            match problem {
                Some(problem) => {
                    state.mismatches.push(problem.clone());
                    (Err(HostCallError::Failed { message: problem }), Vec::new())
                }
                None => {
                    let next = state.expected.pop_front().expect("checked above");
                    (next.answer, next.pushes)
                }
            }
        };
        self.deliver(&pushes);
        answer
    }

    fn notify(&self, method: &'static str, params: Value) -> Result<(), HostCallError> {
        self.state().notifications.push(Call { method: method.to_string(), params });
        Ok(())
    }
}

/// The wire form of a page's facts with every required field, for a test that needs a page: `pageId`, `seq` and the document
/// `<pageId>:1` on `https://a.test/`.
pub fn page_facts(page_id: &str, seq: u64) -> Value {
    json!({
        "pageId": page_id, "seq": seq, "documentId": format!("{page_id}:1"), "url": "https://a.test/", "title": "",
        "loading": false, "mainFrameLoading": false, "alive": true, "crashed": false, "background": false, "visible": true,
        "zoom": 1.0, "childSessions": [], "openedPopups": []
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::BrowserHost;
    use mixdog_app_protocol::v2::browser_engine::HostBrowserLeaseReleaseParams;
    use mixdog_app_protocol::v2::browser_engine::HostBrowserPageStopParams;
    use mixdog_app_protocol::v2::browser_engine::HostBrowserPagesListParams;
    use mixdog_app_protocol::v2::browser_engine::HostBrowserSnapshotParams;

    fn token() -> CancellationToken {
        CancellationToken::new()
    }

    fn list_params(session: &str) -> HostBrowserPagesListParams {
        HostBrowserPagesListParams { session_id: session.to_string() }
    }

    fn stop_params(page: &str) -> HostBrowserPageStopParams {
        serde_json::from_value(json!({"pageId": page})).expect("params")
    }

    #[derive(Default)]
    struct Log(Mutex<Vec<String>>);

    impl EngineSink for Log {
        fn events(&self, params: HostBrowserEventsParams) {
            self.0.lock().expect("log").push(format!("events {}", params.seq));
        }
        fn facts(&self, params: HostBrowserPageFactsParams) {
            self.0.lock().expect("log").push(format!("facts {}", params.seq));
        }
        fn user_input(&self, params: HostBrowserUserInputParams) {
            self.0.lock().expect("log").push(format!("userInput {}", params.held));
        }
        fn host_gone(&self) {
            self.0.lock().expect("log").push("gone".to_string());
        }
    }

    #[tokio::test]
    async fn scripted_answers_come_back_typed_and_in_order() {
        let host = FakeHost::scripted(vec![
            Expect::ok("host/browser/pages/list", json!({"pages": [], "activePageId": null})).with_params(json!({"sessionId": "s1"})),
            Expect::ok("host/browser/page/stop", page_facts_result("p1", 4)),
        ]);
        let listed = host.pages_list(list_params("s1"), &token()).await.expect("list");
        assert!(listed.pages.is_empty());
        let stopped = host.page_stop(stop_params("p1"), &token()).await.expect("stop");
        assert_eq!(stopped.facts.seq, 4);
        assert_eq!(host.calls().iter().map(|call| call.method.as_str()).collect::<Vec<_>>(), ["host/browser/pages/list", "host/browser/page/stop"]);
        host.finish().expect("all consumed");
    }

    fn page_facts_result(page: &str, seq: u64) -> Value {
        json!({"facts": page_facts(page, seq)})
    }

    #[tokio::test]
    async fn a_call_out_of_order_or_with_other_params_fails_and_is_reported() {
        let host = FakeHost::scripted(vec![Expect::ok("host/browser/pages/list", json!({"pages": []})).with_params(json!({"sessionId": "s1"}))]);
        let wrong_params = host.pages_list(list_params("s2"), &token()).await;
        assert!(matches!(wrong_params, Err(HostCallError::Failed { .. })));
        let wrong_method = host.page_stop(stop_params("p1"), &token()).await;
        assert!(matches!(wrong_method, Err(HostCallError::Failed { .. })));
        assert!(host.finish().is_err());
        assert!(host.pages_list(list_params("s1"), &token()).await.is_ok());
        assert!(host.finish().is_err(), "the earlier mismatch stays reported");
    }

    #[tokio::test]
    async fn a_script_left_unfinished_or_exhausted_is_reported() {
        let host = FakeHost::scripted(vec![Expect::ok("host/browser/pages/list", json!({"pages": []}))]);
        assert!(host.finish().unwrap_err().contains("never made"));
        host.pages_list(list_params("s"), &token()).await.expect("scripted");
        host.finish().expect("done");
        assert!(host.pages_list(list_params("s"), &token()).await.is_err());
    }

    #[tokio::test]
    async fn error_rows_are_mapped_to_their_variants() {
        let host = FakeHost::scripted(vec![
            Expect::err("host/browser/page/stop", HostCallError::PageGone),
            Expect::err("host/browser/snapshot", HostCallError::UserInput { until: Some(9) }),
        ]);
        assert_eq!(host.page_stop(stop_params("p1"), &token()).await.unwrap_err(), HostCallError::PageGone);
        let snapshot: HostBrowserSnapshotParams = serde_json::from_value(json!({"pageId": "p1", "mode": "interactive"})).expect("params");
        assert_eq!(host.snapshot(snapshot, &token()).await.unwrap_err(), HostCallError::UserInput { until: Some(9) });
    }

    #[tokio::test]
    async fn a_cancelled_call_is_not_answered() {
        let host = FakeHost::scripted(vec![Expect::ok("host/browser/pages/list", json!({"pages": []}))]);
        let cancel = token();
        cancel.cancel();
        assert_eq!(host.pages_list(list_params("s"), &cancel).await.unwrap_err(), HostCallError::Cancelled);
        host.pages_list(list_params("s"), &token()).await.expect("the script was not spent");
    }

    #[tokio::test]
    async fn a_malformed_answer_is_a_failure() {
        let host = FakeHost::scripted(vec![Expect::ok("host/browser/pages/list", json!({"pages": 3}))]);
        assert!(matches!(host.pages_list(list_params("s"), &token()).await, Err(HostCallError::Failed { .. })));
    }

    #[tokio::test]
    async fn transcript_replay_keeps_the_order_and_delivers_pushes_before_the_answer() {
        let facts_row = format!(r#"{{"push":"facts","params":{{"pageId":"p1","seq":5,"facts":{}}}}}"#, page_facts("p1", 5));
        let text = [
            r#"{"method":"host/browser/pages/list","params":{"sessionId":"s1"},"result":{"pages":[]}}"#,
            "",
            facts_row.as_str(),
            r#"{"push":"userInput","params":{"pageId":"p1","seq":6,"held":true,"reason":"pointer"}}"#,
            r#"{"method":"host/browser/page/stop","error":{"code":-32011,"message":""}}"#,
        ]
        .join("\n");
        let host = FakeHost::from_transcript_str(&text).expect("parses");
        let log = Arc::new(Log::default());
        host.attach_sink(log.clone());
        host.pages_list(list_params("s1"), &token()).await.expect("first");
        assert!(log.0.lock().expect("log").is_empty());
        assert_eq!(host.page_stop(stop_params("p1"), &token()).await.unwrap_err(), HostCallError::PageGone);
        assert_eq!(*log.0.lock().expect("log"), ["facts 5", "userInput true"]);
        host.finish().expect("replayed");
    }

    #[tokio::test]
    async fn a_transcript_in_the_wrong_order_fails_the_call() {
        let text = [
            r#"{"method":"host/browser/pages/list","result":{"pages":[]}}"#,
            r#"{"method":"host/browser/page/stop","result":{}}"#,
        ]
        .join("\n");
        let host = FakeHost::from_transcript_str(&text).expect("parses");
        assert!(host.page_stop(stop_params("p1"), &token()).await.is_err());
        assert!(host.finish().is_err());
    }

    #[test]
    fn a_malformed_transcript_is_refused_with_its_line() {
        assert!(FakeHost::from_transcript_str("{").unwrap_err().starts_with("line 1"));
        assert!(FakeHost::from_transcript_str(r#"{"method":"m"}"#).unwrap_err().contains("exactly one"));
        assert!(FakeHost::from_transcript_str(r#"{"push":"facts","params":{}}"#).is_err());
        assert!(FakeHost::from_transcript_str(r#"{"push":"nope","params":{}}"#).unwrap_err().contains("unknown push"));
    }

    #[test]
    fn lease_releases_are_recorded_as_notifications() {
        let host = FakeHost::scripted(Vec::new());
        host.lease_release(HostBrowserLeaseReleaseParams { page_id: "p1".into(), lease_id: "l1".into() }).expect("sent");
        let sent = host.notifications();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].method, "host/browser/lease/release");
        assert_eq!(sent[0].params, json!({"pageId": "p1", "leaseId": "l1"}));
    }

    #[test]
    fn the_subset_match_is_strict_about_arrays_and_scalars() {
        assert!(contains(&json!({"a": 1, "b": [1, 2]}), &json!({"b": [1, 2]})));
        assert!(!contains(&json!({"b": [1, 2, 3]}), &json!({"b": [1, 2]})));
        assert!(!contains(&json!({"a": 1}), &json!({"a": 2})));
        assert!(!contains(&json!({}), &json!({"a": null})));
    }
}
