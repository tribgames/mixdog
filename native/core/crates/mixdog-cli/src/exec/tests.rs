//! Parity tests of `src/headless-exec.test.mjs` on a scripted core: exit codes, outputs, the usage
//! document, the re-ask on completions, the ordered shutdown and the removal of the root. The
//! JSON lifecycle and the usage document are compared with what Node wrote (`tests/goldens`).
#![allow(
    clippy::disallowed_methods,
    reason = "the tests inspect the files the exec writes and removes"
)]

use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use clap::Parser;
use mixdog_app_server_client::api::RpcNotification;
use mixdog_app_server_client::api::ThreadReducer;
use serde_json::Value;
use serde_json::json;

use super::ExecArgs;
use super::ExecOptions;
use super::Sink;
use super::ToolMode;
use super::boundary::Boundary;
use super::boundary::BoundaryRequest;
use super::boundary::HostCredentials;
use super::lifecycle::Clock;
use super::run::Host;
use super::run::Signal;
use super::run::run_exec;
use super::seams::CoreLauncher;
use super::seams::CoreSession;

const T: i64 = 1_700_000_000_000;

#[derive(Default)]
struct Out {
    out: Mutex<Vec<String>>,
    err: Mutex<Vec<String>>,
}

impl Sink for Out {
    fn out(&self, text: &str) {
        self.out.lock().unwrap().push(text.to_owned());
    }
    fn err(&self, text: &str) {
        self.err.lock().unwrap().push(text.to_owned());
    }
}

impl Out {
    fn stdout(&self) -> Vec<String> {
        self.out.lock().unwrap().clone()
    }
    fn stderr(&self) -> Vec<String> {
        self.err.lock().unwrap().clone()
    }
}

struct Creds;

impl HostCredentials for Creds {
    fn api_key(&self, _provider: &str) -> Option<String> {
        Some("sk-test-key".into())
    }
    fn pool_credential(&self, _provider: &str, _host_data_dir: &Path) -> Option<PathBuf> {
        None
    }
}

fn notif(method: &str, params: Value) -> RpcNotification {
    RpcNotification { method: method.into(), params: Some(params), emitted_at_ms: None, feed: None }
}

fn item(method: &str, item: Value) -> RpcNotification {
    notif(method, json!({ "threadId": "t", "turnId": "turn_1", "item": item }))
}

fn assistant(text: &str) -> RpcNotification {
    item("item/completed", json!({ "type": "agentMessage", "id": "m", "text": text }))
}

fn reasoning(text: &str) -> RpcNotification {
    item("item/completed", json!({ "type": "reasoning", "id": "r", "content": [text] }))
}

fn tool_started(call: &str, name: &str, input: Value) -> RpcNotification {
    item("item/started", json!({ "type": "toolCall", "id": "item_1", "name": name, "input": input, "run": { "callId": call } }))
}

fn tool_done(call: &str, name: &str, input: Value, result: &str, timing: Value) -> RpcNotification {
    item(
        "item/completed",
        json!({ "type": "toolCall", "id": "item_1", "name": name, "input": input, "run": { "callId": call, "result": result, "timing": timing } }),
    )
}

fn usage(model: Option<&str>, input: u64, cached: u64, written: u64, output: u64) -> RpcNotification {
    let mut usage = json!({ "deltaInput": input, "deltaCachedRead": cached, "deltaCacheWrite": written, "deltaOutput": output });
    if let Some(model) = model {
        usage["model"] = json!(model);
    }
    notif("thread/tokenUsage/updated", json!({ "threadId": "t", "usage": usage }))
}

fn model_request() -> RpcNotification {
    notif("thread/modelRequest/updated", json!({ "threadId": "t", "phase": "started" }))
}

fn completion(content: &str, status: &str) -> RpcNotification {
    notif("thread/notification", json!({ "threadId": "t", "content": content, "meta": { "status": status } }))
}

fn turn_done(status: &str, error: Option<&str>, stop: Option<&str>, termination: Option<&str>) -> RpcNotification {
    let mut turn = json!({ "id": "turn_1", "status": status });
    if let Some(error) = error {
        turn["error"] = json!({ "message": error, "data": { "reason": "providerError" } });
    }
    if let Some(stop) = stop {
        turn["stopReason"] = json!(stop);
    }
    if let Some(termination) = termination {
        turn["terminationReason"] = json!(termination);
    }
    notif("turn/completed", json!({ "threadId": "t", "turn": turn }))
}

