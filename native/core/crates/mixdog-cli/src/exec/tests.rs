//! Parity tests of `src/headless-exec.test.mjs` on a scripted core: exit codes, outputs, the usage
//! document, the re-ask on completions, the ordered shutdown and the removal of the root. The
//! JSON lifecycle and the usage document are compared with what Node wrote (`tests/goldens`).
#![allow(clippy::disallowed_methods, reason = "the tests inspect the files the exec writes and removes")]

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
use sha2::Digest;

use super::ExecArgs;
use super::ExecOptions;
use super::Invocation;
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
    RpcNotification { method: method.into(), params: Some(params), emitted_at_ms: None, feed: None, lone_surrogates: Vec::new() }
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
        provider_config: None,
        route_profile: None,
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
        agents_dir: dir.join("agents"),
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
        vec![Turn::Paced(vec![
            Paced::Send(usage(None, 9, 4, 2, 6)),
            Paced::Probe(usage_path.clone()),
            Paced::Send(assistant("done")),
            Paced::Send(completed()),
        ])],
    );
    let (code, _) = run_with(options(dir.path()), &launcher, dir.path(), never()).await;

    assert_eq!(code, 0);
    let mid: Value = serde_json::from_str(launcher.probes.lock().unwrap()[0].as_deref().expect("the file existed mid-run")).unwrap();
    assert_eq!(mid["totals"], json!({ "inputTokens": 9, "cacheTokens": 4, "cacheWriteTokens": 2, "outputTokens": 6, "toolCallCountApprox": 0 }));
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

/// Without `--json` a failed turn prints nothing on stdout, the reason on stderr, exits 1 and still removes its root.
#[tokio::test]
async fn a_failed_turn_without_json_prints_only_its_reason_on_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let launcher = FakeLauncher::new("sess_text_failure", vec![Turn::Events(vec![assistant("partial"), turn_done("failed", Some("boom"), None, None)])]);
    let (code, sink) = run_with(options(dir.path()), &launcher, dir.path(), never()).await;
    assert_eq!((code, sink.stdout(), sink.stderr()), (1, Vec::<String>::new(), vec!["mixdog: boom\n".to_owned()]));
    assert_eq!(*launcher.order.lock().unwrap(), ["close", "services"]);
    assert_eq!(leftover_roots(dir.path()), 0);
}

/// A core that cannot be started fails the run with its reason, exit 1, and leaves no root behind.
#[tokio::test]
async fn a_core_that_cannot_start_fails_the_run_and_leaves_no_root() {
    struct Refusing;
    #[async_trait]
    impl CoreLauncher for Refusing {
        async fn launch(&self, _: &Boundary, _: Arc<dyn ThreadReducer>) -> Result<Arc<dyn CoreSession>, String> {
            Err("the core binary is missing".into())
        }
    }
    for json in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let sink = Arc::new(Out::default());
        let host = Host {
            launcher: &Refusing,
            credentials: &Creds,
            host_env: host_env(),
            host_data_dir: dir.path().join("host-data"),
            agents_dir: dir.path().join("agents"),
            temp_dir: dir.path().join("tmp"),
            sink: sink.clone(),
            now: fixed_clock(),
        };
        std::fs::create_dir_all(dir.path().join("tmp")).unwrap();
        std::fs::create_dir_all(dir.path().join("host-data")).unwrap();
        let mut opts = options(dir.path());
        opts.json = json;
        let code = run_exec(opts, host, never()).await;
        assert_eq!(code, 1, "json={json}");
        assert_eq!(sink.stderr(), ["mixdog: the core binary is missing\n"], "json={json}");
        assert_eq!(leftover_roots(dir.path()), 0, "json={json}");
        if !json {
            assert!(sink.stdout().is_empty());
        }
    }
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
    // The turn the shutdown aborted fails with Node's session-closed text (`teardown.mjs`), as `exec-cli/ctrl-c` records.
    assert_eq!(sink.stderr(), ["mixdog: Session \"sess_signal\" closed: runtime close (reason=SIGINT)\n"]);
    assert_eq!(*launcher.order.lock().unwrap(), ["close", "services"]);
    assert!(!launcher.root().exists());
}

/// B-8 (a deliberate difference from Node): `--provider-config` defines the one custom provider, audited, its key read
/// from the named variable and bound in memory; a custom provider without it is refused early.
#[test]
fn a_custom_provider_needs_the_explicit_provider_config() {
    let dir = tempfile::tempdir().unwrap();
    let host_env: BTreeMap<String, String> = [("MY_KEY", "sk-custom")].into_iter().map(|(name, value)| (name.to_owned(), value.to_owned())).collect();
    let config = r#"{"custom-x": {"type": "custom", "schemaVersion": 2, "name": "X", "protocol": "openai-chat", "baseURL": "https://x.example/v1", "apiKeyEnv": "MY_KEY"}}"#;
    let create = |provider: &str, provider_config: Option<&str>| {
        Boundary::create(&BoundaryRequest {
            provider,
            model: "m",
            effort: None,
            fast: false,
            provider_config,
            route_profile: None,
            agents_dir: dir.path(),
            host_env: &host_env,
            host_data_dir: dir.path(),
            temp_dir: dir.path(),
            credentials: &Creds,
        })
    };
    let refused = create("custom-x", None).err().unwrap();
    assert!(refused.contains("--provider-config"), "{refused}");
    let boundary = create("custom-x", Some(config)).unwrap();
    assert_eq!(boundary.audit["providerConfigSource"], "explicit");
    assert_eq!(boundary.audit["authMode"], "in-process-api-key");
    assert_eq!(boundary.audit["personalState"]["hostConfigRead"], false);
    let entry = &boundary.runtime_config["providers"]["custom-x"];
    assert_eq!((entry["baseURL"].as_str(), entry["apiKey"].as_str(), entry.get("apiKeyEnv")), (Some("https://x.example/v1"), Some("sk-custom"), None));
    assert_eq!(boundary.env["MY_KEY"], None);
    let written = std::fs::read_to_string(boundary.data_dir.join("mixdog-config.json")).unwrap();
    assert!(written.contains("\"apiKeyEnv\": \"MY_KEY\"") && !written.contains("sk-custom"));
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
    let secret = config.replace("\"apiKeyEnv\": \"MY_KEY\"", "\"apiKey\": \"sk-inline\"");
    assert!(create("custom-x", Some(&secret)).err().unwrap().contains("inline apiKey"));
    assert!(create("custom-y", Some(config)).err().unwrap().contains("custom-y"));
    assert!(create("openai", Some(config)).err().unwrap().contains("--provider-config"));
    let plain = create("openai", None).unwrap();
    assert!(plain.audit.get("providerConfigSource").is_none());
    std::fs::remove_dir_all(&plain.root_dir).unwrap();
}

