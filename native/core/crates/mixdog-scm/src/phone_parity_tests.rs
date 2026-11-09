//! What the paired phone receives from the source-control methods, word for word as Node's host answered it
//! (`remote-methods.ts`, `gh-cli.ts`, `git-history.ts` at b6f10295a; recorded in
//! `apps/desktop/src/renderer/fixtures/phone-scm/golden.json`). One test per difference the phone replay found.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_api::state::SectionChange;
use mixdog_protocol::LoginFlowId;
use mixdog_protocol::SectionName;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::engine::Scm;
use crate::error::ScmFailure;
use crate::gh::client::GhOutput;
use crate::gh::client::GhRunner;
use crate::gh::commands::GhCommand;
use crate::review_dispatch_tests::Cwds;
use crate::review_dispatch_tests::Log;
use crate::review_dispatch_tests::Open;
use crate::review_dispatch_tests::Reviews;
use crate::service::ScmHandle;
use crate::service::ScmService;
use crate::testing::TestProcesses;

/// A machine without `gh`.
struct NoGh;

#[async_trait]
impl GhRunner for NoGh {
    async fn raw(&self, _: &GhCommand, _: &Path, _: &CancellationToken) -> Result<GhOutput, ScmFailure> {
        Err(ScmFailure::Unavailable { capability: "gh".into() })
    }
}

fn service() -> (ScmHandle, Arc<MockStatePublisher>) {
    service_with_gh_program("gh")
}

fn service_with_gh_program(program: &'static str) -> (ScmHandle, Arc<MockStatePublisher>) {
    let scm = Scm::with_gh(
        TestProcesses::shared(),
        mixdog_rt::testing::tokens().maintenance_io,
        std::env::temp_dir().join(format!("mixdog-scm-phone-{}", std::process::id())),
        Arc::new(NoGh),
        Arc::new(move || program.to_owned()),
    );
    let publisher = Arc::new(MockStatePublisher::default());
    let handle = ScmHandle(ScmService::new(
        scm,
        Arc::new(MockScopedFeeds::new(MockLimits::default())),
        publisher.clone(),
        Arc::new(Open),
        Arc::new(Reviews(Log::default())),
        Arc::new(Cwds),
    ));
    (handle, publisher)
}

async fn call(handle: &ScmHandle, method: &'static str, params: Value) -> Result<Value, CoreError> {
    let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Relay, Default::default());
    match handle.call(CoreRequest { method: Method(method), params, op: None, ctx }).await? {
        Reply::Value(value) => Ok(value),
        _ => panic!("{method} answers a value"),
    }
}

/// The text Node's error carried.
fn text(error: CoreError) -> (Option<String>, String) {
    match error {
        CoreError::DomainError { code, message, .. } => (code.map(|code| code.to_string()), message.map(|text| text.to_string()).unwrap_or_default()),
        other => panic!("not a domain error: {other:?}"),
    }
}

fn absolute() -> String {
    std::env::temp_dir().to_string_lossy().into_owned()
}

#[tokio::test]
async fn a_cwd_that_is_not_absolute_reads_as_nodes_requirement() {
    let (handle, _) = service();
    let error = call(&handle, "git/status", json!({ "cwd": "repo" })).await.unwrap_err();
    assert_eq!(text(error), (None, "A project directory is required.".to_owned()));
}

#[tokio::test]
async fn a_missing_gh_reads_as_nodes_text_for_the_account_the_logout_and_the_pull_requests() {
    let (handle, _) = service();
    for method in ["github/account", "github/logout"] {
        let error = call(&handle, method, json!({ "opId": "op" })).await.unwrap_err();
        assert_eq!(text(error), (None, "GitHub CLI is not installed.".to_owned()), "{method}");
    }
    let error = call(&handle, "github/pr/list", json!({ "cwd": absolute() })).await.unwrap_err();
    assert_eq!(
        text(error),
        (None, "GitHub CLI is not installed. Open Extensions → Plugin → Git & GitHub to install and connect it.".to_owned())
    );
}

