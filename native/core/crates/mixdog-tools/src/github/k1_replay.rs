//! Replay of Node's K1 recording `fixtures/github-cases` (`record-github-cases.mjs`, b6f10295a): the GitHub requests the core
//! builds, sends and answers ([`GhClient::execute`], the body of `github/request` and of the agent's tool), and the text the
//! agent's `github` tool gives the model ([`GithubTool`] `call`, the registered tool), with `gh` scripted at the client's runner
//! (`GhRunner`, the injection point Node's tests used: `run`). Each case is compared whole against the recording; temp folders
//! are written `<tmp>\<prefix>-XXXXXX` on both sides.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the replay reads back the raw files the tool wrote")]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use futures::FutureExt;
use futures::future::BoxFuture;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use mixdog_scm::error::GITHUB_DOMAIN;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::gh::client::GhClient;
use mixdog_scm::gh::client::GhOutput;
use mixdog_scm::gh::client::GhRunner;
use mixdog_scm::gh::commands::GhCommand;
use mixdog_scm::gh::commands::build;
use mixdog_scm::gh::contract::ACTIONS;
use mixdog_scm::gh::contract::validate;
use mixdog_scm::locks::RepoLocks;
use mixdog_testkit::Exact;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::GithubTool;
use super::github_call_mutates;

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/github-cases/golden.json");
const REPO: &str = "owner/project";
const DEADLINE: Duration = Duration::from_secs(10);

fn recorded(index: usize, name: &str) -> Exact {
    let golden = Exact::load(GOLDEN);
    let case = &golden.get("cases").as_array()[index];
    assert_eq!(case.get("case").as_str(), name, "case {index} of {GOLDEN}");
    case.get("observed").clone()
}

fn plain(value: &Exact) -> Value {
    value.to_plain().expect("a plain recorded value")
}

fn sha() -> String {
    "a".repeat(40)
}

fn s(text: &str) -> Exact {
    Exact::String(text.to_owned())
}