#[derive(Parser)]
struct Wrapper {
    #[command(flatten)]
    args: ExecArgs,
}

fn invocation(argv: &[&str]) -> Result<Invocation, String> {
    let mut full = vec!["exec"];
    full.extend_from_slice(argv);
    Wrapper::try_parse_from(full).map_err(|err| err.to_string())?.args.into_invocation(None)
}

fn parse(argv: &[&str]) -> Result<ExecOptions, String> {
    let Invocation::Run(options) = invocation(argv)? else { panic!("{argv:?} asks for help") };
    Ok(options)
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

/// Node's `classifyCliInvocation` on `["exec", ...argv]` (`headless-command.mjs` `parseTokens`): an option counts wherever it
/// stands until `--`, the first value of a repeated option wins, and a malformed line is Node's refusal word for word.
#[test]
fn options_stand_anywhere_until_the_escape() {
    let opts = parse(&["--provider", "p", "--model", "m", "say", "--json", "hi", "--effort", "high", "--fast"]).unwrap();
    assert_eq!((opts.message.as_str(), opts.json, opts.effort.as_deref(), opts.fast), ("say hi", true, Some("high"), true));
    let opts = parse(&["say", "hi", "--provider", "anthropic", "--model", "claude-sonnet-4-6", "--tool-mode", "readonly"]).unwrap();
    assert_eq!((opts.provider.as_deref(), opts.model.as_deref(), opts.tool_mode), (Some("anthropic"), Some("claude-sonnet-4-6"), ToolMode::Readonly));
    let opts = parse(&["--provider", "custom-x", "--model", "m", "--provider-config", "{}", "hi"]).unwrap();
    assert_eq!((opts.message.as_str(), opts.provider_config.as_deref()), ("hi", Some("{}")));
    let opts = parse(&["--provider", "anthropic", "--provider", "openai", "--model", "m", "--json", "--json", "hi"]).unwrap();
    assert_eq!((opts.provider.as_deref(), opts.json), (Some("anthropic"), true));
    // `--` ends the options, one that comes first too; a flag is still read past it (`argv.includes`).
    let opts = parse(&["--provider", "p", "--model", "m", "--", "say", "--model", "x", "--json"]).unwrap();
    assert_eq!((opts.message.as_str(), opts.model.as_deref(), opts.json), ("say --model x --json", Some("m"), true));
    let opts = parse(&["--", "--provider", "p", "hi"]).unwrap();
    assert_eq!((opts.message.as_str(), opts.provider), ("--provider p hi", None));
}

#[test]
fn a_malformed_line_is_refused_in_nodes_words() {
    let refusals: [(&[&str], &str); 17] = [
        (&["--provider", "p", "--model", "m", "hi", "--readonly"], "option --readonly is not supported for mixdog exec"),
        (&["hi", "--bogus"], "unknown option --bogus"),
        (&["-x", "hi"], "unknown option -x"),
        (&["--provider=anthropic", "--model=m", "hi"], "unknown option --provider=anthropic"),
        (&["--provider", "--model", "m", "hi"], "option --provider requires a non-option value"),
        (&["--provider", "p", "--model", "-x", "hi"], "option --model requires a non-option value"),
        (&["hi", "--provider"], "option --provider requires a non-option value"),
        (&["--provider", "", "--model", "m", "hi"], "option --provider requires a non-option value"),
        (&["--provider", "exec", "--model", "m", "hi"], "option --provider requires a route value before \"exec\""),
        (&["--effort", " Exec ", "hi"], "option --effort requires a route value before \" Exec \""),
        (&["--workflow", "exec", "hi"], "option --workflow is not supported for mixdog exec"),
        (&["--worktree", "--no-worktree", "hi"], "options --worktree and --no-worktree are mutually exclusive"),
        (&["--worktree=a b", "hi"], "option --worktree name \"a b\" is invalid: use letters, digits, \".\", \"_\" or \"-\", starting with a letter or digit"),
        (&["--worktree", "task", "hi"], "option --worktree is not supported for mixdog exec"),
        (&["--worktree", "exec", "hi"], "option --worktree is not supported for mixdog exec"),
        (&["hi", "--tool-mode"], "unknown option --tool-mode"),
        (&["--"], "usage: mixdog exec [options] <message...>"),
    ];
    for (argv, refusal) in refusals {
        assert_eq!(parse(argv).unwrap_err(), refusal, "{argv:?}");
    }
}

/// `--plain` and `--react` are Node's flags: the first asks for its REPL (help wins over it), the second is refused.
#[test]
fn plain_and_react_are_classified_before_the_run() {
    assert!(matches!(invocation(&["--plain", "hi"]), Ok(Invocation::Plain)));
    assert!(matches!(invocation(&["--react", "hi"]), Ok(Invocation::React)));
    assert!(matches!(invocation(&["--react", "--plain"]), Ok(Invocation::Plain)));
    assert!(matches!(invocation(&["--react", "--help"]), Ok(Invocation::Help)));
    // A `--react` line does not read the exec verb as a route value; a `--plain` one reads no values strictly.
    assert!(matches!(invocation(&["--react", "--provider", "exec"]), Ok(Invocation::React)));
    assert_eq!(invocation(&["--react", "--model"]).unwrap_err(), "option --model requires a non-option value");
    assert!(matches!(invocation(&["--plain", "--model"]), Ok(Invocation::Plain)));
}

#[test]
fn help_anywhere_asks_for_the_usage() {
    assert!(super::HELP_TEXT.starts_with("mixdog ") && super::HELP_TEXT.ends_with("recall previous inputs.\n"));

    // `--help` or `-h` anywhere asks for the usage, a missing value beside it included; an unknown option is still refused.
    for argv in [&["--help"][..], &["say", "hi", "-h"], &["--provider", "--help"], &["--", "--help"]] {
        assert!(matches!(invocation(argv), Ok(Invocation::Help)), "{argv:?}");
    }
    assert_eq!(invocation(&["--help", "--bogus"]).unwrap_err(), "unknown option --bogus");
}

#[test]
fn the_usage_log_follows_the_environment_when_not_given() {
    let wrapper = Wrapper::try_parse_from(["exec", "go"]).unwrap();
    let Ok(Invocation::Run(opts)) = wrapper.args.into_invocation(Some("/log/usage.json".into())) else { panic!("`go` runs") };
    assert_eq!(opts.usage_log, Some(PathBuf::from("/log/usage.json")));
}

/// A path option's value is the word the OS gave, Unicode or not (an unpaired surrogate on Windows, a stray byte on Unix);
/// the rest of the line is read as text.
#[cfg(any(windows, unix))]
#[test]
fn a_path_that_is_not_unicode_is_kept() {
    use std::ffi::OsString;
    #[cfg(windows)]
    let path = <OsString as std::os::windows::ffi::OsStringExt>::from_wide(&[u16::from(b'd'), 0xD800]);
    #[cfg(unix)]
    let path = <OsString as std::os::unix::ffi::OsStringExt>::from_vec(vec![b'd', 0xFF]);
    let argv = [OsString::from("exec"), "--cwd".into(), path.clone(), "--usage-log".into(), path.clone(), "go".into()];
    let Ok(Invocation::Run(opts)) = Wrapper::try_parse_from(argv).unwrap().args.into_invocation(None) else { panic!("`go` runs") };
    assert_eq!((opts.message.as_str(), opts.cwd, opts.usage_log), ("go", PathBuf::from(&path), Some(PathBuf::from(&path))));
}

async fn implicit_session(dir: &Path) -> (FakeLauncher, i32, Arc<Out>) {
    let launcher = FakeLauncher::new("sess_exec_test", vec![Turn::Events(vec![usage(Some("gpt-fallback"), 11, 7, 3, 5), assistant("done"), completed()])]);
    let (code, sink) = run_with(options(dir), &launcher, dir, never()).await;
    (launcher, code, sink)
}

#[tokio::test]
async fn one_implicit_session_answers_on_a_headless_thread() {
    let dir = tempfile::tempdir().unwrap();
    let (launcher, code, sink) = implicit_session(dir.path()).await;

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
}

#[tokio::test]
async fn the_implicit_session_closes_then_stops_services_then_removes_its_root() {
    let dir = tempfile::tempdir().unwrap();
    let (launcher, _, _) = implicit_session(dir.path()).await;
    assert_eq!(*launcher.order.lock().unwrap(), ["close", "services"]);
    assert!(!launcher.root().exists());
    assert_eq!(leftover_roots(dir.path()), 0);
}

#[tokio::test]
async fn the_implicit_session_writes_its_usage_document() {
    let dir = tempfile::tempdir().unwrap();
    implicit_session(dir.path()).await;
    // The usage document: schema 1, one primary session with the route's model first and the model the usage named after it, and
    // totals equal to the one session's counts.
    let counts = json!({ "inputTokens": 11, "cacheTokens": 7, "cacheWriteTokens": 3, "outputTokens": 5, "toolCallCountApprox": 0 });
    let mut session = counts.clone();
    session["sessionId"] = json!("sess_exec_test");
    session["agentRole"] = json!("primary");
    session["models"] = json!(["gpt-test", "gpt-fallback"]);
    let document: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("usage.json")).unwrap()).unwrap();
    assert_eq!(document, json!({ "schemaVersion": 1, "sessions": [session], "totals": counts }));
}

