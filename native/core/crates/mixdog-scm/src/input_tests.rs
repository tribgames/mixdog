//! A caller that skips the phone's page reaches the core with the arguments Node's host checked before it acted. The core checks
//! them itself (`input.rs`), in the order Node's call evaluated them: it refuses what Node refused, with Node's text and before any
//! program starts, and it acts on what Node passed on. The expected answers are Node's own: every case of
//! `apps/desktop/src/renderer/fixtures/phone-scm/golden.json` whose call Node's host checked, each sent here as the core request the
//! page would have made of the phone's raw arguments (the page's own translation, scm-operation-route.ts, without its checks).
//!
//! The recording ran on Windows: its directories and its rule for an absolute path are Windows'.
#![cfg(windows)]

use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use serde_json::Value;
use serde_json::json;

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessInfo;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::PtySize;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_core_api::domain::process::SpawnedProcess;
use mixdog_protocol::ProcessHandle;

use crate::error::ScmFailure;
use crate::review_dispatch_tests::Log;
use crate::review_dispatch_tests::service_over;

/// Starts nothing and counts every program it was asked to start.
#[derive(Default)]
struct NoPrograms(AtomicUsize);

#[async_trait]
impl ProcessManager for NoPrograms {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(ProcessError::ProgramNotFound { program: format!("{:?}", request.command) })
    }
    fn subscribe(&self, _handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        Err(ProcessError::AlreadyExited)
    }
    async fn write_stdin(&self, _handle: &ProcessHandle, _bytes: Vec<u8>) -> Result<(), ProcessError> {
        Err(ProcessError::AlreadyExited)
    }
    fn close_stdin(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
        Err(ProcessError::AlreadyExited)
    }
    fn resize_pty(&self, _handle: &ProcessHandle, _size: PtySize) -> Result<(), ProcessError> {
        Err(ProcessError::AlreadyExited)
    }
    fn kill(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
        Err(ProcessError::AlreadyExited)
    }
    fn list(&self) -> Vec<ProcessInfo> {
        Vec::new()
    }
}

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../apps/desktop/src/renderer/fixtures/phone-scm/golden.json");

fn golden() -> Value {
    serde_json::from_str(&std::fs::read_to_string(GOLDEN).expect("the phone-scm recording")).expect("json")
}