fn completed() -> RpcNotification {
    turn_done("completed", None, None, None)
}

/// What the scripted core does for one `turn/start`.
enum Turn {
    Events(Vec<RpcNotification>),
    /// The core answers but the turn never ends.
    Hang,
    /// Events handed to the feed one by one, letting the exec consume each before the next; a
    /// `Probe` reads the file at the path at that point.
    Paced(Vec<Paced>),
}

enum Paced {
    Send(RpcNotification),
    Probe(PathBuf),
}

struct FakeSession {
    feed: Arc<dyn ThreadReducer>,
    thread_id: String,
    turns: Mutex<VecDeque<Turn>>,
    calls: Mutex<Vec<(String, Value)>>,
    order: Arc<Mutex<Vec<&'static str>>>,
    close_error: Option<String>,
    services_error: Option<String>,
    probes: Arc<Mutex<Vec<Option<String>>>>,
}

fn feed_in(feed: &Arc<dyn ThreadReducer>, notification: &RpcNotification) {
    feed.apply(&Value::Null, notification);
}

#[async_trait]
impl CoreSession for FakeSession {
    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.calls.lock().unwrap().push((method.into(), params.clone()));
        match method {
            "thread/start" => Ok(json!({ "thread": { "id": self.thread_id } })),
            "turn/start" => {
                match self.turns.lock().unwrap().pop_front().expect("a scripted turn") {
                    Turn::Events(events) => events.iter().for_each(|event| feed_in(&self.feed, event)),
                    Turn::Hang => {}
                    Turn::Paced(steps) => {
                        let feed = self.feed.clone();
                        let probes = self.probes.clone();
                        tokio::spawn(async move {
                            for step in steps {
                                match step {
                                    Paced::Send(event) => feed_in(&feed, &event),
                                    Paced::Probe(path) => probes.lock().unwrap().push(std::fs::read_to_string(path).ok()),
                                }
                                for _ in 0..20 {
                                    tokio::task::yield_now().await;
                                }
                            }
                        });
                    }
                }
                Ok(json!({ "kind": "started", "turnId": "turn_1" }))
            }
            other => Err(format!("unexpected call {other}")),
        }
    }

    async fn lost(&self) -> String {
        std::future::pending().await
    }

    async fn close(&self) -> Result<(), String> {
        self.order.lock().unwrap().push("close");
        self.close_error.clone().map_or(Ok(()), Err)
    }

    async fn stop_services(&self) -> Result<(), String> {
        self.order.lock().unwrap().push("services");
        self.services_error.clone().map_or(Ok(()), Err)
    }
}

struct Captured {
    root: PathBuf,
    env: BTreeMap<String, Option<String>>,
    credential: Option<PathBuf>,
}

struct FakeLauncher {
    turns: Mutex<Option<VecDeque<Turn>>>,
    thread_id: String,
    close_error: Option<String>,
    services_error: Option<String>,
    order: Arc<Mutex<Vec<&'static str>>>,
    session: Mutex<Option<Arc<FakeSession>>>,
    captured: Mutex<Option<Captured>>,
    probes: Arc<Mutex<Vec<Option<String>>>>,
}

impl FakeLauncher {
    fn new(thread_id: &str, turns: Vec<Turn>) -> Self {
        Self {
            turns: Mutex::new(Some(turns.into())),
            thread_id: thread_id.into(),
            close_error: None,
            services_error: None,
            order: Arc::default(),
            session: Mutex::default(),
            captured: Mutex::default(),
            probes: Arc::default(),
        }
    }

    fn launched(&self) -> bool {
        self.captured.lock().unwrap().is_some()
    }

    fn root(&self) -> PathBuf {
        self.captured.lock().unwrap().as_ref().expect("launched").root.clone()
    }

    fn calls(&self) -> Vec<(String, Value)> {
        self.session.lock().unwrap().as_ref().expect("launched").calls.lock().unwrap().clone()
    }

    fn prompts(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .filter(|(method, _)| method == "turn/start")
            .map(|(_, params)| params["input"]["prompt"].as_str().unwrap().to_owned())
            .collect()
    }
}