#[tokio::test]
async fn the_implicit_session_sees_only_the_roots_own_environment() {
    let dir = tempfile::tempdir().unwrap();
    let (launcher, _, _) = implicit_session(dir.path()).await;
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
/// A web search's spend (a usage frame whose session is the run's `:native-web-search:` child) joins the run's totals, and the
/// model that served the search joins the observed models after the main one.
#[tokio::test]
async fn a_web_searchs_spend_joins_the_totals() {
    let main = json!({ "sessionId": "sess_exec_test", "source": "provider_send", "requestedModel": "gpt-test", "model": "gpt-test", "deltaInput": 11, "deltaOutput": 5, "deltaCachedRead": 7, "deltaCacheWrite": 3 });
    let search = json!({ "sessionId": "sess_exec_test:native-web-search:abc", "source": "native_web_search", "requestedModel": "gpt-search", "model": "gpt-search-2", "deltaInput": 40, "deltaOutput": 9, "deltaCachedRead": 12, "deltaCacheWrite": 2, "agentRole": "web-search" });
    let frame = |delta: &Value| notif("thread/tokenUsage/updated", json!({ "threadId": "t", "usage": delta }));
    assert!(matches!(super::feed::observe(&frame(&main)).as_slice(), [super::feed::Obs::Usage(_)]));
    assert!(matches!(super::feed::observe(&frame(&search)).as_slice(), [super::feed::Obs::SearchUsage(_)]));

    let dir = tempfile::tempdir().unwrap();
    let launcher = FakeLauncher::new("sess_exec_test", vec![Turn::Events(vec![frame(&main), frame(&search), assistant("done"), completed()])]);
    let (code, _) = run_with(options(dir.path()), &launcher, dir.path(), never()).await;
    assert_eq!(code, 0);
    let document: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("usage.json")).unwrap()).unwrap();
    assert_eq!(document["totals"], json!({ "inputTokens": 51, "cacheTokens": 19, "cacheWriteTokens": 5, "outputTokens": 14, "toolCallCountApprox": 0 }));
    assert_eq!(document["sessions"][0]["models"], json!(["gpt-test", "gpt-search-2"]));
}
/// `--json`: the run's events are printed as one JSON line each, in the order the core fed them, every line stamped with schema 1
/// and the run's clock, ending with the turn's summary and the result.
async fn json_session(dir: &Path) -> (FakeLauncher, i32, Arc<Out>) {
    std::fs::create_dir_all(dir.join("host-data")).unwrap();
    std::fs::write(dir.join("host-data").join("openai-oauth.json"), "{}").unwrap();
    let launcher = FakeLauncher::new("sess_json_test", vec![Turn::Events(lifecycle_script())]);
    let mut opts = options(dir);
    opts.provider = Some("openai-oauth".into());
    opts.json = true;
    let (code, sink) = run_with(opts, &launcher, dir, never()).await;
    (launcher, code, sink)
}