fn o(entries: Vec<(&str, Exact)>) -> Exact {
    Exact::Object(entries.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

fn number(value: u64) -> Exact {
    Exact::Number(value as f64)
}

/// A `gh` command as Node's `buildGithubCommand` (or the repository probe) builds the object: a REST call carries its paging and
/// reading, a CLI call its hostname.
fn command(command: &GhCommand) -> Exact {
    let args = Exact::Array(command.args.iter().map(|arg| s(arg)).collect());
    let (json, mutation) = (Exact::Bool(command.json), Exact::Bool(command.mutation));
    match &command.hostname {
        None => o(vec![
            ("args", args),
            ("input", command.input.as_deref().map_or(Exact::Undefined, s)),
            ("json", json),
            ("list", Exact::Bool(command.list)),
            ("collection", command.collection.map_or(Exact::Undefined, s)),
            ("page", number(command.page)),
            ("limit", number(command.limit)),
            ("mutation", mutation),
        ]),
        Some(host) if command.json => o(vec![("args", args), ("hostname", s(host)), ("json", json), ("mutation", mutation)]),
        Some(host) => o(vec![("args", args), ("json", json), ("mutation", mutation), ("hostname", s(host))]),
    }
}

/// A refusal of the request is Node's `TypeError`; a failure of the run its `Error`.
fn failure(failure: &ScmFailure) -> Exact {
    let name = if matches!(failure, ScmFailure::Refused { .. }) { "TypeError" } else { "Error" };
    Exact::Error { name: name.to_owned(), message: failure.to_string(), code: None, cause: None, props: Vec::new() }
}

fn settled(outcome: &Result<Value, ScmFailure>) -> Exact {
    match outcome {
        Ok(value) => o(vec![("resolved", Exact::plain(value))]),
        Err(error) => o(vec![("rejected", failure(error))]),
    }
}

/// The recorder's scripted `run`: each command is kept, and answered by `answer`.
struct Scripted {
    answer: Box<dyn Fn(&GhCommand, usize) -> BoxFuture<'static, Result<String, ScmFailure>> + Send + Sync>,
    seen: Mutex<Vec<GhCommand>>,
}

impl Scripted {
    fn new(answer: impl Fn(&GhCommand, usize) -> BoxFuture<'static, Result<String, ScmFailure>> + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { answer: Box::new(answer), seen: Mutex::default() })
    }

    fn text(answer: impl Fn(&GhCommand, usize) -> String + Send + Sync + 'static) -> Arc<Self> {
        Self::new(move |command, index| {
            let text = answer(command, index);
            async move { Ok(text) }.boxed()
        })
    }

    fn fixed(text: &str) -> Arc<Self> {
        let text = text.to_owned();
        Self::text(move |_, _| text.clone())
    }

    fn commands(&self) -> Exact {
        Exact::Array(self.seen.lock().unwrap().iter().map(command).collect())
    }

    fn count(&self) -> usize {
        self.seen.lock().unwrap().len()
    }

    fn client(self: &Arc<Self>) -> Arc<GhClient> {
        Arc::new(GhClient::new(self.clone(), RepoLocks::new()))
    }
}

#[async_trait]
impl GhRunner for Scripted {
    async fn raw(&self, command: &GhCommand, _cwd: &Path, _cancel: &CancellationToken) -> Result<GhOutput, ScmFailure> {
        let index = {
            let mut seen = self.seen.lock().unwrap();
            seen.push(command.clone());
            seen.len() - 1
        };
        let stdout = (self.answer)(command, index).await?;
        Ok(GhOutput { code: Some(0), stdout, stderr: String::new() })
    }
}

/// The recorder's `responseFor`: an empty list (inside its collection), a small JSON object, or `done`.
fn response_for(command: &GhCommand) -> String {
    if command.list {
        return match command.collection {
            Some(collection) => format!("{{\"{collection}\":[]}}"),
            None => "[]".to_owned(),
        };
    }
    if command.json { r#"{"id":42,"number":7,"merged":true}"#.to_owned() } else { "done".to_owned() }
}

/// Temp folders as the recording writes them.
#[derive(Default)]
struct Masks(Vec<(String, String)>);

impl Masks {
    /// A fresh folder `<tmp>\<prefix>XXXXXX`.
    fn folder(&mut self, prefix: &str) -> tempfile::TempDir {
        let dir = tempfile::Builder::new().prefix(prefix).rand_bytes(6).tempdir().expect("a temp folder");
        let actual = dir.path().to_string_lossy().into_owned();
        let marker = format!("<tmp>\\{prefix}XXXXXX");
        self.0.push((actual.replace('\\', "/"), marker.replace('\\', "/")));
        self.0.push((actual, marker));
        dir
    }

    fn text(&self, text: &str) -> String {
        self.0.iter().fold(text.to_owned(), |text, (actual, marker)| text.replace(actual, marker))
    }

    fn unmask(&self, text: &str) -> String {
        self.0.iter().rev().fold(text.to_owned(), |text, (actual, marker)| text.replace(marker, actual))
    }

    fn exact(&self, value: &Exact) -> Exact {
        match value {
            Exact::String(text) => Exact::String(self.text(text)),
            Exact::Array(items) => Exact::Array(items.iter().map(|item| self.exact(item)).collect()),
            Exact::Object(entries) => Exact::Object(entries.iter().map(|(key, item)| (key.clone(), self.exact(item))).collect()),
            Exact::Error { name, message, code, cause, props } => Exact::Error {
                name: name.clone(),
                message: self.text(message),
                code: code.clone(),
                cause: cause.clone(),
                props: props.clone(),
            },
            other => other.clone(),
        }
    }

    fn value(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.unmask(text)),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.value(item)).collect()),
            Value::Object(object) => Value::Object(object.iter().map(|(key, item)| (key.clone(), self.value(item))).collect()),
            other => other.clone(),
        }
    }

    fn compare(&self, actual: &Exact, expected: &Exact, case: &str) {
        if let Some(difference) = self.exact(actual).difference(expected) {
            panic!("{case}: the core's outcome differs from Node's at {difference}");
        }
    }
}

/// The process cwd of the recording (`CWD`): an absolute folder no request writes to.
fn cwd() -> PathBuf {
    std::env::temp_dir()
}

/// `request(input, answer)`: the commands sent and the result or error of `executeGithubRequest`.
async fn request(input: Value, runner: Arc<Scripted>) -> Exact {
    let outcome = within("the request to settle", runner.client().execute(&input, &cwd(), &CancellationToken::new())).await;
    outcome_of(&input, &runner, &outcome)
}

/// `future`'s output, or a failure naming what did not happen within [`DEADLINE`].
async fn within<T>(what: &str, future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(DEADLINE, future).await.unwrap_or_else(|_| panic!("{what}: nothing within {DEADLINE:?}"))
}