/// The core request of a phone call: the page's translation (shared/scm-operation-route.ts) of the raw arguments. A missing argument
/// leaves its param out and `null` is sent as `null`, as the page's `positional` does. `None`: the call is not one Node's host
/// checked, or it names an argument the core has no param for (githubCliLoginOpenBrowser's options, the route's `null` slot).
fn request(call: &str, args: &[Value]) -> Option<(&'static str, Value)> {
    let positional = |method: &'static str, names: &[Option<&str>]| -> Option<(&'static str, Value)> {
        assert!(args.len() <= names.len(), "{call} takes at most {} arguments", names.len());
        let mut params = serde_json::Map::new();
        for (name, value) in names.iter().zip(args) {
            match name {
                Some(name) => {
                    params.insert((*name).to_owned(), value.clone());
                }
                None => return None,
            }
        }
        Some((method, Value::Object(params)))
    };
    let named = |names: &[&str]| -> serde_json::Map<String, Value> { names.iter().zip(args).map(|(name, value)| ((*name).to_owned(), value.clone())).collect() };
    let with = |method: &'static str, params: serde_json::Map<String, Value>| Some((method, Value::Object(params)));
    // `cwd` and an `input` object of the arguments after it (gitCommitPaths, gitDeleteBranch, gitRenameBranch).
    let wrapped = |method: &'static str, names: &[&str]| {
        let mut params = serde_json::Map::new();
        if let Some(cwd) = args.first() {
            params.insert("cwd".into(), cwd.clone());
        }
        let input: serde_json::Map<String, Value> = names.iter().zip(args.iter().skip(1)).map(|(name, value)| ((*name).to_owned(), value.clone())).collect();
        params.insert("input".into(), Value::Object(input));
        Some((method, Value::Object(params)))
    };
    // The pull request's value and merge method: a missing one is sent as null (scm-operation-route.ts `pullRequest`).
    let pull_request = |method: &'static str, names: &[&str]| {
        let mut params = named(names);
        for name in &names[1..] {
            params.entry((*name).to_owned()).or_insert(Value::Null);
        }
        with(method, params)
    };
    let review = |names: &[&str], patch: bool| {
        let mut params = named(names);
        params.insert("scope".into(), json!("repo"));
        if patch {
            params.insert("patch".into(), json!(true));
        }
        with("review/diff/get", params)
    };
    let cwd = |method: &'static str| positional(method, &[Some("cwd")]);
    match call {
        "gitStatus" => {
            let mut params = named(&["cwd"]);
            if let Some(Value::Object(options)) = args.get(1) {
                for key in ["reuseLineStats", "skipLineStats"] {
                    if let Some(value) = options.get(key) {
                        params.insert(key.into(), value.clone());
                    }
                }
            }
            with("git/status", params)
        }
        "gitDiff" => positional("git/diff", &[Some("cwd"), Some("path"), Some("staged"), Some("worktreeOnly"), Some("untracked")]),
        "gitApplyPatch" => positional("git/applyPatch", &[Some("cwd"), Some("path"), Some("patch"), Some("reverse")]),
        "gitStage" => positional("git/stage", &[Some("cwd"), Some("paths")]),
        "gitUnstage" => positional("git/unstage", &[Some("cwd"), Some("paths")]),
        "gitIgnore" => positional("git/ignore", &[Some("cwd"), Some("path"), Some("scope")]),
        "gitCommit" => positional("git/commit", &[Some("cwd"), Some("message")]),
        "gitCommitPaths" => wrapped("git/commitPaths", &["message", "paths"]),
        "gitAmend" => positional("git/amend", &[Some("cwd"), Some("message")]),
        "gitStash" => positional("git/stash", &[Some("cwd"), Some("message")]),
        "gitRevert" => positional("git/revertFile", &[Some("cwd"), Some("path"), Some("untracked"), Some("mode")]),
        "gitReview" => review(&["cwd", "source"], false),
        "gitReviewDiff" => review(&["cwd", "path", "untracked", "source"], true),
        "gitReviewDiffs" => review(&["cwd", "files", "source"], true),
        "gitStashApply" => positional("git/stashApply", &[Some("cwd"), Some("ref")]),
        "gitStashDrop" => positional("git/stashDrop", &[Some("cwd"), Some("ref")]),
        "gitRenameBranch" => wrapped("git/renameBranch", &["branch", "nextBranch"]),
        "gitDeleteBranch" => wrapped("git/deleteBranch", &["branch"]),
        "gitCreateTag" => positional("git/createTag", &[Some("cwd"), Some("value"), Some("at")]),
        "gitDeleteTag" => positional("git/deleteTag", &[Some("cwd"), Some("value")]),
        "gitLog" => positional("git/log", &[Some("cwd"), Some("query"), Some("skip"), Some("limit")]),
        "gitShow" => positional("git/show", &[Some("cwd"), Some("hash")]),
        "gitShowDiff" => positional("git/showDiff", &[Some("cwd"), Some("hash"), Some("path")]),
        "gitShowFile" => positional("git/showFile", &[Some("cwd"), Some("rev"), Some("path")]),
        "gitRequestContext" => positional("git/requestContext", &[Some("cwd"), Some("input")]),
        "gitResetToCommit" => positional("git/resetToCommit", &[Some("cwd"), Some("value"), Some("mode"), Some("confirmedDirty")]),
        "gitRevertCommit" => positional("git/revertCommit", &[Some("cwd"), Some("value")]),
        "gitCherryPickCommit" => positional("git/cherryPickCommit", &[Some("cwd"), Some("value")]),
        "setGitGlobalConfig" => positional("git/globalConfig/write", &[Some("key"), Some("value")]),
        "gitBranches" => cwd("git/branches"),
        "gitStashList" => cwd("git/stashList"),
        "gitStashPop" => cwd("git/stashPop"),
        "gitUndoLastCommit" => cwd("git/undoLastCommit"),
        "gitPush" => cwd("git/push"),
        "gitPull" => cwd("git/pull"),
        "gitFetch" => cwd("git/fetch"),
        "gitSync" => cwd("git/sync"),
        "gitContinue" => cwd("git/continue"),
        "gitAbortOperation" => cwd("git/abortOperation"),
        "githubRequest" => positional("github/request", &[Some("cwd"), Some("input")]),
        "ghPrList" => cwd("github/pr/list"),
        "ghPrDefaultBranch" => cwd("github/pr/defaultBranch"),
        "ghPrView" => pull_request("github/pr/view", &["cwd", "value"]),
        "ghPrDiff" => pull_request("github/pr/diff", &["cwd", "value"]),
        "ghPrCheckout" => pull_request("github/pr/checkout", &["cwd", "value"]),
        "ghPrCreate" => pull_request("github/pr/create", &["cwd", "value"]),
        "ghPrMerge" => pull_request("github/pr/merge", &["cwd", "value", "method"]),
        "githubCliLoginStatus" => positional("github/login/status", &[Some("flowId")]),
        "githubCliLoginCancel" => positional("github/login/cancel", &[Some("flowId")]),
        "githubCliLoginOpenBrowser" => positional("github/login/openBrowser", &[Some("flowId"), None]),
        _ => None,
    }
    .map(|(method, mut params)| {
        // The protocol's own field of a mutation, which the page's client adds (no argument of Node's).
        let spec = mixdog_app_protocol::client_method_spec(method).expect("a method of the table");
        if matches!(spec.mutation, mixdog_app_protocol::Mutation::Op(_)) {
            params["opId"] = json!("01890a5d-ac96-774b-bcce-b302099a8057");
        }
        (method, params)
    })
}