#[tokio::test]
async fn the_json_lifecycle_is_one_line_per_event_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let (_, code, sink) = json_session(dir.path()).await;

    assert_eq!((code, sink.stderr()), (0, Vec::<String>::new()));
    let lines = json_lines(&sink);
    let kinds: Vec<&str> = lines.iter().map(|line| line["type"].as_str().unwrap()).collect();
    assert_eq!(
        kinds,
        [
            "thread.started",
            "turn.started",
            "model.request.started",
            "model.request.completed",
            "item.completed",
            "item.started",
            "tool.batch.started",
            "item.completed",
            "tool.batch.completed",
            "notification",
            "model.request.started",
            "item.completed",
            "model.request.completed",
            "turn.completed",
            "result"
        ]
    );
}

#[tokio::test]
async fn every_json_line_is_stamped_with_the_reserved_thread_and_the_runs_clock() {
    let dir = tempfile::tempdir().unwrap();
    let (_, _, sink) = json_session(dir.path()).await;
    let lines = json_lines(&sink);
    // The stream's thread id is the one the exec reserves for its session (`exec_<32 hex>`), the same on every line.
    let thread = lines[0]["thread_id"].as_str().unwrap();
    assert!(thread.strip_prefix("exec_").is_some_and(|hex| hex.len() == 32 && hex.chars().all(|c| c.is_ascii_hexdigit())), "{thread}");
    assert!(lines.iter().all(|line| line["thread_id"] == thread && line["schema_version"] == 1 && line["timestamp"] == "2023-11-14T22:13:20.000Z"));
    assert_eq!(
        lines[0]["session"],
        json!({ "provider": "openai-oauth", "model": "gpt-test", "effort": "high", "fast": true, "cwd": "/app", "tool_mode": "full", "approval_mode": "implicit", "delegation": false, "web_search": false })
    );
}

#[tokio::test]
async fn a_json_tool_call_starts_in_progress_and_completes_with_its_timing() {
    let dir = tempfile::tempdir().unwrap();
    let (_, _, sink) = json_session(dir.path()).await;
    let lines = json_lines(&sink);
    // The tool call: started in progress, completed with its output and the phases of its timing in milliseconds from the marks.
    assert_eq!(lines[5]["item"]["status"], "in_progress");
    let done = &lines[7]["item"];
    assert_eq!((&done["output"], &done["status"], &done["duration_ms"]), (&json!("ok\n"), &json!("completed"), &json!(8)));
    assert_eq!(done["timing"], json!({ "queue_ms": 0, "dispatch_ms": 2, "execution_ms": 3, "batch_wait_ms": 1, "postprocess_ms": 2, "total_ms": 8 }));
}

#[tokio::test]
async fn the_json_turn_and_result_lines_carry_the_summed_usage() {
    let dir = tempfile::tempdir().unwrap();
    let (_, _, sink) = json_session(dir.path()).await;
    let lines = json_lines(&sink);
    assert_eq!(lines[13]["usage"], json!({ "input_tokens": 16, "cached_input_tokens": 7, "cache_write_input_tokens": 3, "output_tokens": 7, "tool_calls": 1 }));
    let result = &lines[14];
    assert_eq!(
        (&result["subtype"], &result["result"], &result["num_turns"], &result["provider_requests"]),
        (&json!("success"), &json!("done"), &json!(1), &json!(2))
    );
    assert_eq!(lines.last().unwrap()["tool_calls"], 1);
    let usage: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("usage.json")).unwrap()).unwrap();
    assert_eq!(usage["totals"]["toolCallCountApprox"], 1);
}

#[tokio::test]
async fn the_host_credential_file_is_bound_in_process_without_a_copy() {
    let dir = tempfile::tempdir().unwrap();
    let (launcher, _, _) = json_session(dir.path()).await;
    let bound = launcher.captured.lock().unwrap().as_ref().unwrap().credential.clone();
    assert_eq!(bound, Some(dir.path().join("host-data").join("openai-oauth.json")));
}

/// The pristine run root holds a config naming only the explicit route (one preset, the workflow `headless`, no MCP sources),
/// with the host's key bound in memory and an audit that counts nothing of the host's state copied.
fn pristine_boundary(dir: &Path) -> Boundary {
    let host_env: BTreeMap<String, String> =
        [("MIXDOG_X", "1"), ("OPENAI_API_KEY", "sk-host"), ("PATH", "p")].into_iter().map(|(name, value)| (name.to_owned(), value.to_owned())).collect();
    struct Key;
    impl HostCredentials for Key {
        fn api_key(&self, _provider: &str) -> Option<String> {
            Some("sk-host".into())
        }
        fn pool_credential(&self, _provider: &str, _dir: &Path) -> Option<PathBuf> {
            None
        }
    }
    Boundary::create(&BoundaryRequest {
        provider: "openai",
        model: "gpt-x",
        effort: Some("High"),
        fast: true,
        provider_config: None,
        route_profile: None,
        agents_dir: dir,
        host_env: &host_env,
        host_data_dir: dir,
        temp_dir: dir,
        credentials: &Key,
    })
    .unwrap()
}

#[test]
fn the_pristine_config_names_only_the_explicit_route_and_binds_the_key_in_memory() {
    let dir = tempfile::tempdir().unwrap();
    let boundary = pristine_boundary(dir.path());
    let preset = json!({ "id": "workflow-lead", "name": "WORKFLOW LEAD", "type": "agent", "tools": "full", "provider": "openai", "model": "gpt-x", "effort": "high", "fast": true });
    let config = |provider: Value| {
        json!({
            "builtins": {}, "providers": { "openai": provider }, "presets": [preset], "default": "workflow-lead",
            "workflow": { "active": "headless" }, "workflowRoutes": {}, "agents": {},
            "modelSettings": { "openai/gpt-x": { "effort": "high", "fast": true } }, "mcpServers": {},
        })
    };
    // The file on disk holds no key; the config the runtime loads has the host's key in the provider's entry.
    let written = std::fs::read_to_string(boundary.data_dir.join("mixdog-config.json")).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&written).unwrap(), json!({ "agent": config(json!({ "enabled": true })) }));
    assert_eq!(boundary.runtime_config, config(json!({ "enabled": true, "apiKey": "sk-host" })));
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
}