#[async_trait]
impl CoreLauncher for FakeLauncher {
    async fn launch(&self, boundary: &Boundary, feed: Arc<dyn ThreadReducer>) -> Result<Arc<dyn CoreSession>, String> {
        assert!(boundary.data_dir.is_dir() && boundary.runtime_root.is_dir());
        *self.captured.lock().unwrap() = Some(Captured {
            root: boundary.root_dir.clone(),
            env: boundary.env.clone(),
            credential: boundary.credential.as_ref().map(|binding| binding.path.clone()),
        });
        let session = Arc::new(FakeSession {
            feed,
            thread_id: self.thread_id.clone(),
            turns: Mutex::new(self.turns.lock().unwrap().take().expect("launched once")),
            calls: Mutex::default(),
            order: self.order.clone(),
            close_error: self.close_error.clone(),
            services_error: self.services_error.clone(),
            probes: self.probes.clone(),
        });
        *self.session.lock().unwrap() = Some(session.clone());
        Ok(session)
    }
}

fn host_env() -> BTreeMap<String, String> {
    [("MIXDOG_SECRET", "leak"), ("OPENAI_API_KEY", "sk-host"), ("PATH", "user-path"), ("MIXDOG_AGENT_TRACE_PATH", "/trace.jsonl")]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect()
}

fn options(dir: &Path) -> ExecOptions {
    ExecOptions {
        message: "fix it".into(),
        provider: Some("openai".into()),
        model: Some("gpt-test".into()),
        effort: Some("high".into()),
        fast: true,
        web_search: false,
        json: false,
        cwd: PathBuf::from("/app"),
        usage_log: Some(dir.join("usage.json")),
        tool_mode: ToolMode::Full,
    }
}

fn fixed_clock() -> Clock {
    Arc::new(|| T)
}

fn never() -> Signal {
    Box::pin(std::future::pending())
}

async fn run_with(opts: ExecOptions, launcher: &FakeLauncher, dir: &Path, signal: Signal) -> (i32, Arc<Out>) {
    let sink = Arc::new(Out::default());
    let host = Host {
        launcher,
        credentials: &Creds,
        host_env: host_env(),
        host_data_dir: dir.join("host-data"),
        temp_dir: dir.join("tmp"),
        sink: sink.clone(),
        now: fixed_clock(),
    };
    std::fs::create_dir_all(dir.join("tmp")).unwrap();
    std::fs::create_dir_all(dir.join("host-data")).unwrap();
    let code = run_exec(opts, host, signal).await;
    (code, sink)
}

fn leftover_roots(dir: &Path) -> usize {
    std::fs::read_dir(dir.join("tmp")).unwrap().count()
}

#[tokio::test]
async fn one_implicit_session_answers_writes_usage_and_removes_its_root() {
    let dir = tempfile::tempdir().unwrap();
    let launcher = FakeLauncher::new("sess_exec_test", vec![Turn::Events(vec![usage(Some("gpt-fallback"), 11, 7, 3, 5), assistant("done"), completed()])]);
    let (code, sink) = run_with(options(dir.path()), &launcher, dir.path(), never()).await;

    assert_eq!((code, sink.stdout(), sink.stderr()), (0, vec!["done\n".to_owned()], Vec::<String>::new()));
    assert_eq!(launcher.prompts(), ["fix it"]);
    let calls = launcher.calls();
    assert_eq!(calls[0].0, "thread/start");
    assert_eq!(
        calls[0].1,
        json!({
            "kind": "task",
            "projectPath": "/app",
            "draft": {
                "projectPath": "/app",
                "route": { "provider": "openai", "model": "gpt-test", "effort": "high", "fast": true },
                "workflowId": "headless",
                "orchestrationMode": "none",
            },
            "session": {
                "toolProfile": "headless",
                "toolMode": "full",
                "approvalMode": "implicit",
                "disallowDelegation": true,
                "autoWakeCompletions": false,
                "webSearch": false,
                "memory": false,
            },
        })
    );
    // Runtime close, then the services it started, then the root.
    assert_eq!(*launcher.order.lock().unwrap(), ["close", "services"]);
    assert!(!launcher.root().exists());
    assert_eq!(leftover_roots(dir.path()), 0);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("usage.json")).unwrap(),
        include_str!("../../tests/goldens/exec_usage_v1.json")
    );
    // The run sees none of the host's Mixdog state or credentials, only the root's own paths.
    let captured = launcher.captured.lock().unwrap();
    let env = &captured.as_ref().unwrap().env;
    assert_eq!(env["MIXDOG_SECRET"], None);
    assert_eq!(env["OPENAI_API_KEY"], None);
    assert_eq!(env["MIXDOG_AGENT_TRACE_PATH"].as_deref(), Some("/trace.jsonl"));
    assert_eq!(env["MIXDOG_FEATURE_MEMORY"].as_deref(), Some("0"));
    assert!(!env.contains_key("PATH"));
    assert_eq!(env["MIXDOG_DATA_DIR"].as_deref(), Some(captured.as_ref().unwrap().root.join("data").to_str().unwrap()));
}