#[tokio::test]
async fn pull_request_inputs_are_checked_with_nodes_words_and_a_numeric_string_is_a_number() {
    let (handle, _) = service();
    let cwd = absolute();
    // Number('12') is 12: the call goes on to run gh, which is missing here.
    let installed = call(&handle, "github/pr/view", json!({ "cwd": cwd, "value": "12" })).await.unwrap_err();
    assert!(text(installed).1.starts_with("GitHub CLI is not installed."));
    for (method, params, want) in [
        ("github/pr/view", json!({ "cwd": cwd, "value": "x" }), "A pull request number is required."),
        ("github/pr/diff", json!({ "cwd": cwd, "value": null }), "A pull request number is required."),
        ("github/pr/checkout", json!({ "opId": "o", "cwd": cwd, "value": 0 }), "A pull request number is required."),
        ("github/pr/merge", json!({ "opId": "o", "cwd": cwd, "value": 12, "method": "fast-forward" }), "A valid merge method is required."),
        ("github/pr/create", json!({ "opId": "o", "cwd": cwd, "value": null }), "Pull request input is required."),
        ("github/pr/create", json!({ "opId": "o", "cwd": cwd, "value": { "base": "main", "head": "x", "title": "t", "labels": [] } }), "Pull request input contains an unsupported field."),
        ("github/pr/create", json!({ "opId": "o", "cwd": cwd, "value": { "base": "main", "head": "x" } }), "pull request title must be a string."),
        ("github/pr/create", json!({ "opId": "o", "cwd": cwd, "value": { "base": "main", "head": "Main", "title": "t" } }), "Base branch must differ from the head branch."),
        ("github/pr/create", json!({ "opId": "o", "cwd": cwd, "value": { "base": "main", "head": "x", "title": "t", "body": 5 } }), "pull request body must be a string."),
        ("github/pr/create", json!({ "opId": "o", "cwd": cwd, "value": { "base": "main", "head": "x", "title": "t", "draft": "yes" } }), "pull request draft must be a boolean."),
    ] {
        let error = call(&handle, method, params).await.unwrap_err();
        assert_eq!(text(error), (None, want.to_owned()), "{method}");
    }
    // The merge method defaults to `merge` when it is absent (null).
    let merged = call(&handle, "github/pr/merge", json!({ "opId": "o", "cwd": cwd, "value": 12, "method": null })).await.unwrap_err();
    assert!(text(merged).1.starts_with("GitHub CLI is not installed."));
}

#[tokio::test]
async fn a_review_batch_names_the_files_it_cannot_serve_in_omitted() {
    let (_guard, repo, _head) = crate::golden_tests::fixture_repo();
    let (handle, _) = service();
    let reply = call(
        &handle,
        "review/diff/get",
        json!({ "scope": "repo", "cwd": repo.to_string_lossy(), "source": "uncommitted", "patch": true,
                "files": [{ "path": "we\"ird.txt" }, { "path": "a.txt" }, { "path": "back\\slash.txt" }] }),
    )
    .await
    .unwrap();
    assert_eq!(reply["omitted"], json!(["we\"ird.txt", "back\\slash.txt"]), "{reply}");
    let served: Vec<&str> = reply["patches"].as_array().unwrap().iter().map(|entry| entry["path"].as_str().unwrap()).collect();
    assert_eq!(served, ["a.txt"]);
}

#[tokio::test]
async fn a_repository_review_read_again_when_its_cached_result_was_dropped() {
    let attempts = std::sync::atomic::AtomicUsize::new(0);
    let page = crate::service::until_ready(|| async {
        let n = attempts.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok((n >= 2).then_some("patch text"))
    })
    .await
    .unwrap();
    assert_eq!((page, attempts.into_inner()), ("patch text", 3));
    let never: Result<(), ScmFailure> = crate::service::until_ready(|| async { Ok(None) }).await;
    assert_eq!(never.unwrap_err().to_string(), "The review changed while it was being read. Try again.");
}