#[test]
fn the_pristine_audit_counts_nothing_of_the_hosts_state_copied() {
    let dir = tempfile::tempdir().unwrap();
    let boundary = pristine_boundary(dir.path());
    let written = std::fs::read_to_string(boundary.data_dir.join("mixdog-config.json")).unwrap();
    let sha256: String = sha2::Sha256::digest(written.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
    let off = |names: &[&str]| names.iter().map(|name| ((*name).to_owned(), json!(false))).collect::<serde_json::Map<_, _>>();
    assert_eq!(
        boundary.audit,
        json!({
            "schemaVersion": 1, "mode": "headless-exec-pristine", "provider": "openai", "model": "gpt-x", "effort": "high", "fast": true,
            "configSha256": sha256, "authMode": "in-process-api-key", "authArtifactFilesCopied": 0, "injectedModelCatalogFileCount": 0,
            "personalState": {
                "hostConfigRead": false,
                "behavioralStateFilesCopied": 0, "memoryFilesCopied": 0, "sessionFilesCopied": 0, "userProfileFilesCopied": 0,
                "pluginStateFilesCopied": 0, "channelStateFilesCopied": 0, "otherPersonalStateFilesCopied": 0,
            },
            "featuresEnabled": off(&["mcpSources", "skills", "bundledSkillSeeding", "coreMemoryBoot", "channelStart", "plugins", "userProfiles", "priorSessions"]),
        })
    );
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
}

#[test]
fn the_pristine_environment_drops_the_hosts_variables_and_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let boundary = pristine_boundary(dir.path());
    assert_eq!(boundary.env["MIXDOG_X"], None);
    assert_eq!(boundary.env["OPENAI_API_KEY"], None);
    assert!(boundary.credential.is_none());
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
}

/// `--tool-mode <mode>` reaches the core as the session's tool mode, whichever the mode; the run's outputs do not depend on it.
#[tokio::test]
async fn the_tool_mode_reaches_the_core_as_the_sessions_mode() {
    for mode in ["readonly", "full"] {
        let dir = tempfile::tempdir().unwrap();
        let usage_path = dir.path().join("usage.json");
        let argv = [
            "--provider",
            "anthropic",
            "--model",
            "claude-sonnet-4-6",
            "--cwd",
            "/work",
            "--tool-mode",
            mode,
            "--usage-log",
            usage_path.to_str().unwrap(),
            "go",
        ];
        let opts = parse(&argv).unwrap();
        let launcher = FakeLauncher::new("sess_exec_mode", vec![Turn::Events(vec![assistant("read it"), completed()])]);
        let (code, sink) = run_with(opts, &launcher, dir.path(), never()).await;

        assert_eq!((code, sink.stdout(), sink.stderr()), (0, vec!["read it\n".to_owned()], Vec::<String>::new()), "{mode}");
        let calls = launcher.calls();
        assert_eq!(calls[0].0, "thread/start");
        assert_eq!(calls[0].1["session"]["toolMode"], mode);
        assert_eq!(launcher.prompts(), ["go"]);
    }
}

/// The tool mode is `full` when the flag is absent; a mode the exec does not know is refused, as is the old `--readonly`.
#[test]
fn the_tool_mode_defaults_to_full_and_an_unknown_mode_is_refused() {
    assert_eq!(parse(&["--provider", "p", "--model", "m", "go"]).unwrap().tool_mode, ToolMode::Full);
    assert_eq!(parse(&["--tool-mode", "full", "go"]).unwrap().tool_mode, ToolMode::Full);
    assert_eq!(parse(&["--tool-mode", "readonly", "go"]).unwrap().tool_mode, ToolMode::Readonly);
    assert_eq!(parse(&["--tool-mode", "bogus", "go"]).unwrap_err(), "unknown option --tool-mode");
    assert_eq!(parse(&["--readonly", "go"]).unwrap_err(), "option --readonly is not supported for mixdog exec");
}

/// The Terminal-Bench `fable-xhigh` routing profile, as the harness passes it.
const FABLE_PROFILE: &str = r#"{
  "leadFallback": { "provider": "anthropic-oauth", "model": "claude-opus-4-8", "effort": "xhigh", "fast": false },
  "routes": {
    "lead": { "provider": "anthropic-oauth", "model": "claude-fable-5", "effort": "xhigh", "fast": false },
    "worker": { "provider": "openai-oauth", "model": "gpt-5.6-terra", "effort": "high", "fast": true },
    "heavy-worker": { "provider": "openai-oauth", "model": "gpt-6.1-sol", "effort": "xhigh", "fast": true },
    "reviewer": { "provider": "openai-oauth", "model": "gpt-6.1-sol", "effort": "xhigh", "fast": true }
  }
}"#;

fn shipped_agents(dir: &Path, roles: &[&str]) -> PathBuf {
    let agents = dir.join("agents");
    for role in roles {
        std::fs::create_dir_all(agents.join(role)).unwrap();
        std::fs::write(agents.join(role).join("agent.json"), "{}").unwrap();
    }
    agents
}

fn profile_boundary(dir: &Path, profile: &str) -> Result<Boundary, String> {
    let host = dir.join("host-data");
    std::fs::create_dir_all(&host).unwrap();
    std::fs::write(host.join("anthropic-oauth-credentials.json"), "{}").unwrap();
    std::fs::write(host.join("openai-oauth.json"), "{}").unwrap();
    let agents = shipped_agents(dir, &["worker", "heavy-worker", "reviewer", "advisor", "explore"]);
    let tmp = dir.join("tmp");
    std::fs::create_dir_all(&tmp).unwrap();
    Boundary::create(&BoundaryRequest {
        provider: "anthropic-oauth",
        model: "claude-fable-5",
        effort: Some("xhigh"),
        fast: false,
        provider_config: None,
        route_profile: Some(profile),
        agents_dir: &agents,
        host_env: &BTreeMap::new(),
        host_data_dir: &host,
        temp_dir: &tmp,
        credentials: &Creds,
    })
}

struct NoBots;

#[async_trait]
impl mixdog_core_run::run_host::route_chain::BotRoutes for NoBots {
    async fn bot_route(&self, _: &str) -> Result<Option<Option<Value>>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
        Ok(None)
    }
    async fn stored_bot_route(&self, _: &str) -> Result<Option<Value>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
        Ok(None)
    }
}