/// A spawned task's output, within [`DEADLINE`].
async fn joined<T>(what: &str, task: tokio::task::JoinHandle<T>) -> T {
    within(what, task).await.unwrap_or_else(|error| panic!("{what}: the task failed: {error}"))
}

fn outcome_of(input: &Value, runner: &Scripted, outcome: &Result<Value, ScmFailure>) -> Exact {
    let mut entries = vec![("input", Exact::plain(input)), ("commands", runner.commands())];
    match outcome {
        Ok(result) => entries.push(("result", Exact::plain(result))),
        Err(error) => entries.push(("error", failure(error))),
    }
    o(entries)
}

/// `buildGithubCommand(input)`: the contract's check, then the command.
fn build_command(input: &Value) -> Result<GhCommand, ScmFailure> {
    build(&validate(input)?)
}

fn context(session: Option<(&str, &str)>) -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
    let (thread, call) = session.unwrap_or(("", ""));
    ToolContext {
        call_id: ToolCallId::from(call),
        thread_id: ThreadId::from(thread),
        turn_id: TurnId::from("r"),
        tool: "github".into(),
        cwd: AbsPath::new(cwd()).expect("an absolute cwd"),
        surface: SurfaceKind::Lead,
        cancel: CancellationToken::new(),
        deadline: None,
        progress: Arc::new(MockProgress::default()),
        io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        approvals: Arc::new(MockApprovalGate::default()),
        files: Arc::new(MockFileService::default()),
        processes: Arc::new(MockProcessManager::default()),
        options: Default::default(),
        review: None,
    }
}

/// The text the registered `github` tool gives the model for `input` (`executeGithubTool`).
async fn tool_text(runner: &Arc<Scripted>, data_dir: Option<&Path>, input: &Value, session: Option<(&str, &str)>) -> String {
    let tool = GithubTool::new(runner.client(), data_dir.map(Path::to_path_buf));
    match within("the github tool to answer", tool.call(&context(session), input.clone())).await {
        Ok(output) => match output.parts.as_slice() {
            [ToolPart::Text(text)] => text.clone(),
            other => panic!("the github tool answers one text part, not {other:?}"),
        },
        Err(error) => error.message_for_model,
    }
}

/// The recorder's `tool(input, answer, options)`: the commands, the text and the bytes of the text as stored (its temp folders
/// written as the recording writes them), and the raw file read back.
async fn tool(masks: &Masks, runner: Arc<Scripted>, data_dir: Option<&Path>, input: Value, session: Option<(&str, &str)>) -> Exact {
    let text = tool_text(&runner, data_dir, &input, session).await;
    let mut entries = vec![
        ("input", Exact::plain(&input)),
        ("commands", runner.commands()),
        ("textBytes", number(masks.text(&text).len() as u64)),
        ("text", s(&text)),
    ];
    let raw = serde_json::from_str::<Value>(&text).ok().and_then(|parsed| parsed.get("raw").and_then(Value::as_str).map(str::to_owned));
    if let Some(raw) = raw.filter(|raw| !raw.contains("unavailable")) {
        let content = mixdog_testkit::read_string(&raw);
        entries.push(("rawFile", Exact::plain(&serde_json::from_str::<Value>(&content).expect("the raw file is the JSON response"))));
    }
    o(entries)
}

fn json_text(value: &Value) -> String {
    mixdog_js::json_stringify(value)
}

#[tokio::test]
async fn case0_every_supported_operation_executes_through_a_bounded_non_interactive_request() {
    let expected = recorded(0, "every supported operation executes through a bounded, non-interactive request");
    let mut masks = Masks::default();
    let _directory = masks.folder("github-");
    let mut per_action = Vec::new();
    let mut examples = Vec::new();
    for case in expected.get("perAction").as_array() {
        let input = masks.value(&plain(case.get("input")));
        let action = input["action"].as_str().expect("an action").to_owned();
        let out = request(input, Scripted::text(|command, _| response_for(command))).await;
        let Exact::Object(mut entries) = out else { unreachable!() };
        let mutates = github_call_mutates(&json!({"action": action}));
        entries.push(("mutatesByContract".into(), Exact::Bool(mutates)));
        entries.push(("mutationToolByClassifier".into(), Exact::Bool(crate::github::github_call_mutates(&json!({"action": action})))));
        per_action.push(Exact::Object(entries));
        examples.push(s(&action));
    }
    let actual = o(vec![
        ("repo", s(REPO)),
        ("sha", s(&sha())),
        ("actionsInContract", Exact::Array(ACTIONS.iter().map(|def| s(def.name)).collect())),
        ("actionsInExamples", Exact::Array(examples)),
        ("perAction", Exact::Array(per_action)),
    ]);
    masks.compare(&actual, &expected, "case 0");
}