/// `headless-exec.mjs` folds a search's spend into the run's totals and observed models through
/// `onNativeWebSearchUsage`; the totals are what Node's accumulator held (`tests/record_search_usage.mjs`).
#[tokio::test]
async fn a_web_searchs_spend_joins_the_totals_as_node_folds_it() {
    let golden: Value = serde_json::from_str(include_str!("../../tests/goldens/exec_search_usage.json")).unwrap();
    let frame = |delta: &Value| notif("thread/tokenUsage/updated", json!({ "threadId": "t", "usage": delta }));
    assert!(matches!(super::feed::observe(&frame(&golden["main"])).as_slice(), [super::feed::Obs::Usage(_)]));
    assert!(matches!(super::feed::observe(&frame(&golden["search"][0])).as_slice(), [super::feed::Obs::SearchUsage(_)]));

    let dir = tempfile::tempdir().unwrap();
    let launcher = FakeLauncher::new("sess_exec_test", vec![Turn::Events(vec![frame(&golden["main"]), frame(&golden["search"][0]), assistant("done"), completed()])]);
    let (code, _) = run_with(options(dir.path()), &launcher, dir.path(), never()).await;
    assert_eq!(code, 0);
    let document: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("usage.json")).unwrap()).unwrap();
    let stats = &golden["stats"];
    let totals = json!({
        "inputTokens": stats["inputTokens"],
        "cacheTokens": stats["cachedTokens"],
        "cacheWriteTokens": stats["cacheWriteTokens"],
        "outputTokens": stats["outputTokens"],
        "toolCallCountApprox": 0,
    });
    assert_eq!(document["totals"], totals);
    assert_eq!(document["sessions"][0]["models"], golden["models"]);
}

#[tokio::test]
async fn a_failed_service_stop_preserves_the_root_and_fails_the_run() {
    let dir = tempfile::tempdir().unwrap();
    let mut launcher = FakeLauncher::new("sess_cleanup_failure", vec![Turn::Events(vec![assistant("done"), completed()])]);
    launcher.services_error = Some("daemon stuck".into());
    let mut opts = options(dir.path());
    opts.usage_log = None;
    let (code, sink) = run_with(opts, &launcher, dir.path(), never()).await;

    assert_eq!(code, 1);
    assert!(sink.stderr().iter().any(|line| line.contains("shutdown failed: daemon stuck")), "{:?}", sink.stderr());
    assert!(launcher.root().exists());
    std::fs::remove_dir_all(launcher.root()).unwrap();
}

#[tokio::test]
async fn usage_is_on_disk_before_the_next_response_arrives() {
    let dir = tempfile::tempdir().unwrap();
    let usage_path = dir.path().join("usage.json");
    let launcher = FakeLauncher::new(
        "sess_flush_test",
        vec![Turn::Paced(vec![Paced::Send(usage(None, 9, 4, 2, 6)), Paced::Probe(usage_path.clone()), Paced::Send(assistant("done")), Paced::Send(completed())])],
    );
    let (code, _) = run_with(options(dir.path()), &launcher, dir.path(), never()).await;

    assert_eq!(code, 0);
    let mid: Value = serde_json::from_str(launcher.probes.lock().unwrap()[0].as_deref().expect("the file existed mid-run")).unwrap();
    assert_eq!(
        mid["totals"],
        json!({ "inputTokens": 9, "cacheTokens": 4, "cacheWriteTokens": 2, "outputTokens": 6, "toolCallCountApprox": 0 })
    );
}

