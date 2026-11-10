//! A caller that skips the phone's page reaches the core with arguments Node's host would have refused before acting. The core
//! refuses them itself (`input.rs`), with Node's text and before any git runs. The expected texts are Node's own answers: the
//! `refused-*` cases of `apps/desktop/src/renderer/fixtures/phone-scm/golden.json`, each sent here as the core request the
//! page would have made of it.
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

/// The core request of a phone call: the page's own translation (remote-protocol-scm.ts), without its checks.
fn request(call: &str, args: &[Value]) -> (&'static str, Value) {
    let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
    let op = "01890a5d-ac96-774b-bcce-b302099a8057";
    match call {
        "gitReview" => ("review/diff/get", json!({ "scope": "repo", "cwd": arg(0), "source": arg(1) })),
        "gitReviewDiff" => ("review/diff/get", json!({ "scope": "repo", "cwd": arg(0), "path": arg(1), "untracked": arg(2) })),
        "gitReviewDiffs" => ("review/diff/get", json!({ "scope": "repo", "cwd": arg(0), "files": arg(1) })),
        "gitDiff" => ("git/diff", json!({ "cwd": arg(0), "path": arg(1), "staged": arg(2), "worktreeOnly": arg(3), "untracked": arg(4) })),
        "gitLog" => ("git/log", json!({ "cwd": arg(0), "query": arg(1), "skip": arg(2), "limit": arg(3) })),
        "gitShow" => ("git/show", json!({ "cwd": arg(0), "hash": arg(1) })),
        "gitShowDiff" => ("git/showDiff", json!({ "cwd": arg(0), "hash": arg(1), "path": arg(2) })),
        "gitShowFile" => ("git/showFile", json!({ "cwd": arg(0), "rev": arg(1), "path": arg(2) })),
        "gitRequestContext" => ("git/requestContext", json!({ "cwd": arg(0), "input": arg(1) })),
        "gitStage" => ("git/stage", json!({ "opId": op, "cwd": arg(0), "paths": arg(1) })),
        "gitUnstage" => ("git/unstage", json!({ "opId": op, "cwd": arg(0), "paths": arg(1) })),
        "gitCommit" => ("git/commit", json!({ "opId": op, "cwd": arg(0), "message": arg(1) })),
        "gitCommitPaths" => ("git/commitPaths", json!({ "opId": op, "cwd": arg(0), "input": { "message": arg(1), "paths": arg(2) } })),
        "gitAmend" => ("git/amend", json!({ "opId": op, "cwd": arg(0), "message": arg(1) })),
        "gitStash" => ("git/stash", json!({ "opId": op, "cwd": arg(0), "message": arg(1) })),
        "gitStashApply" => ("git/stashApply", json!({ "opId": op, "cwd": arg(0), "ref": arg(1) })),
        "gitStashDrop" => ("git/stashDrop", json!({ "opId": op, "cwd": arg(0), "ref": arg(1) })),
        "gitRevert" => ("git/revertFile", json!({ "opId": op, "cwd": arg(0), "path": arg(1), "untracked": arg(2), "mode": arg(3) })),
        "gitApplyPatch" => ("git/applyPatch", json!({ "opId": op, "cwd": arg(0), "path": arg(1), "patch": arg(2) })),
        "gitIgnore" => ("git/ignore", json!({ "opId": op, "cwd": arg(0), "path": arg(1), "scope": arg(2) })),
        "gitRenameBranch" => ("git/renameBranch", json!({ "opId": op, "cwd": arg(0), "input": { "branch": arg(1), "nextBranch": arg(2) } })),
        "gitDeleteBranch" => ("git/deleteBranch", json!({ "opId": op, "cwd": arg(0), "input": { "branch": arg(1) } })),
        "gitCreateTag" => ("git/createTag", json!({ "opId": op, "cwd": arg(0), "value": arg(1), "at": arg(2) })),
        "gitResetToCommit" => ("git/resetToCommit", json!({ "opId": op, "cwd": arg(0), "value": arg(1), "mode": arg(2) })),
        "gitRevertCommit" => ("git/revertCommit", json!({ "opId": op, "cwd": arg(0), "value": arg(1) })),
        "gitCherryPickCommit" => ("git/cherryPickCommit", json!({ "opId": op, "cwd": arg(0), "value": arg(1) })),
        "setGitGlobalConfig" => ("git/globalConfig/write", json!({ "opId": op, "key": arg(0), "value": arg(1) })),
        other => panic!("no core request is written here for the recorded call {other}"),
    }
}

#[tokio::test]
async fn every_argument_nodes_host_refused_is_refused_by_the_core_with_nodes_text_and_no_git() {
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(GOLDEN).expect("the phone-scm recording")).expect("json");
    let refused: Vec<&Value> = golden["cases"].as_array().expect("cases").iter().filter(|case| case["name"].as_str().is_some_and(|name| name.starts_with("refused-"))).collect();
    assert!(refused.len() >= 40, "the recording holds the refused cases ({} found)", refused.len());
    let programs = Arc::new(NoPrograms::default());
    let handle = service_over(programs.clone(), Log::default());
    for case in refused {
        let name = case["name"].as_str().expect("name");
        // Node's host ran nothing for it: no desktop operation and no program.
        assert_eq!((case["ops"].as_array().map(Vec::len), case.get("processes")), (Some(0), None), "{name}: Node acted on it");
        let node = case["frame"]["error"].as_str().unwrap_or_else(|| panic!("{name}: Node answered {}", case["frame"]));
        assert_eq!(case["frame"].get("errorCode"), None, "{name}: Node's refusal carries no code");
        let (method, params) = request(case["call"].as_str().expect("call"), case["params"].as_array().expect("params"));
        let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Relay, Default::default());
        let answer = handle.call(CoreRequest { method: Method(method), params, op: None, ctx }).await;
        // Node's frame is its text alone (`{ ok: false, error }`). The core's form of a plain git `Error` is the `git` domain's
        // `COMMAND_FAILED` with that text and no detail, which the phone's page turns back into the text alone (the adapter
        // replay compares that frame whole).
        match answer {
            Err(CoreError::DomainError { domain, code, message: Some(message), detail: None }) => {
                assert_eq!((&*domain, code.as_deref(), &*message), ("git", Some("COMMAND_FAILED"), node), "{name}")
            }
            other => panic!("{name}: the core answered {other:?}, Node refused with {node:?}"),
        }
        assert_eq!(programs.0.load(Ordering::SeqCst), 0, "{name}: the core started a program for a call Node refused before acting");
    }
}

/// `requiredGitRevision` answers the revision rebuilt from its checked hash (git-contract.mjs: the hash before `^` is trimmed again).
#[test]
fn a_revision_is_rebuilt_from_its_checked_hash() {
    assert_eq!(crate::input::revision(" abcd ^ ").expect("a hash and its parent mark"), "abcd^");
    assert_eq!(crate::input::revision(" HEAD ").expect("HEAD"), "HEAD");
    assert_eq!(crate::input::revision("ABCDEF12").expect("a hash"), "ABCDEF12");
}