#[test]
fn a_finished_or_failed_sign_in_keeps_the_code_and_the_page_it_showed() {
    let id = LoginFlowId("ghlogin_1_1".into());
    let device = ("ABCD-1234".to_owned(), "https://github.com/login/device".to_owned());
    assert_eq!(
        crate::service::flow_json(&id, &LoginState::Done { account: Some("octo".into()) }, Some(&device)),
        json!({ "flowId": "ghlogin_1_1", "state": "success", "login": "octo", "code": "ABCD-1234", "url": "https://github.com/login/device" })
    );
    assert_eq!(
        crate::service::flow_json(&id, &LoginState::Failed(mixdog_core_api::domain::login::LoginFailure::Denied), Some(&device)),
        json!({ "flowId": "ghlogin_1_1", "state": "error", "message": "GitHub denied the sign-in.", "code": "ABCD-1234", "url": "https://github.com/login/device" })
    );
    // Before a code was shown there is nothing to keep.
    assert_eq!(crate::service::flow_json(&id, &LoginState::Done { account: None }, None), json!({ "flowId": "ghlogin_1_1", "state": "success" }));
}

#[test]
fn a_deadline_names_the_program_the_way_nodes_runner_does() {
    let args: Vec<String> = ["status", "--porcelain=v2"].map(str::to_owned).to_vec();
    assert_eq!(crate::exec::command_label(r"C:\Program Files\Git\cmd\git.exe", &args), "git status --porcelain=v2");
    assert_eq!(crate::exec::command_label("/usr/bin/git", &args), "git status --porcelain=v2");
}

#[tokio::test]
async fn a_changed_global_git_identity_is_published_for_every_client() {
    let global = tempfile::NamedTempFile::new().unwrap();
    // The write goes to a scratch global config, never the developer's.
    unsafe { std::env::set_var("GIT_CONFIG_GLOBAL", global.path()) };
    let (handle, publisher) = service();
    let saved = call(&handle, "git/globalConfig/write", json!({ "opId": "op", "key": "user.name", "value": " Phone Dev " })).await.unwrap();
    assert_eq!(saved["name"], "Phone Dev");
    let published = publisher.published();
    let [(SectionName::HostState, Some(key), SectionChange::Set(bytes))] = published.as_slice() else { panic!("{published:?}") };
    assert_eq!(key, "gitConfig");
    assert_eq!(serde_json::from_slice::<Value>(bytes).unwrap(), saved);
}