#[tokio::test]
async fn case1_invalid_requests_cannot_launch_a_process_or_smuggle_api_cli_flags() {
    let expected = recorded(1, "invalid requests cannot launch a process or smuggle API/CLI flags");
    let mut results = Vec::new();
    let mut launched = 0;
    for case in expected.get("results").as_array() {
        let runner = Scripted::fixed("{}");
        results.push(request(plain(case.get("input")), runner.clone()).await);
        launched += runner.count();
    }
    let actual = o(vec![
        ("results", Exact::Array(results)),
        ("processesLaunched", number(launched as u64)),
        ("mutatesUnknownAction", Exact::Bool(github_call_mutates(&json!({"action": "unknown"})))),
    ]);
    Masks::default().compare(&actual, &expected, "case 1");
}

#[test]
fn case2_korean_titles_and_shell_looking_bodies_remain_json_data() {
    let expected = recorded(2, "Korean titles and shell-looking bodies remain JSON data");
    let body = expected.get("body").as_str();
    let built = build_command(&json!({"action": "issue.create", "repo": REPO, "title": "--help", "body": body})).expect("the command");
    let parsed: Value = serde_json::from_str(built.input.as_deref().expect("a body")).expect("JSON");
    let actual = o(vec![("body", s(body)), ("command", command(&built)), ("inputParsed", Exact::plain(&parsed))]);
    Masks::default().compare(&actual, &expected, "case 2");
}

#[tokio::test]
async fn case3_workflow_filtered_run_lists_execute_once_without_a_failed_unfiltered_request() {
    let expected = recorded(3, "workflow-filtered run lists execute once without a failed unfiltered request");
    let mut filtered = Vec::new();
    for case in expected.get("filtered").as_array() {
        let runner = Scripted::fixed(&json_text(&json!({"workflow_runs": [{"id": 42}]})));
        filtered.push(request(plain(case.get("input")), runner).await);
    }
    let unsupported = validate(&json!({"action": "run.list", "repo": REPO, "state": "all"})).expect_err("state is no run.list field");
    let actual = o(vec![
        ("filtered", Exact::Array(filtered)),
        ("unfilteredCommand", command(&build_command(&json!({"action": "run.list", "repo": REPO})).expect("the command"))),
        ("unsupportedStateField", failure(&unsupported)),
    ]);
    Masks::default().compare(&actual, &expected, "case 3");
}

#[tokio::test]
async fn case4_repo_inference_binds_the_write_to_the_resolved_project_repository() {
    let expected = recorded(4, "repo inference binds the write to the resolved Project repository");
    let runner = Scripted::text(|_, index| if index == 0 { json_text(&json!({"nameWithOwner": REPO})) } else { json_text(&json!({"number": 9})) });
    let out = request(json!({"action": "issue.create", "title": "Bound"}), runner).await;
    Masks::default().compare(&o(vec![("cwd", s("<process cwd>")), ("out", out)]), &expected, "case 4");
}

#[tokio::test]
async fn case5_issues_paginate_on_the_original_page_even_when_it_only_contains_pull_requests() {
    let expected = recorded(5, "issues paginate on the original page even when it only contains pull requests");
    let runner = Scripted::fixed(&json_text(&json!([{"id": 1, "pull_request": {}}, {"id": 2, "pull_request": {}}])));
    let out = request(json!({"action": "issue.list", "repo": REPO, "page": 3, "limit": 2}), runner).await;
    Masks::default().compare(&o(vec![("out", out)]), &expected, "case 5");
}