/// What Node's host passed on that the core's request carries: every argument of the operation, except the ones the page's
/// route has no param for (githubCliLoginOpenBrowser's options).
fn carried(operation: &str, args: &[Value]) -> Vec<Value> {
    match operation {
        "githubCliLoginOpenBrowser" => args[..1].to_vec(),
        _ => args.to_vec(),
    }
}

/// The recorded cases `pick` selects, sent to the core: every one Node's host refused is refused by the core with Node's text
/// (alone, a plain error with no code) and no program started; every one it acted on is acted on by the core with the arguments
/// Node passed on. The server's decode of the request lets each through to the owner. Answers how many of each it compared, and
/// how many cases `pick` selected.
async fn compare(pick: impl Fn(&str) -> bool) -> (usize, usize, usize) {
    let golden = golden();
    let programs = Arc::new(NoPrograms::default());
    let handle = service_over(programs.clone(), Log::default());
    let (mut refused, mut acted, mut picked) = (0, 0, 0);
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        if !pick(name) {
            continue;
        }
        picked += 1;
        // A params text is the frame's own spelling (`1.0`), which the parsed params no longer hold.
        let args: Value = match case.get("paramsText").and_then(Value::as_str) {
            Some(text) => serde_json::from_str(text).expect("params text"),
            None => case["params"].clone(),
        };
        let Some((method, params)) = request(case["call"].as_str().expect("call"), args.as_array().expect("params")) else {
            continue;
        };
        let wire = json!({ "id": 1, "method": method, "params": params });
        if let Err(error) = mixdog_app_protocol::ClientRequest::from_jsonrpc(serde_json::from_value(wire).expect("a request")) {
            panic!("{name}: the server refuses the request before its owner sees it: {error:?}");
        }
        let checked = crate::input::node_args(method, &params).unwrap_or_else(|| panic!("{name}: the core does not check {method}"));
        let ops = case["ops"].as_array().expect("ops");
        if ops.is_empty() {
            // Node's host refused before it acted.
            assert_eq!((case["frame"]["ok"].clone(), case["frame"].get("errorCode")), (json!(false), None), "{name}: {}", case["frame"]);
            let node = case["frame"]["error"].as_str().expect("Node's text");
            let expected = CoreError::DomainError { domain: "git".into(), code: Some("COMMAND_FAILED".into()), message: Some(node.into()), detail: None };
            match checked {
                Err(failure) => assert_eq!(CoreError::from(failure), expected, "{name}"),
                Ok(args) => panic!("{name}: the core acts on {args:?} where Node refused with {node:?}"),
            }
            let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Relay, Default::default());
            let answer = handle.call(CoreRequest { method: Method(method), params, op: None, ctx }).await;
            assert_eq!(answer.err(), Some(expected), "{name}: the service's answer");
            assert_eq!(programs.0.load(Ordering::SeqCst), 0, "{name}: the core started a program for a call Node refused before acting");
            refused += 1;
        } else {
            let operation = ops[0]["name"].as_str().expect("operation");
            let node = carried(operation, ops[0]["args"].as_array().expect("args"));
            match checked {
                Ok(core) => assert_eq!((core.operation, core.args), (operation, node), "{name}: what the call acts on"),
                Err(failure) => panic!("{name}: the core refuses ({failure:?}) where Node acted on {node:?}"),
            }
            acted += 1;
        }
    }
    (refused, acted, picked)
}