/// `--route-profile`: a multi-role profile reaches the run's config whole. A spawned worker, heavy worker and reviewer resolve
/// through the app's own route lookup (`configuredAgentRouteCandidates`, `resolveAgentSpawnPreset`) to the profile's routes, the
/// Lead's fallback is the default preset's chain, and the roles' provider is authenticated like the Lead's.
#[tokio::test]
async fn a_route_profiles_roles_resolve_as_spawned_agents_and_its_fallback_backs_the_lead() {
    let dir = tempfile::tempdir().unwrap();
    let boundary = profile_boundary(dir.path(), FABLE_PROFILE).unwrap();
    let config = boundary.runtime_config.as_object().unwrap();
    let profile: Value = serde_json::from_str(FABLE_PROFILE).unwrap();
    for role in ["worker", "heavy-worker", "reviewer"] {
        let candidates =
            mixdog_core_run::run_host::route_chain::route_candidates(config, role, &NoBots).await.unwrap_or_else(|_| panic!("{role}: the config is read"));
        let spawn = mixdog_agent::agent_tool::flow::preset::resolve_agent_spawn_preset(config, &json!({ "agent": role }), &candidates).unwrap();
        let want = &profile["routes"][role];
        for key in ["provider", "model", "effort", "fast"] {
            assert_eq!(spawn.preset[key], want[key], "{role}: {key}");
        }
        assert_eq!(spawn.preset_name, json!(format!("AGENT {}", role.to_uppercase())), "{role}");
    }
    let lead = mixdog_ai::service::admin_route::find_preset(config, config.get("default")).unwrap();
    assert_eq!(lead["fallbacks"], json!([profile["leadFallback"]]));
    assert_eq!((&lead["provider"], &lead["model"]), (&json!("anthropic-oauth"), &json!("claude-fable-5")));
    assert_eq!(boundary.role_credentials.iter().map(|binding| binding.provider.as_str()).collect::<Vec<_>>(), ["openai-oauth"]);
    assert_eq!(boundary.role_credentials[0].path, dir.path().join("host-data").join("openai-oauth.json"));
    assert_eq!(boundary.runtime_config["providers"]["openai-oauth"], json!({ "enabled": true, "websocket": true }));
    assert_eq!(boundary.audit["routeProfile"]["agents"]["reviewer"]["model"], "gpt-6.1-sol");
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
}