#[tokio::test]
async fn an_arrived_completion_gets_one_follow_up_ask_and_nothing_is_waited_for() {
    for late in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let first = if late {
            vec![assistant("task started"), completed(), completion("background task completed", "completed")]
        } else {
            vec![completion("background task completed", "completed"), assistant("task started"), completed()]
        };
        let launcher = FakeLauncher::new("sess_drain", vec![Turn::Events(first), Turn::Events(vec![assistant("final result"), completed()])]);
        let mut opts = options(dir.path());
        opts.message = "start the long task".into();
        let (code, sink) = run_with(opts, &launcher, dir.path(), never()).await;

        assert_eq!(code, 0, "late={late}");
        assert_eq!(sink.stderr(), Vec::<String>::new());
        assert_eq!(launcher.prompts(), ["start the long task", ""], "late={late}");
        assert_eq!(sink.stdout(), ["final result\n"]);
    }
}

#[tokio::test]
async fn a_progress_notification_is_not_a_completion() {
    let dir = tempfile::tempdir().unwrap();
    let launcher = FakeLauncher::new("sess_progress", vec![Turn::Events(vec![completion("still running", "progress"), assistant("ok"), completed()])]);
    let (code, _) = run_with(options(dir.path()), &launcher, dir.path(), never()).await;
    assert_eq!((code, launcher.prompts()), (0, vec!["fix it".to_owned()]));
}

fn lifecycle_script() -> Vec<RpcNotification> {
    let call = json!({ "command": "echo ok" });
    let marks = json!({
        "dispatchStartedAt": T, "executionStartedAt": T + 2, "executionCompletedAt": T + 5,
        "postprocessStartedAt": T + 6, "resultCompletedAt": T + 8,
    });
    vec![
        model_request(),
        reasoning("inspect first"),
        usage(None, 11, 7, 3, 5),
        tool_started("call_1", "shell", call.clone()),
        notif("thread/toolBatch/updated", json!({ "threadId": "t", "phase": "started" })),
        tool_done("call_1", "shell", call, "ok\n", marks),
        notif("thread/toolBatch/updated", json!({ "threadId": "t", "phase": "completed", "iteration": 1, "calls": 1, "durationMs": 2 })),
        completion("background task completed", "progress"),
        model_request(),
        assistant("done"),
        usage(None, 5, 0, 0, 2),
        turn_done("completed", None, Some("end_turn"), None),
    ]
}

fn json_lines(sink: &Out) -> Vec<Value> {
    sink.stdout().join("").trim().split('\n').map(|line| serde_json::from_str(line).unwrap()).collect()
}

#[tokio::test]
async fn the_json_lifecycle_is_the_recorded_node_stream() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("host-data")).unwrap();
    std::fs::write(dir.path().join("host-data").join("openai-oauth.json"), "{}").unwrap();
    let launcher = FakeLauncher::new("sess_json_test", vec![Turn::Events(lifecycle_script())]);
    let mut opts = options(dir.path());
    opts.provider = Some("openai-oauth".into());
    opts.json = true;
    let (code, sink) = run_with(opts, &launcher, dir.path(), never()).await;

    assert_eq!((code, sink.stderr()), (0, Vec::<String>::new()));
    assert_eq!(sink.stdout().join(""), include_str!("../../tests/goldens/exec_json_lifecycle.jsonl"));
    // The credential is bound in process: the run reads the host's own file, no copy.
    let bound = launcher.captured.lock().unwrap().as_ref().unwrap().credential.clone();
    assert_eq!(bound, Some(dir.path().join("host-data").join("openai-oauth.json")));
    let events = json_lines(&sink);
    assert_eq!(events.last().unwrap()["tool_calls"], 1);
    let usage: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("usage.json")).unwrap()).unwrap();
    assert_eq!(usage["totals"]["toolCallCountApprox"], 1);
}