/// A group of cases: each one compared, some refused and some acted on as the recording has them.
async fn compare_group(prefixes: &[&str]) -> (usize, usize) {
    let (refused, acted, picked) = compare(|name| prefixes.iter().any(|prefix| name.starts_with(prefix))).await;
    assert!(picked > 0, "the recording has cases named {prefixes:?}");
    assert_eq!(refused + acted, picked, "every case of {prefixes:?} is compared");
    (refused, acted)
}

/// Every case of the recording whose call Node's host checked.
#[tokio::test]
async fn every_checked_call_is_refused_or_acted_on_as_nodes_host_did() {
    let (refused, acted, _) = compare(|_| true).await;
    assert!(refused > 0 && acted > 0, "{refused} refused and {acted} acted on");
}

/// An explicit `null` is refused where Node takes only a missing argument as the default (discard mode, ignore scope, review
/// source, request base); a missing one is the default.
#[tokio::test]
async fn a_null_is_not_a_missing_argument() {
    compare_group(&["input-null-", "input-missing-"]).await;
}

/// A number is `Number(value)` and then the integer and range checks: `"1"`, `true`, `[1]`, `1.0` are 1, `"0x10"` is 16.
#[tokio::test]
async fn a_history_page_is_counted_with_javascripts_number() {
    compare_group(&["input-number-"]).await;
}

/// Each argument of another JSON type alone, and two invalid arguments at once: the first argument Node's call evaluated answers.
#[tokio::test]
async fn the_first_argument_node_checked_answers() {
    compare_group(&["input-wrong-type-", "input-two-invalid-"]).await;
}

/// A repository-scoped request (a write the server serializes per repository) is keyed by the directory Node's host acted on, the
/// trimmed `cwd`; a request whose directory Node refused joins no repository's queue.
#[test]
fn a_repository_request_is_keyed_by_the_directory_node_acted_on() {
    let golden = golden();
    let (mut keyed, mut unkeyed) = (0, 0);
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let args = match case.get("paramsText").and_then(Value::as_str) {
            Some(text) => serde_json::from_str(text).expect("params text"),
            None => case["params"].clone(),
        };
        let Some((method, params)) = request(case["call"].as_str().expect("call"), args.as_array().expect("params")) else {
            continue;
        };
        let spec = mixdog_app_protocol::client_method_spec(method).expect("a method of the table");
        if !matches!(spec.scope, mixdog_app_protocol::ScopeRule::Repo { .. }) {
            continue;
        }
        let wire = json!({ "id": 1, "method": method, "params": params });
        let scope = mixdog_app_protocol::ClientRequest::from_jsonrpc(serde_json::from_value(wire).expect("a request")).expect("decodes").serialization_scope();
        if case["frame"]["error"] == "A project directory is required." {
            assert_eq!(scope, None, "{name}");
            unkeyed += 1;
        } else if let Some(op) = case["ops"].as_array().expect("ops").first() {
            let root = op["args"][0].as_str().expect("the directory Node acted on").to_owned();
            assert_eq!(scope, Some(mixdog_app_protocol::SerializationScope::Repo { root }), "{name}");
            keyed += 1;
        }
    }
    assert!(keyed > 0 && unkeyed > 0, "{keyed} keyed and {unkeyed} refused for their directory");
}

/// The global config key is one of three exact strings, checked after the value, with Node's text.
#[tokio::test]
async fn a_global_config_key_is_refused_with_nodes_text() {
    compare_group(&["input-config-key-"]).await;
}

/// The directory is trimmed of JavaScript's white space and absolute by Windows' `path.isAbsolute`.
#[tokio::test]
async fn a_directory_is_absolute_by_nodes_rule() {
    compare_group(&["input-cwd-"]).await;
}

/// A sign-in's flow id is trimmed before it is looked up; a GitHub request is checked before the Git & GitHub gate.
#[tokio::test]
async fn githubs_arguments_are_checked_as_nodes_host_did() {
    compare_group(&["input-flow-id-", "input-githubRequest-", "githubCliLoginStatus-padded-flow-id"]).await;
}