/// The headless Lead the exec starts on a route profile's boundary holds the `agent` tool (the session options
/// `thread/start` carries, written into its header as the core the exec established writes them), and the worker it
/// spawns resolves to the profile's route. The same Lead without a profile has no `agent` tool.
#[tokio::test]
async fn a_headless_lead_with_a_route_profile_can_spawn_a_worker_on_the_profiles_route() {
    let lead_surface = |boundary: &Boundary| {
        super::launcher::bind_exec_core(boundary);
        let route = super::Route { provider: "anthropic-oauth".into(), model: "claude-fable-5".into(), effort: Some("xhigh".into()), fast: false };
        let params = super::run::thread_start_params(&options(Path::new("/unused")), &route, super::run::delegates(boundary));
        let session: mixdog_app_protocol::v2::thread::ThreadSessionOptions = serde_json::from_value(params["session"].clone()).unwrap();
        let mut header = mixdog_store::schema::record::Header::new();
        mixdog_core_session::session::session_options::write_header(&session, &mut header);
        mixdog_tools::policy::surface::SessionSurface::from_header(&header, Vec::new())
    };
    let dir = tempfile::tempdir().unwrap();
    let boundary = profile_boundary(dir.path(), FABLE_PROFILE).unwrap();
    assert!(lead_surface(&boundary).refusal("agent", None).is_none(), "the Lead may call agent");
    let config = boundary.runtime_config.as_object().unwrap();
    let candidates = mixdog_core_run::run_host::route_chain::route_candidates(config, "worker", &NoBots).await.unwrap_or_else(|_| panic!("the config is read"));
    let spawn = mixdog_agent::agent_tool::flow::preset::resolve_agent_spawn_preset(config, &json!({ "agent": "worker" }), &candidates).unwrap();
    let want = json!({ "provider": "openai-oauth", "model": "gpt-5.6-terra", "effort": "high", "fast": true });
    for key in ["provider", "model", "effort", "fast"] {
        assert_eq!(spawn.preset[key], want[key], "{key}");
    }
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();

    let plain = tempfile::tempdir().unwrap();
    let boundary = profile_boundary(plain.path(), r#"{"routes": {}}"#).unwrap();
    assert!(lead_surface(&boundary).refusal("agent", None).is_some(), "without roles the Lead has no agent tool");
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
}

/// A profile the exec cannot apply fails before anything starts, naming what it cannot apply, and leaves no root.
#[test]
fn a_route_profile_the_exec_cannot_apply_is_refused_by_name() {
    let mut profile: Value = serde_json::from_str(FABLE_PROFILE).unwrap();
    let refused = |edit: &dyn Fn(&mut Value)| {
        let dir = tempfile::tempdir().unwrap();
        let mut changed = profile.clone();
        edit(&mut changed);
        let error = profile_boundary(dir.path(), &changed.to_string()).err().expect("refused");
        assert_eq!(std::fs::read_dir(dir.path().join("tmp")).unwrap().count(), 0, "{error}");
        error
    };
    let planner = refused(&|p| p["routes"]["planner"] = json!({ "provider": "openai-oauth", "model": "m" }));
    assert_eq!(planner, "--route-profile role \"planner\" is not an agent mixdog exec can run");
    let field = refused(&|p| p["routes"]["worker"]["contextTokens"] = json!(1000));
    assert_eq!(field, "--route-profile route \"worker\" field \"contextTokens\" cannot be applied by mixdog exec");
    let top = refused(&|p| p["notes"] = json!("x"));
    assert_eq!(top, "--route-profile field \"notes\" cannot be applied by mixdog exec");
    let lead = refused(&|p| p["routes"]["lead"]["model"] = json!("claude-opus-5"));
    assert!(lead.contains("route \"lead\""), "{lead}");
    let effort = refused(&|p| p["leadFallback"]["effort"] = json!("ultra"));
    assert_eq!(effort, "--route-profile route \"leadFallback\" field \"effort\" must be low, medium, high, xhigh, or max");
    let custom = refused(&|p| p["routes"]["worker"]["provider"] = json!("custom-x"));
    assert!(custom.contains("\"custom-x\""), "{custom}");
    // A role is the exact name of a shipped agent, never a path to one or another spelling of it.
    let elsewhere = tempfile::tempdir().unwrap();
    let outside = shipped_agents(elsewhere.path(), &["worker"]).join("worker");
    for role in ["../agents/worker", "./worker", "worker/", "Worker", outside.to_str().unwrap()] {
        let error = refused(&|p| p["routes"][role] = json!({ "provider": "openai-oauth", "model": "m" }));
        assert_eq!(error, format!("--route-profile role \"{role}\" is not an agent mixdog exec can run"));
    }
    // A route on a provider the core's config load drops (the retired local ones) is refused, by its name.
    for local in ["ollama", "lmstudio"] {
        let role = refused(&|p| p["routes"]["worker"]["provider"] = json!(local));
        assert_eq!(role, format!("--route-profile route \"worker\" provider \"{local}\" is not one mixdog exec can run"));
        let fallback = refused(&|p| p["leadFallback"]["provider"] = json!(local));
        assert_eq!(fallback, format!("--route-profile route \"leadFallback\" provider \"{local}\" is not one mixdog exec can run"));
    }
    // A provider behind a Developer option is unavailable on the run's config, which switches none on.
    for gated in ["cursor-oauth", "mimo-oauth", "antigravity-oauth"] {
        let role = refused(&|p| p["routes"]["reviewer"]["provider"] = json!(gated));
        assert_eq!(role, format!("--route-profile route \"reviewer\" provider \"{gated}\" is not one mixdog exec can run"));
        let fallback = refused(&|p| p["leadFallback"]["provider"] = json!(gated));
        assert_eq!(fallback, format!("--route-profile route \"leadFallback\" provider \"{gated}\" is not one mixdog exec can run"));
    }
    profile["routes"]["worker"]["provider"] = json!("xai");
    let dir = tempfile::tempdir().unwrap();
    let boundary = profile_boundary(dir.path(), &profile.to_string()).unwrap();
    assert_eq!(boundary.runtime_config["providers"]["xai"]["apiKey"], "sk-test-key", "an API-key role provider's key is bound in memory");
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
}

/// The Lead's own provider goes through the refusal every route does, with or without a profile, before anything is bound:
/// a retired local provider, or one behind a Developer option the run's config leaves off.
#[test]
fn a_lead_on_a_provider_the_core_drops_or_gates_is_refused() {
    for provider in ["ollama", "lmstudio", "cursor-oauth", "mimo-oauth", "antigravity-oauth"] {
        let lead = json!({ "provider": provider, "model": "m", "fast": false });
        let profile = json!({ "routes": { "lead": lead } }).to_string();
        for route_profile in [None, Some(profile.as_str())] {
            let dir = tempfile::tempdir().unwrap();
            let agents = shipped_agents(dir.path(), &["worker"]);
            let error = Boundary::create(&BoundaryRequest {
                provider,
                model: "m",
                effort: None,
                fast: false,
                provider_config: None,
                route_profile,
                agents_dir: &agents,
                host_env: &BTreeMap::new(),
                host_data_dir: dir.path(),
                temp_dir: dir.path(),
                credentials: &Creds,
            })
            .err()
            .expect("refused");
            assert_eq!(error, format!("route \"lead\" provider \"{provider}\" is not one mixdog exec can run"), "{route_profile:?}");
            assert!(std::fs::read_dir(dir.path()).unwrap().flatten().all(|entry| entry.file_name() == "agents"), "no root is left");
        }
    }
}

/// `--route-profile` stands with the other value options, and a run whose profile gives roles routes lets the Lead delegate.
#[tokio::test]
async fn a_route_profile_on_the_command_line_opens_delegation() {
    let dir = tempfile::tempdir().unwrap();
    shipped_agents(dir.path(), &["worker"]);
    let profile = r#"{"routes": {"worker": {"provider": "openai", "model": "gpt-worker", "effort": "high", "fast": true}}}"#;
    let mut opts = parse(&["--provider", "openai", "--model", "gpt-test", "--route-profile", profile, "go"]).unwrap();
    assert_eq!(opts.route_profile.as_deref(), Some(profile));
    opts.usage_log = Some(dir.path().join("usage.json"));
    opts.json = true;
    let launcher = FakeLauncher::new("sess_profile", vec![Turn::Events(vec![assistant("done"), completed()])]);
    let (code, sink) = run_with(opts, &launcher, dir.path(), never()).await;
    assert_eq!((code, sink.stderr()), (0, Vec::<String>::new()));
    assert_eq!(launcher.calls()[0].1["session"]["disallowDelegation"], false);
    assert_eq!(json_lines(&sink)[0]["session"]["delegation"], true, "the session line reports the delegation the run has");
}

/// The config the run's core loads from the boundary's file (`Config::open`, the core's own load and migration).
async fn core_config(boundary: &Boundary) -> mixdog_core_config::config::Config {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let file = boundary.data_dir.join("mixdog-config.json");
    let (config, _) = mixdog_core_config::config::Config::open(&file, Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.unwrap();
    config
}

mod adoption {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use mixdog_ai::service::admin_route::Obj;
    use mixdog_core_api::domain::provider::DeliveryState;
    use mixdog_core_api::domain::provider::ErrorKind;
    use mixdog_core_api::domain::provider::ProviderError;
    use mixdog_core_api::domain::provider::WireRequest;
    use mixdog_core_api::ids::ThreadId;
    use mixdog_core_domains::domains::ai_admin::chain::RouteFacts;
    use mixdog_core_domains::domains::ai_admin::route_service::LiveControls;
    use mixdog_core_domains::domains::ai_admin::route_service::SessionFollow;
    use mixdog_core_ports::ports::route::FollowOptions;
    use mixdog_core_ports::ports::route::Followed;
    use mixdog_core_ports::ports::route::Route;
    use mixdog_core_ports::ports::route_write::RouteWriter;
    use mixdog_tools::orch::util::PortError;
    use serde_json::Value;

    /// Every provider is ready and every model is one the catalog has not described.
    pub struct AnyModel;

    #[async_trait]
    impl RouteFacts for AnyModel {
        fn is_known(&self, _: &str, _: &Obj) -> bool {
            true
        }
        async fn ensure_ready(&self, _: &Obj, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn model_meta(&self, _: &str, _: &str) -> Value {
            Value::Null
        }
        fn window_meta(&self, _: &str, _: &str, _: &Value) -> Option<Value> {
            None
        }
        fn catalog_knows(&self, _: &str, _: &str) -> bool {
            true
        }
        fn fast_capable(&self, _: &str, _: &Value, _: Option<&str>, _: &Value) -> bool {
            true
        }
        fn ultrafast_capable(&self, _: &str, _: &Value) -> bool {
            false
        }
    }

    /// The live route of the thread being started.
    #[derive(Default)]
    pub struct Live(pub Mutex<Route>);

    #[async_trait]
    impl RouteWriter for Live {
        fn route(&self, _: &ThreadId) -> Route {
            self.0.lock().unwrap().clone()
        }
        fn set_route_state(&self, _: &ThreadId, route: Route) {
            *self.0.lock().unwrap() = route;
        }
        fn generation(&self, _: &ThreadId) -> u64 {
            0
        }
        async fn refresh_route_effort(&self, _: &ThreadId, _: Option<Value>, _: bool, _: Option<u64>) -> Result<Option<Route>, PortError> {
            Ok(None)
        }
        fn refresh_statusline_usage(&self, _: &ThreadId, _: &Route) {}
    }

    /// A thread that does not exist yet: nothing follows its route.
    pub struct Unborn;

    #[async_trait]
    impl SessionFollow for Unborn {
        fn open_lease(&self, _: &ThreadId, origin: Option<u64>) -> u64 {
            origin.unwrap_or(0)
        }
        async fn follow(&self, _: &ThreadId, _: &FollowOptions) -> Result<Followed, PortError> {
            Ok(Followed::default())
        }
        async fn tune(&self, _: &ThreadId) -> Result<(), PortError> {
            Ok(())
        }
        async fn has_session(&self, _: &ThreadId) -> Result<bool, PortError> {
            Ok(false)
        }
        async fn seat(&self, _: &ThreadId) -> Result<(), PortError> {
            Ok(())
        }
        async fn switch_now(&self, _: &ThreadId) -> Result<Option<Value>, PortError> {
            Ok(None)
        }
    }

    pub struct NoControls;

    impl LiveControls for NoControls {
        fn sync_live(&self, _: &mut dyn FnMut(&ThreadId)) {}
    }

    pub struct Offline;

    #[async_trait]
    impl mixdog_ai::transport::HttpSend for Offline {
        async fn send(&self, _: WireRequest, _: mixdog_ai::transport::Exchange) -> Result<mixdog_ai::transport::HttpResponse, ProviderError> {
            Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
        }
    }
}

/// R1: the thread the exec starts adopts the route its `thread/start` draft names (the core's `adopt_draft` over the config
/// the core loads); that thread's Lead falls back to the profile's `leadFallback` next.
#[tokio::test]
async fn the_started_threads_lead_falls_back_to_the_route_profiles_lead_fallback() {
    use mixdog_core_domains::domains::ai_admin::model_list::ModelListService;
    use mixdog_core_domains::domains::ai_admin::route_service::RouteService;
    use mixdog_core_session::session::NewThreadRoute;

    let dir = tempfile::tempdir().unwrap();
    let boundary = profile_boundary(dir.path(), FABLE_PROFILE).unwrap();
    let config = core_config(&boundary).await;
    let tokens = mixdog_rt::testing::tokens();
    let io = mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let source = mixdog_ai::catalog::ModelsDevSource::new(Arc::new(adoption::Offline), dir.path().to_path_buf(), io);
    let catalog = Arc::new(mixdog_ai::catalog::CatalogService::cold_start(mixdog_ai::catalog::CatalogSnapshot::default(), Vec::new(), source).await);
    let models = Arc::new(ModelListService {
        catalog,
        config: config.clone(),
        primary_provider: Arc::new(String::new),
        unsupported: Arc::new(mixdog_ai::service::effort_configuration::UnsupportedEfforts::default()),
        host: None,
    });
    let live = Arc::new(adoption::Live::default());
    let routes = RouteService {
        config: config.clone(),
        facts: Arc::new(adoption::AnyModel),
        writer: live.clone(),
        session: Arc::new(adoption::Unborn),
        models,
        controls: Arc::new(adoption::NoControls),
    };

    let route = super::Route { provider: "anthropic-oauth".into(), model: "claude-fable-5".into(), effort: Some("xhigh".into()), fast: false };
    let params = super::run::thread_start_params(&options(Path::new("/unused")), &route, super::run::delegates(&boundary));
    let draft: mixdog_protocol::ModelSelection = serde_json::from_value(params["draft"]["route"].clone()).unwrap();
    let thread = mixdog_core_api::ids::ThreadId::from("sess_exec_lead");
    let adopted = routes.adopt(&thread, Some(&mixdog_core_session::session::new_route::draft_pick(&draft))).await.unwrap();

    let mut session = adopted.clone();
    session.extend(mixdog_core_session::session::new_route::create_keys(&adopted).unwrap());
    session.insert("id".into(), json!("sess_exec_lead"));
    session.insert("owner".into(), json!("user"));
    let position = mixdog_core_run::run_host::route_chain::route_fallback_position(&Value::Object(session), &config.agent(), &NoBots).await.unwrap();
    assert_eq!(position["current"], json!({ "provider": "anthropic-oauth", "model": "claude-fable-5" }));
    assert_eq!(position["next"], json!({ "provider": "anthropic-oauth", "model": "claude-opus-4-8" }), "{position}");
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
}

/// R4, R5: every role the profile routes, the ones the shipped roster starts off (`advisor`, `explore`) among them, stays in
/// the config the core loads as the profile states it, is switched on, and resolves through the spawn plan's own checks
/// (`isAgentDisabled`, `configuredAgentRouteCandidates`, `resolveAgentSpawnPreset`) to its route.
#[tokio::test]
async fn every_role_a_route_profile_names_is_spawnable_on_the_config_the_core_loads() {
    let mut profile: Value = serde_json::from_str(FABLE_PROFILE).unwrap();
    profile["routes"]["advisor"] = json!({ "provider": "openai-oauth", "model": "gpt-6.1-sol", "effort": "high", "fast": false });
    profile["routes"]["explore"] = json!({ "provider": "anthropic-oauth", "model": "claude-haiku-5", "fast": false });
    let dir = tempfile::tempdir().unwrap();
    let boundary = profile_boundary(dir.path(), &profile.to_string()).unwrap();
    let loaded = core_config(&boundary).await.loaded_agent().await.unwrap();
    for role in ["worker", "heavy-worker", "reviewer", "advisor", "explore"] {
        assert_eq!(loaded["agents"][role], boundary.runtime_config["agents"][role], "{role}: the core keeps the route as the exec wrote it");
        assert!(!mixdog_core_config::config::agent_disabled(&loaded, role), "{role} is switched on");
        let candidates = mixdog_core_run::run_host::route_chain::route_candidates(&loaded, role, &NoBots).await.unwrap_or_else(|_| panic!("{role}"));
        let spawn = mixdog_agent::agent_tool::flow::preset::resolve_agent_spawn_preset(&loaded, &json!({ "agent": role }), &candidates).unwrap();
        for key in ["provider", "model"] {
            assert_eq!(spawn.preset[key], profile["routes"][role][key], "{role}: {key}");
        }
    }
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
}