#[tokio::test]
async fn a_repository_review_serves_an_untracked_file_as_every_line_added() {
    let (_guard, repo, _head) = crate::golden_tests::fixture_repo();
    let (handle, _) = service();
    let reply = call(
        &handle,
        "review/diff/get",
        json!({ "scope": "repo", "cwd": repo.to_string_lossy(), "source": "uncommitted", "patch": true, "files": [{ "path": "new.txt", "untracked": true }] }),
    )
    .await
    .unwrap();
    assert_eq!(
        reply["patches"][0]["patch"],
        json!("diff --git a/new.txt b/new.txt\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+untracked\n"),
        "{reply}"
    );
}
#[tokio::test]
async fn a_repository_review_of_one_untracked_file_reads_every_line_added() {
    let (_guard, repo, _head) = crate::golden_tests::fixture_repo();
    let (handle, _) = service();
    let reply = call(
        &handle,
        "review/diff/get",
        json!({ "scope": "repo", "cwd": repo.to_string_lossy(), "source": "uncommitted", "patch": true, "path": "new.txt", "untracked": true }),
    )
    .await
    .unwrap();
    assert_eq!(reply, json!("diff --git a/new.txt b/new.txt\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+untracked\n"));
}
#[tokio::test]
async fn a_remote_added_right_after_a_status_shows_only_when_its_minute_is_out() {
    use mixdog_core_api::domain::repo::RepoEvidence;
    use mixdog_core_api::domain::repo::RepoInspector;
    let (_guard, repo, _head) = crate::golden_tests::fixture_repo();
    let scm = Scm::new(
        TestProcesses::shared(),
        mixdog_rt::testing::tokens().maintenance_io,
        std::env::temp_dir().join(format!("mixdog-scm-remote-{}", std::process::id())),
    );
    let cancel = CancellationToken::new();
    assert_eq!(scm.git_status(&repo, &cancel).await.unwrap()["remote"], false);
    crate::golden_tests::git(&repo, &["remote", "add", "origin", "http://127.0.0.1:9/r.git"]);
    // A fresh scan, so only the kept remote list can still say there is none (git-status.ts remoteMetadata, 60 s).
    let reference = scm.open(&repo, &cancel).await.unwrap().repo_ref().unwrap();
    scm.inspector.evidence(&reference, RepoEvidence::WorkTree);
    let status = scm.git_status(&repo, &cancel).await.unwrap();
    assert_eq!(status["remote"], false, "{status}");
}
#[tokio::test]
async fn remote_metadata_expires_by_clock() {
    // Node's minute (GIT_METADATA_TTL_MS) on a moved clock: the list read at t0 holds at t0+59s and is read again at t0+61s.
    let (_guard, repo, _head) = crate::golden_tests::fixture_repo();
    let scm = Scm::new(
        TestProcesses::shared(),
        mixdog_rt::testing::tokens().maintenance_io,
        std::env::temp_dir().join(format!("mixdog-scm-remote-clock-{}", std::process::id())),
    );
    let cancel = CancellationToken::new();
    let options = crate::git::RunOptions::read();
    let at = |seconds: u64, t0: std::time::Instant| t0 + std::time::Duration::from_secs(seconds);
    let t0 = std::time::Instant::now();
    let (git, repo_ref, cancel_ref, options_ref) = (&scm.git, &repo, &cancel, &options);
    let names = |now| async move {
        crate::inspect::status::remote_metadata_at(git, cancel_ref, repo_ref, options_ref, now).await.unwrap().0
    };
    assert!(names(t0).await.is_empty());
    crate::golden_tests::git(&repo, &["remote", "add", "origin", "http://127.0.0.1:9/r.git"]);
    assert!(names(at(59, t0)).await.is_empty(), "kept for the minute");
    assert_eq!(names(at(61, t0)).await, ["origin"], "read again once the minute is out");
}
#[tokio::test]
async fn a_sign_in_without_gh_reads_as_nodes_text() {
    let (handle, _) = service_with_gh_program("mixdog-no-such-gh-program");
    let error = call(&handle, "github/login/start", json!({ "opId": "op" })).await.unwrap_err();
    assert_eq!(text(error), (None, "GitHub CLI is not installed.".to_owned()));
}
/// A `gh` that answers `--version` and the auth probe, and counts the version probes.
struct CountingGh(std::sync::atomic::AtomicUsize);

#[async_trait]
impl GhRunner for CountingGh {
    async fn raw(&self, command: &GhCommand, _: &Path, _: &CancellationToken) -> Result<GhOutput, ScmFailure> {
        if command.args == ["--version"] {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(GhOutput { code: Some(0), stdout: "gh version 2.50.0 (2024-06-01)\n".into(), stderr: String::new() })
    }
}

#[tokio::test]
async fn gh_is_probed_once_until_a_refresh_looks_again() {
    let counting = Arc::new(CountingGh(Default::default()));
    let scm = Scm::with_gh(
        TestProcesses::shared(),
        mixdog_rt::testing::tokens().maintenance_io,
        std::env::temp_dir().join(format!("mixdog-scm-probe-{}", std::process::id())),
        counting.clone(),
        Arc::new(|| "gh".to_owned()),
    );
    let cancel = CancellationToken::new();
    scm.gh_status(&cancel, false).await.unwrap();
    scm.gh_status(&cancel, false).await.unwrap();
    assert_eq!(counting.0.load(std::sync::atomic::Ordering::SeqCst), 1, "the second status reuses the first probe");
    scm.gh_status(&cancel, true).await.unwrap();
    assert_eq!(counting.0.load(std::sync::atomic::Ordering::SeqCst), 2, "a refresh probes again");
}