#[tokio::test]
async fn case6_writes_serialize_a_failed_write_is_never_replayed_and_does_not_poison_the_next_call() {
    let expected = recorded(6, "writes serialize; a failed write is never replayed and does not poison the next call");
    let order = Arc::new(Mutex::new(Vec::<String>::new()));
    let (started, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let runner = {
        let (order, started, release) = (order.clone(), started.clone(), release.clone());
        Scripted::new(move |command, _| {
            let input: Value = serde_json::from_str(command.input.as_deref().expect("a body")).expect("JSON");
            let title = input["title"].as_str().expect("a title").to_owned();
            order.lock().unwrap().push(title.clone());
            let (started, release) = (started.clone(), release.clone());
            async move {
                if title == "first" {
                    started.notify_one();
                    release.notified().await;
                    return Err(ScmFailure::Command { domain: GITHUB_DOMAIN, text: "connection lost".into() });
                }
                Ok(r#"{"number":8}"#.to_owned())
            }
            .boxed()
        })
    };
    let client = runner.client();
    let write = |title: &str| {
        let client = client.clone();
        let input = json!({"action": "issue.create", "repo": REPO, "title": title});
        tokio::spawn(async move { client.execute(&input, &cwd(), &CancellationToken::new()).await })
    };
    let first = write("first");
    within("the first write to reach gh", started.notified()).await;
    // The client tells the moment a write starts waiting behind another write of its repository (`write-queue-hook`). Told
    // only now, while the first write holds the turn, so what it reports is the second write.
    let (queued_tx, queued_rx) = tokio::sync::oneshot::channel::<String>();
    let queued_tx = Mutex::new(Some(queued_tx));
    client.on_write_queued(move |key| {
        if let Some(tx) = queued_tx.lock().unwrap().take() {
            let _ = tx.send(key.to_owned());
        }
    });
    let second = write("second");
    // Serialized, the second write queues behind the first; unserialized, it would reach `gh` and never queue.
    let key = within("the second write to queue behind the first", queued_rx).await.expect("the hook is kept by the client");
    assert_eq!(key, format!("github.com/{REPO}"), "the second write queues on its repository's key");
    let while_held: Vec<Exact> = order.lock().unwrap().iter().map(|title| s(title)).collect();
    release.notify_one();
    let first = joined("the first write to settle", first).await;
    let second = joined("the second write to settle", second).await.expect("the second write succeeds");
    let actual = o(vec![
        ("orderWhileFirstHeld", Exact::Array(while_held)),
        ("first", settled(&first)),
        ("second", Exact::plain(&second)),
        ("orderAfter", Exact::Array(order.lock().unwrap().iter().map(|title| s(title)).collect())),
    ]);
    Masks::default().compare(&actual, &expected, "case 6");
}

#[tokio::test]
async fn case7_cancelled_and_existing_destination_requests_leave_files_and_remote_state_untouched() {
    let expected = recorded(7, "cancelled and existing-destination requests leave files and remote state untouched");
    let mut masks = Masks::default();
    let directory = masks.folder("github-protected-");
    let runner = Scripted::fixed("");
    let client = runner.client();
    let destination = directory.path().to_string_lossy().into_owned();
    let existing = client.execute(&json!({"action": "repo.clone", "repo": REPO, "destination": destination}), &cwd(), &CancellationToken::new()).await;
    let cancel = CancellationToken::new();
    cancel.cancel();
    let cancelled = client.execute(&json!({"action": "issue.list", "repo": REPO}), &cwd(), &cancel).await;
    let resolved = |outcome: &Result<Value, ScmFailure>| match outcome {
        Ok(_) => o(vec![("resolved", Exact::Bool(true))]),
        Err(error) => o(vec![("rejected", failure(error))]),
    };
    let actual = o(vec![
        ("destination", s(&destination)),
        ("existing", resolved(&existing)),
        ("cancelled", resolved(&cancelled)),
        ("calls", number(runner.count() as u64)),
    ]);
    masks.compare(&actual, &expected, "case 7");
}

#[tokio::test]
async fn case8_merge_refusal_and_unreadable_write_responses_are_errors_not_successful_actions() {
    let expected = recorded(8, "merge refusal and unreadable write responses are errors, not successful actions");
    let refused = request(json!({"action": "pr.merge", "repo": REPO, "number": 7, "sha": sha()}), Scripted::fixed(r#"{"merged":false,"message":"Head changed"}"#)).await;
    let unreadable = request(json!({"action": "issue.create", "repo": REPO, "title": "X"}), Scripted::fixed("not-json")).await;
    Masks::default().compare(&o(vec![("refused", refused), ("unreadable", unreadable)]), &expected, "case 8");
}

#[tokio::test]
async fn case9_the_agent_tool_is_registered_and_returns_the_ordinary_builtin_text_error_contract() {
    let recorded_case = recorded(9, "the agent tool is registered and returns the ordinary builtin text/error contract");
    // `isBuiltinTool('github')` is a fact of the product's registry, which this crate does not compose: the daemon's composed-core test
    // `compose::tests::the_github_tool_a_session_gets_is_nodes_builtin_one` compares it, read from this recording (the manifest says so).
    // The rest of the case, in its recorded order, is compared here.
    let expected = Exact::Object(recorded_case.entries().iter().filter(|(key, _)| key != "isBuiltinTool").cloned().collect());
    assert_eq!(recorded_case.entries().len(), 5, "case 9 records isBuiltinTool and the four tool answers");
    let value = tool_text(&Scripted::fixed(r#"{"full_name":"owner/project"}"#), None, &json!({"action": "repo.view", "repo": REPO}), None).await;
    let unsupported = tool_text(&Scripted::fixed(""), None, &json!({"action": "not-supported"}), None).await;
    let bounded = tool_text(&Scripted::fixed(&"한".repeat(100_000)), None, &json!({"action": "run.logs", "repo": REPO, "id": 42}), None).await;
    let actual = o(vec![
        ("builtinValue", s(&value)),
        ("unsupported", s(&unsupported)),
        ("bounded", s(&bounded)),
        ("boundedBytes", number(bounded.len() as u64)),
    ]);
    Masks::default().compare(&actual, &expected, "case 9");
}

#[tokio::test]
async fn case10_model_facing_results_drop_api_only_fields_keep_decision_fields_and_preserve_the_raw_response() {
    let expected = recorded(10, "model-facing results drop API-only fields, keep decision fields, and preserve the raw response");
    let mut masks = Masks::default();
    let data = masks.folder("github-raw-");
    let data = Some(data.path());
    let pr = plain(expected.get("pr"));
    let mut nested = pr["head"]["repo"].clone();
    nested["full_name"] = json!(REPO);
    let session = |call| Some(("sess_github_raw", call));
    let projected = tool(&masks, Scripted::fixed(&json_text(&pr)), data, json!({"action": "run.view", "repo": REPO, "id": 7}), session("call_1")).await;
    let repo_view = tool(&masks, Scripted::fixed(&json_text(&nested)), data, json!({"action": "repo.view", "repo": REPO}), None).await;
    let bodies: Vec<Value> = (1..=2).map(|number| json!({"number": number, "body": "y".repeat(20_000)})).collect();
    let bodies = tool(&masks, Scripted::fixed(&json_text(&json!(bodies))), data, json!({"action": "pr.list", "repo": REPO, "limit": 2}), session("call_bodies")).await;
    let page: Vec<Value> = (1..=60).map(|number| json!({"number": number, "title": "t".repeat(200)})).collect();
    let listed = tool(&masks, Scripted::fixed(&json_text(&json!(page))), data, json!({"action": "issue.list", "repo": REPO, "limit": 60}), session("call_2")).await;
    let merged = tool(
        &masks,
        Scripted::fixed(&json_text(&json!({"sha": sha(), "merged": true, "message": "Merged"}))),
        data,
        json!({"action": "pr.merge", "repo": REPO, "number": 7, "sha": sha()}),
        session("call_3"),
    )
    .await;
    let actual = o(vec![
        ("pr", Exact::plain(&pr)),
        ("projected", projected),
        ("repoView", repo_view),
        ("bodies", bodies),
        ("issueListSixty", listed),
        ("merged", merged),
        ("sessionIds", Exact::Array(vec![s("sess_github_raw")])),
    ]);
    masks.compare(&actual, &expected, "case 10");
}

#[tokio::test]
async fn case11_list_actions_return_compact_projected_rows_while_raw_keeps_the_full_response() {
    let expected = recorded(11, "list actions return compact projected rows while raw keeps the full response");
    let mut masks = Masks::default();
    let data = masks.folder("github-list-");
    let data = Some(data.path());
    let mut calls = Vec::new();
    for call in expected.get("calls").as_array() {
        let action = call.get("action").as_str();
        let items = plain(call.get("items"));
        let response = match call.get("collection") {
            Exact::String(collection) => Value::Object([(collection.clone(), items)].into_iter().collect()),
            _ => items,
        };
        let mut input = json!({"action": action, "repo": REPO});
        for (key, value) in plain(call.get("extra")).as_object().expect("extra fields") {
            input[key] = value.clone();
        }
        let call_id = format!("call_{action}");
        let out = tool(&masks, Scripted::fixed(&json_text(&response)), data, input, Some(("sess_github_list", &call_id))).await;
        calls.push(o(vec![
            ("action", s(action)),
            ("collection", call.get("collection").clone()),
            ("items", call.get("items").clone()),
            ("extra", call.get("extra").clone()),
            ("out", out),
        ]));
    }
    // `{ ...common, number: 1, title: 'Bug' }`, `common` as the first issue row holds it.
    let first = plain(&expected.get("calls").as_array()[0].get("items").as_array()[0]);
    let mut issue = serde_json::Map::new();
    for key in ["user", "body", "updated_at", "url", "reactions"] {
        issue.insert(key.to_owned(), first[key].clone());
    }
    issue.insert("number".into(), json!(1));
    issue.insert("title".into(), json!("Bug"));
    let view = tool(&masks, Scripted::fixed(&json_text(&Value::Object(issue))), data, json!({"action": "issue.view", "repo": REPO, "number": 1}), None).await;
    masks.compare(&o(vec![("calls", Exact::Array(calls)), ("issueView", view)]), &expected, "case 11");
}

#[tokio::test]
async fn case12_pr_view_and_issue_view_keep_the_decision_fields_cap_the_body_and_keep_raw_whole() {
    let expected = recorded(12, "pr.view and issue.view keep the decision fields, cap the body and keep raw whole");
    let mut masks = Masks::default();
    let data = masks.folder("github-view-");
    let data = Some(data.path());
    let masks = &masks;
    let view = |args: Value, payload: Value| {
        let call = format!("call_{}", args["action"].as_str().expect("an action"));
        let mut input = json!({"repo": REPO});
        for (key, value) in args.as_object().expect("args") {
            input[key] = value.clone();
        }
        async move { tool(&masks, Scripted::fixed(&json_text(&payload)), data, input, Some(("sess_github_view", &call))).await }
    };
    let pr = plain(expected.get("prPayload"));
    let issue = plain(expected.get("issuePayload"));
    // `noise`: the fields every payload of the recorder starts with.
    let mut generic = serde_json::Map::new();
    for key in ["id", "node_id", "url", "comments_url", "commits_url", "diff_url", "author_association", "performed_via_github_app", "reactions", "sub_issues_summary", "issue_dependencies_summary", "_links"] {
        generic.insert(key.to_owned(), pr[key].clone());
    }
    generic.insert("name".into(), json!("CI"));
    generic.insert("status".into(), json!("completed"));
    let generic = view(json!({"action": "run.view", "id": 5}), Value::Object(generic)).await;
    let enterprise = tool(&masks, Scripted::fixed(r#"{"full_name":"owner/project"}"#), data, json!({"action": "repo.view", "repo": REPO, "hostname": "ghe.example.com"}), None).await;
    let pr_view = view(json!({"action": "pr.view", "number": 7}), pr.clone()).await;
    let issue_view = view(json!({"action": "issue.view", "number": 7}), issue.clone()).await;
    let actual = o(vec![
        ("prPayload", Exact::plain(&pr)),
        ("prView", pr_view),
        ("issuePayload", Exact::plain(&issue)),
        ("issueView", issue_view),
        ("generic", generic),
        ("enterprise", enterprise),
    ]);
    masks.compare(&actual, &expected, "case 12");
}

#[tokio::test]
async fn case13_list_results_omit_raw_unless_rows_or_excerpts_were_cut() {
    let expected = recorded(13, "list results omit raw unless rows or excerpts were cut");
    let mut masks = Masks::default();
    let data = masks.folder("github-list-raw-");
    let data = Some(data.path());
    let masks = &masks;
    let list =|items: Vec<Value>, limit: Option<u64>| {
        let call = format!("call_{}_{}", items.len(), limit.unwrap_or(0));
        let mut input = json!({"action": "issue.list", "repo": REPO});
        if let Some(limit) = limit {
            input["limit"] = json!(limit);
        }
        async move { tool(&masks, Scripted::fixed(&json_text(&json!(items))), data, input, Some(("sess_github_list_raw", &call))).await }
    };
    let whole = list(vec![json!({"number": 1, "title": "T", "state": "open", "body": "short", "url": "u"})], None).await;
    let excerpt = list(vec![json!({"number": 1, "title": "T", "state": "open", "body": "x".repeat(500)})], None).await;
    let many: Vec<Value> = (1..=60).map(|number| json!({"number": number, "title": "t".repeat(200)})).collect();
    let rows = list(many, Some(60)).await;
    masks.compare(&o(vec![("whole", whole), ("excerptCut", excerpt), ("rowsCut", rows)]), &expected, "case 13");
}

#[tokio::test]
async fn case14_results_that_cannot_be_clamped_by_strings_still_fit_the_output_cap() {
    let expected = recorded(14, "results that cannot be clamped by strings still fit the output cap");
    let assets: Vec<Value> = (0..500).map(|index| json!({"id": index, "name": format!("asset-{index}.zip"), "size": index})).collect();
    let masks = Masks::default();
    let view = tool(
        &masks,
        Scripted::fixed(&json_text(&json!({"id": 42, "tag_name": "v1", "name": "One", "assets": assets}))),
        None,
        json!({"action": "release.view", "repo": REPO, "id": 42}),
        None,
    )
    .await;
    let mut wide = serde_json::Map::new();
    wide.insert("number".into(), json!(1));
    for index in 0..3000 {
        wide.insert(format!("k{index}"), json!(index));
    }
    let page = tool(&masks, Scripted::fixed(&json_text(&json!([Value::Object(wide), {"number": 2}]))), None, json!({"action": "issue.list", "repo": REPO, "limit": 2}), None).await;
    let actual = o(vec![("capBytes", number(super::reduce::output_max_bytes() as u64)), ("releaseView", view), ("wideList", page)]);
    masks.compare(&actual, &expected, "case 14");
}

#[test]
fn case15_review_requires_an_explicit_verdict_and_merges_require_an_exact_full_commit_identity() {
    let expected = recorded(15, "review requires an explicit verdict and merges require an exact full commit identity");
    let try_validate = |input: Value| match validate(&input) {
        Ok(_) => o(vec![("ok", Exact::Bool(true))]),
        Err(error) => o(vec![("threw", failure(&error))]),
    };
    let built = build_command(&json!({"action": "pr.review", "repo": REPO, "number": 1, "sha": sha(), "event": "APPROVE"})).expect("the command");
    let body: Value = serde_json::from_str(built.input.as_deref().expect("a body")).expect("JSON");
    let actual = o(vec![
        ("reviewWithoutEvent", try_validate(json!({"action": "pr.review", "repo": REPO, "number": 1, "sha": sha(), "body": "x"}))),
        ("mergeBranchName", try_validate(json!({"action": "pr.merge", "repo": REPO, "number": 1, "sha": "main"}))),
        ("approve", o(vec![("command", command(&built)), ("commitId", Exact::plain(&body["commit_id"]))])),
    ]);
    Masks::default().compare(&actual, &expected, "case 15");
}

#[tokio::test]
async fn case16_two_clones_cannot_claim_the_same_new_destination_even_for_different_repositories() {
    let expected = recorded(16, "two clones cannot claim the same new destination, even for different repositories");
    let mut masks = Masks::default();
    let directory = masks.folder("github-clone-race-");
    let destination = directory.path().join("clone").to_string_lossy().into_owned();
    let (claimed, proceed) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let executions = Arc::new(Mutex::new(0usize));
    let clone = |source: &str, hold: bool| {
        let (claimed, proceed, executions) = (claimed.clone(), proceed.clone(), executions.clone());
        let runner = Scripted::new(move |_, _| {
            *executions.lock().unwrap() += 1;
            let (claimed, proceed) = (claimed.clone(), proceed.clone());
            async move {
                if hold {
                    claimed.notify_one();
                    proceed.notified().await;
                }
                Ok("cloned".to_owned())
            }
            .boxed()
        });
        let input = json!({"action": "repo.clone", "repo": source, "destination": destination});
        tokio::spawn(async move { runner.client().execute(&input, &cwd(), &CancellationToken::new()).await })
    };
    let first = clone("owner/one", true);
    within("the first clone to claim its destination", claimed.notified()).await;
    let second = joined("the second clone to settle", clone("owner/two", false)).await;
    proceed.notify_one();
    let first = joined("the first clone to settle", first).await;
    let outcome = |outcome: &Result<Value, ScmFailure>| match outcome {
        Ok(value) => o(vec![("fulfilled", Exact::plain(value))]),
        Err(error) => o(vec![("rejected", failure(error))]),
    };
    let actual = o(vec![
        ("destination", s(&destination)),
        ("executions", number(*executions.lock().unwrap() as u64)),
        ("outcomes", Exact::Array(vec![outcome(&first), outcome(&second)])),
    ]);
    masks.compare(&actual, &expected, "case 16");
}