/// Node took a lone surrogate in a string (`"\ud800"`) as any other string and acted on it; the core's frame decoder cannot read
/// the frame that carries it and closes the connection, for every method. An open difference the manifest states; the case is on
/// record as Node's JSON text.
#[test]
fn a_lone_surrogate_node_acted_on_is_on_record() {
    let golden = golden();
    let limit = golden["limits"].as_array().expect("limits").iter().find(|limit| limit["name"] == "lone-surrogate-gitLog-query").expect("the case");
    let text = limit["paramsText"].as_str().expect("params text");
    assert!(text.contains("\\ud800"), "{text}");
    let args: Vec<&str> = text.trim_start_matches('[').trim_end_matches(']').splitn(2, ',').collect();
    let frame = format!(r#"{{"jsonrpc":"2.0","id":1,"method":"git/log","params":{{"cwd":{},"query":{}}}}}"#, args[0], args[1]);
    let decoded = mixdog_app_protocol::rpc::decode_inbound_text(&frame, 1 << 20);
    assert_eq!(decoded.close_code(), Some(mixdog_app_protocol::limits::CloseCode::InvalidFrame), "the core's frame decoder on {frame}");
    assert!(limit["recordedText"].as_str().expect("Node's answer").starts_with(r#"{"frame":{"ok":true,"#), "Node acted on it");
}

/// What Node put on gh's command line and fed it on stdin for an argument it read through a coercion is what the core builds:
/// the head sha that passed `/^[a-f0-9]{40}$/i.test` as a list goes into the REST body as that list, the merge method
/// (`String(method ?? 'merge')`) and the pull request's number (`Number(value)`, then `String(...)`) go on the command line as
/// those strings. Each case is built from the arguments Node's operation was given.
#[test]
fn a_coerced_argument_reaches_github_as_node_sent_it() {
    let golden = golden();
    let mut checked = 0;
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let Some(op) = case["ops"].as_array().expect("ops").first().filter(|_| name.starts_with("coerced-")) else {
            continue;
        };
        let args = op["args"].as_array().expect("args");
        let gh: Vec<&Value> = case["processes"].as_array().map(|all| all.iter().filter(|entry| entry["tool"] == "gh").collect()).unwrap_or_default();
        let sent = |lead: &[&str]| -> &Value {
            gh.iter().copied().find(|entry| lead.iter().enumerate().all(|(index, word)| entry["argv"][index] == *word)).unwrap_or_else(|| panic!("{name}: Node ran no gh {lead:?}"))
        };
        let argv = |entry: &Value| -> Vec<String> { entry["argv"].as_array().expect("argv").iter().map(|arg| arg.as_str().expect("an argument").to_owned()).collect() };
        match op["name"].as_str().expect("operation") {
            "githubRequest" => {
                let request = crate::gh::contract::validate(&args[1]).unwrap_or_else(|error| panic!("{name}: {error:?}"));
                let command = crate::gh::commands::build(&request).unwrap_or_else(|error| panic!("{name}: {error:?}"));
                let rest = sent(&["api"]);
                assert_eq!((command.args, command.input), (argv(rest), rest["stdin"].as_str().map(str::to_owned)), "{name}");
            }
            "ghPrMerge" => match (crate::gh::pr::merge_args(&args[1], &args[2]), op["error"]["message"].as_str()) {
                // `String(7)` and `String(true)` are no method's name: Node refused before running gh.
                (Err(error), Some(refused)) => assert_eq!(error, ScmFailure::git(refused), "{name}"),
                (Ok(args), None) => assert_eq!(args, argv(sent(&["pr", "merge"])), "{name}"),
                (core, node) => panic!("{name}: the core {core:?}, Node {node:?}"),
            },
            operation @ ("ghPrView" | "ghPrDiff" | "ghPrCheckout") => {
                let number = crate::gh::pr::required_number(&args[1]).unwrap_or_else(|error| panic!("{name}: {error:?}"));
                let verb = &operation[4..].to_lowercase();
                assert_eq!(number.to_string(), argv(sent(&["pr", verb]))[2], "{name}");
            }
            other => panic!("{name}: {other} is not a GitHub operation"),
        }
        checked += 1;
    }
    assert!(checked >= 7, "{checked} coerced cases acted on");
}

/// `requiredGitRevision` answers the revision rebuilt from its checked hash (git-contract.mjs: the hash before `^` is trimmed again).
#[test]
fn a_revision_is_rebuilt_from_its_checked_hash() {
    assert_eq!(crate::input::revision(" abcd ^ ").expect("a hash and its parent mark"), "abcd^");
    assert_eq!(crate::input::revision(" HEAD ").expect("HEAD"), "HEAD");
    assert_eq!(crate::input::revision("ABCDEF12").expect("a hash"), "ABCDEF12");
}