#[tokio::test]
async fn a_failed_turn_is_a_structured_failure_and_exit_1() {
    let dir = tempfile::tempdir().unwrap();
    let launcher = FakeLauncher::new("sess_json_failure", vec![Turn::Events(vec![turn_done("failed", Some("boom"), None, None)])]);
    let mut opts = options(dir.path());
    opts.json = true;
    let (code, sink) = run_with(opts, &launcher, dir.path(), never()).await;

    assert_eq!((code, sink.stderr()), (1, vec!["mixdog: boom\n".to_owned()]));
    let events = json_lines(&sink);
    let kinds: Vec<&str> = events.iter().map(|event| event["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["thread.started", "turn.started", "turn.failed", "result"]);
    assert_eq!(events[3]["subtype"], "error_during_execution");
    assert_eq!(events[3]["errors"], json!(["boom"]));
    assert_eq!(events[2]["error"], json!({ "message": "boom" }));
}

#[tokio::test]
async fn a_typed_refusal_is_an_error_result_with_exit_0() {
    let dir = tempfile::tempdir().unwrap();
    let launcher = FakeLauncher::new(
        "sess_json_refusal",
        vec![Turn::Events(vec![assistant("Unable to respond."), turn_done("completed", None, Some("refusal"), Some("refusal"))])],
    );
    let mut opts = options(dir.path());
    opts.json = true;
    let (code, sink) = run_with(opts, &launcher, dir.path(), never()).await;

    assert_eq!(code, 0);
    let terminal = json_lines(&sink).pop().unwrap();
    assert_eq!(terminal["subtype"], "success");
    assert_eq!(terminal["is_error"], true);
    assert_eq!(terminal["stop_reason"], "refusal");
    assert_eq!(terminal["termination_reason"], "refusal");
}

#[tokio::test]
async fn a_missing_message_or_route_stops_before_anything_starts() {
    let dir = tempfile::tempdir().unwrap();
    let cases: [(fn(&mut ExecOptions), &str); 4] = [
        (|opts| opts.message = " \u{feff}\n".into(), "mixdog: message is required\n"),
        (|opts| opts.provider = None, "mixdog: mixdog exec requires both --provider <name> and --model <name>; host route fallback is disabled\n"),
        (|opts| opts.model = Some(" ".into()), "mixdog: mixdog exec requires both --provider <name> and --model <name>; host route fallback is disabled\n"),
        (|opts| opts.effort = Some("turbo".into()), "mixdog: invalid --effort \"turbo\"; expected low, medium, high, xhigh, or max\n"),
    ];
    for (mutate, expected) in cases {
        let launcher = FakeLauncher::new("never", vec![]);
        let mut opts = options(dir.path());
        mutate(&mut opts);
        let (code, sink) = run_with(opts, &launcher, dir.path(), never()).await;
        assert_eq!((code, sink.stderr(), sink.stdout()), (1, vec![expected.to_owned()], Vec::<String>::new()));
        assert!(!launcher.launched());
        assert_eq!(leftover_roots(dir.path()), 0);
    }
}

#[tokio::test]
async fn missing_credentials_fail_closed_and_leave_no_root() {
    let dir = tempfile::tempdir().unwrap();
    let launcher = FakeLauncher::new("never", vec![]);
    let mut opts = options(dir.path());
    opts.provider = Some("openai-oauth".into());
    let (code, sink) = run_with(opts, &launcher, dir.path(), never()).await;

    assert_eq!(code, 1);
    assert_eq!(sink.stderr(), ["mixdog: required openai-oauth credentials are unavailable; sign in before using mixdog exec\n"]);
    assert!(!launcher.launched());
    assert_eq!(leftover_roots(dir.path()), 0);
}

#[tokio::test]
async fn a_termination_signal_runs_the_shutdown_once_and_returns_its_code() {
    let dir = tempfile::tempdir().unwrap();
    let launcher = FakeLauncher::new("sess_signal", vec![Turn::Hang]);
    let signal: Signal = Box::pin(async {
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        130
    });
    let (code, sink) = run_with(options(dir.path()), &launcher, dir.path(), signal).await;

    assert_eq!(code, 130);
    assert_eq!(sink.stderr(), Vec::<String>::new());
    assert_eq!(*launcher.order.lock().unwrap(), ["close", "services"]);
    assert!(!launcher.root().exists());
}

#[test]
fn the_pristine_boundary_is_what_node_built() {
    let dir = tempfile::tempdir().unwrap();
    let host_env: BTreeMap<String, String> = [("MIXDOG_X", "1"), ("OPENAI_API_KEY", "sk-host"), ("PATH", "p")]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect();
    struct Key;
    impl HostCredentials for Key {
        fn api_key(&self, _provider: &str) -> Option<String> {
            Some("sk-host".into())
        }
        fn pool_credential(&self, _provider: &str, _dir: &Path) -> Option<PathBuf> {
            None
        }
    }
    let boundary = Boundary::create(&BoundaryRequest {
        provider: "openai",
        model: "gpt-x",
        effort: Some("High"),
        fast: true,
        host_env: &host_env,
        host_data_dir: dir.path(),
        temp_dir: dir.path(),
        credentials: &Key,
    })
    .unwrap();
    let golden: Value = serde_json::from_str(include_str!("../../tests/goldens/exec_pristine_audit.json")).unwrap();
    assert_eq!(boundary.audit, golden["audit"]);
    assert_eq!(boundary.runtime_config, golden["loadConfig"]);
    assert_eq!(std::fs::read_to_string(boundary.data_dir.join("mixdog-config.json")).unwrap(), golden["config"].as_str().unwrap());
    assert_eq!(boundary.env["MIXDOG_X"], None);
    assert_eq!(boundary.env["OPENAI_API_KEY"], None);
    assert!(boundary.credential.is_none());
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
}

#[derive(Parser)]
struct Wrapper {
    #[command(flatten)]
    args: ExecArgs,
}

fn parse(argv: &[&str]) -> Result<ExecOptions, String> {
    let mut full = vec!["exec"];
    full.extend_from_slice(argv);
    Wrapper::try_parse_from(full).map_err(|err| err.to_string())?.args.into_options(None)
}

#[test]
fn the_command_line_is_the_nodes() {
    let opts = parse(&["--provider", "openai-oauth", "--model", "gpt-test", "--json", "fix", "it  "]).unwrap();
    assert_eq!((opts.message.as_str(), opts.json, opts.fast, opts.web_search), ("fix it", true, false, false));
    assert_eq!(parse(&["--provider", "p", "   "]).unwrap_err(), "usage: mixdog exec [options] <message...>");
    assert_eq!(parse(&["--workflow", "solo", "fix it"]).unwrap_err(), "option --workflow is not supported for mixdog exec");
    assert_eq!(parse(&["--memory", "fix it"]).unwrap_err(), "option --memory is not supported for mixdog exec");
    assert_eq!(parse(&["--readonly", "fix it"]).unwrap_err(), "option --readonly is not supported for mixdog exec");
}

#[test]
fn the_usage_log_follows_the_environment_when_not_given() {
    let wrapper = Wrapper::try_parse_from(["exec", "go"]).unwrap();
    let opts = wrapper.args.into_options(Some("/log/usage.json".into())).unwrap();
    assert_eq!(opts.usage_log, Some(PathBuf::from("/log/usage.json")));
}

// ---- the read-only tool mode, replayed from Node's recording (`fixtures/exec-readonly`, `record-exec-readonly.mjs`) ----

const EXEC_READONLY_CASES: [&str; 4] = [
    include_str!("../../../../fixtures/exec-readonly/readonly-blocked.json"),
    include_str!("../../../../fixtures/exec-readonly/readonly-json.json"),
    include_str!("../../../../fixtures/exec-readonly/full-simple.json"),
    include_str!("../../../../fixtures/exec-readonly/full-json.json"),
];

/// The events the core feeds the thread for what the recording's provider served: per model request the stages a request goes
/// through, the tool calls it names, its usage and text, then each batch's results as the recorded next request carried them.
fn recorded_core_events(case: &Value) -> Vec<RpcNotification> {
    let requests = case["requests"].as_array().unwrap();
    let marks = json!({ "dispatchStartedAt": T, "executionStartedAt": T, "executionCompletedAt": T, "postprocessStartedAt": T, "resultCompletedAt": T });
    let mut events = Vec::new();
    for (index, request) in requests.iter().enumerate() {
        let served = &request["served"];
        events.push(model_request());
        for stage in ["requesting", "requesting", "streaming"] {
            events.push(notif("thread/stage/updated", json!({ "threadId": "t", "stage": stage })));
        }
        let calls = served["calls"].as_array().unwrap();
        for call in calls {
            events.push(tool_started(call["id"].as_str().unwrap(), call["name"].as_str().unwrap(), call["input"].clone()));
        }
        events.push(usage(None, served["inputTokens"].as_u64().unwrap(), 0, 0, served["outputTokens"].as_u64().unwrap()));
        if !served["text"].as_str().unwrap().is_empty() {
            events.push(assistant(served["text"].as_str().unwrap()));
        }
        if calls.is_empty() {
            continue;
        }
        events.push(notif("thread/toolBatch/updated", json!({ "threadId": "t", "phase": "started" })));
        for (call, result) in calls.iter().zip(requests[index + 1]["toolResults"].as_array().unwrap()) {
            assert_eq!(result["tool_use_id"], call["id"]);
            let mut done = tool_done(call["id"].as_str().unwrap(), call["name"].as_str().unwrap(), call["input"].clone(), result["content"].as_str().unwrap(), marks.clone());
            if result["is_error"] == true {
                done.params.as_mut().unwrap()["item"]["run"]["isError"] = json!(true);
            }
            events.push(done);
        }
        events.push(notif("thread/toolBatch/updated", json!({ "threadId": "t", "phase": "completed", "iteration": index + 1, "calls": calls.len(), "durationMs": 0 })));
    }
    events.push(turn_done("completed", None, requests.last().unwrap()["served"]["stopReason"].as_str(), None));
    events
}

/// `mixdogd exec --tool-mode <mode>` against a core that feeds what Node's provider run did: the mode reaches the core as the
/// options the runtime was created with, and every output of the run (stdout whole, stderr, exit code, usage document) is Node's.
#[tokio::test]
async fn the_read_only_exec_is_what_node_recorded_for_every_case() {
    for text in EXEC_READONLY_CASES {
        let case: Value = serde_json::from_str(text).unwrap();
        let label = case["case"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let usage_path = dir.path().join("usage.json");
        let mut argv = vec!["--provider", "anthropic", "--model", "claude-sonnet-4-6", "--cwd", "/work", "--tool-mode", case["mode"].as_str().unwrap()];
        if case["json"] == true {
            argv.push("--json");
        }
        argv.extend(["--usage-log", usage_path.to_str().unwrap(), "go"]);
        let opts = parse(&argv).unwrap();
        let launcher = FakeLauncher::new("sess_exec_readonly", vec![Turn::Events(recorded_core_events(&case))]);
        let (code, sink) = run_with(opts, &launcher, dir.path(), never()).await;

        assert_eq!(code, case["code"], "{label}: exit code");
        assert_eq!(sink.stdout().join(""), case["stdout"].as_array().unwrap().iter().map(|line| line.as_str().unwrap()).collect::<String>(), "{label}: stdout");
        assert_eq!(sink.stderr().join(""), case["stderr"].as_array().unwrap().iter().map(|line| line.as_str().unwrap()).collect::<String>(), "{label}: stderr");
        let document: Value = serde_json::from_str(&std::fs::read_to_string(&usage_path).unwrap()).unwrap();
        assert_eq!(document, case["usage"], "{label}: usage document");
        // The runtime options Node created the session with, whole (the mode is the one that differs).
        let calls = launcher.calls();
        assert_eq!(calls[0].0, "thread/start");
        assert_eq!(calls[0].1["session"], case["runtimeOptions"], "{label}: the session options");
        assert_eq!(launcher.prompts(), ["go"]);
    }
}

/// Node's `classifyCliInvocation` (`headless-command.mjs`) over the recorded command lines (`fixtures/exec-readonly/cli.json`): the
/// flag absent is mode `full`, a mode Node's exec does not know and the refused `--readonly` are its errors, word for word.
#[test]
fn the_exec_command_line_is_classified_as_nodes_is() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("../../../../fixtures/exec-readonly/cli.json")).unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let argv: Vec<&str> = case["argv"].as_array().unwrap().iter().map(|arg| arg.as_str().unwrap()).collect();
        assert_eq!(argv[0], "exec");
        let node = &case["result"];
        let parsed = parse(&argv[1..]);
        match node["kind"].as_str().unwrap() {
            "error" => assert_eq!(parsed.err(), Some(node["error"].as_str().unwrap().to_owned()), "{argv:?}"),
            "exec" => {
                let opts = parsed.unwrap_or_else(|error| panic!("{argv:?}: {error}"));
                let node_options = &node["options"];
                assert_eq!(opts.message, node["exec"]["message"].as_str().unwrap(), "{argv:?}: message");
                assert_eq!(opts.provider.as_deref(), node_options["provider"].as_str(), "{argv:?}: provider");
                assert_eq!(opts.model.as_deref(), node_options["model"].as_str(), "{argv:?}: model");
                assert_eq!(opts.tool_mode.as_str(), node_options["toolMode"].as_str().unwrap(), "{argv:?}: tool mode");
                assert_eq!(opts.json, node_options["json"], "{argv:?}: json");
                assert_eq!(opts.web_search, node_options["webSearch"], "{argv:?}: web search");
            }
            kind => panic!("unexpected kind {kind}"),
        }
    }
}