//! `review/diff/get` of a turn or a session: which of Node's five reads each parameter set picks, with what arguments,
//! and that the read's reply is the op's reply as it is (`getTurnReviewDiff`, `getTurnReviewFilePatch`, `getTurnChanges`,
//! `getSessionReviewDiff`, `getSessionReviewFilePatch`). The replies themselves are the turn review's own tests'.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_api::turn_review as tr;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

use crate::engine::Scm;
use crate::service::FeatureGate;
use crate::service::ScmHandle;
use crate::service::ScmService;
use crate::service::ThreadWorktrees;
use crate::testing::TestProcesses;

pub(crate) type Log = Arc<Mutex<Vec<Value>>>;

/// A review that answers `{ "read": name, ... }` and logs what it was asked.
pub(crate) struct Reviews(pub(crate) Log);

impl Reviews {
    fn answer(&self, call: Value) -> tr::Reply {
        self.0.lock().unwrap().push(call.clone());
        let mut reply = tr::Reply::new();
        reply.insert("read".into(), call);
        reply
    }
}

#[async_trait]
impl tr::TurnReviewApi for Reviews {
    async fn record_call(&self, _: &str, _: &str, _: &str, _: Vec<tr::CallChange>) {}
    async fn record_tool_changes(&self, _: &str, _: &str, _: Vec<tr::CallChange>) {}
    fn take_call_diff(&self, _: &str) -> Option<String> {
        None
    }
    fn note_change(&self, _: Option<&[String]>) {}
    async fn begin_turn(&self, _: &str, _: &str, _: tr::TurnOpen) -> Option<tr::TurnToken> {
        None
    }
    async fn complete_turn(&self, _: &str, _: Option<&tr::TurnToken>) -> bool {
        false
    }
    fn begin_agent_review(&self, _: &str, _: &str, _: &str, _: &str) -> Option<Box<dyn tr::AgentReview>> {
        None
    }
    fn forget_session(&self, _: &str) {}
    async fn turn_review_diff(&self, worktree: &str, session: &str, read: tr::ReviewRead) -> tr::Reply {
        self.answer(json!(["turnReviewDiff", worktree, session, read.known, read.summary]))
    }
    async fn turn_review_file_patch(&self, worktree: &str, session: &str, file: &str) -> tr::Reply {
        self.answer(json!(["turnReviewFilePatch", worktree, session, file]))
    }
    async fn session_review_diff(&self, worktree: &str, session: &str) -> tr::Reply {
        self.answer(json!(["sessionReviewDiff", worktree, session]))
    }
    async fn session_review_file_patch(&self, worktree: &str, session: &str, file: &str, old_path: &str) -> tr::Reply {
        self.answer(json!(["sessionReviewFilePatch", worktree, session, file, old_path]))
    }
    async fn revert_turn_review(&self, _: &str, _: &str, _: &str) -> Result<tr::Reply, tr::ReviewError> {
        Err(tr::ReviewError::new("not read"))
    }
    async fn revert_turn_review_file(&self, _: &str, _: &str, _: &str, _: &str) -> Result<tr::Reply, tr::ReviewError> {
        Err(tr::ReviewError::new("not read"))
    }
    async fn turn_changes(&self, session: &str, read: tr::ChangesRead) -> Result<tr::Reply, tr::ReviewError> {
        if read.checkpoint_id == "gone" {
            return Err(tr::ReviewError::type_error("checkpointId is required"));
        }
        Ok(self.answer(json!(["turnChanges", session, read.checkpoint_id, read.patch, read.file])))
    }
    async fn revert_turn_changes(&self, _: &str, _: &str, _: Option<&str>, _: f64) -> Result<tr::Reply, tr::ReviewError> {
        Err(tr::ReviewError::new("not read"))
    }
    async fn reapply_turn_changes(&self, _: &str, _: &str, _: Option<&str>, _: f64) -> Result<tr::Reply, tr::ReviewError> {
        Err(tr::ReviewError::new("not read"))
    }
    async fn clear_change_history(&self, _: &str) -> Result<tr::Reply, tr::ReviewError> {
        Err(tr::ReviewError::new("not read"))
    }
}

pub(crate) struct Open;

#[async_trait]
impl FeatureGate for Open {
    async fn github_enabled(&self) -> bool {
        true
    }
}

/// `t1` runs in `/work/t1`; any other thread has no header.
pub(crate) struct Cwds;

#[async_trait]
impl ThreadWorktrees for Cwds {
    async fn cwd(&self, thread: &ThreadId) -> Result<Option<String>, CoreError> {
        Ok((thread.as_str() == "t1").then(|| "/work/t1".to_owned()))
    }
}

fn service(log: Log) -> ScmHandle {
    service_over(TestProcesses::shared(), log)
}

/// The service with `processes` as the only way it can start a program.
pub(crate) fn service_over(processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager>, log: Log) -> ScmHandle {
    let scm = Scm::new(processes, mixdog_rt::testing::tokens().maintenance_io, std::env::temp_dir().join(format!("mixdog-scm-review-{}", std::process::id())));
    ScmHandle(ScmService::new(
        scm,
        Arc::new(MockScopedFeeds::new(MockLimits::default())),
        Arc::new(MockStatePublisher::default()),
        Arc::new(Open),
        Arc::new(Reviews(log)),
        Arc::new(Cwds),
    ))
}

async fn get(handle: &ScmHandle, params: Value) -> Result<Value, CoreError> {
    let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, Default::default());
    match handle.call(CoreRequest { method: Method("review/diff/get"), params, op: None, ctx }).await? {
        Reply::Value(value) => Ok(value),
        _ => panic!("a review answers a value"),
    }
}

#[tokio::test]
async fn each_parameter_set_picks_the_read_node_runs() {
    let log = Log::default();
    let handle = service(log.clone());
    let cases = [
        // getTurnReviewDiff({ summary: true, known })
        (json!({ "scope": "turn", "threadId": "t1", "summary": true, "known": "abc" }), json!(["turnReviewDiff", "", "t1", "abc", true])),
        (json!({ "scope": "turn", "threadId": "t1" }), json!(["turnReviewDiff", "", "t1", null, false])),
        // getTurnReviewFilePatch(file)
        (json!({ "scope": "turn", "threadId": "t1", "path": "src/a.rs" }), json!(["turnReviewFilePatch", "", "t1", "src/a.rs"])),
        // getTurnChanges({ checkpointId, patch, file })
        (json!({ "scope": "turn", "threadId": "t1", "checkpointId": "cp1" }), json!(["turnChanges", "t1", "cp1", false, null])),
        (json!({ "scope": "turn", "threadId": "t1", "checkpointId": "cp1", "patch": true, "path": "b.rs" }), json!(["turnChanges", "t1", "cp1", true, "b.rs"])),
        // getSessionReviewDiff() and getSessionReviewFilePatch(file, oldPath)
        (json!({ "scope": "session", "threadId": "t1" }), json!(["sessionReviewDiff", "/work/t1", "t1"])),
        (json!({ "scope": "session", "threadId": "t1", "path": "n.rs", "oldPath": "o.rs" }), json!(["sessionReviewFilePatch", "/work/t1", "t1", "n.rs", "o.rs"])),
        (json!({ "scope": "session", "threadId": "t1", "path": "n.rs" }), json!(["sessionReviewFilePatch", "/work/t1", "t1", "n.rs", ""])),
    ];
    for (params, expected) in cases {
        assert_eq!(get(&handle, params.clone()).await.unwrap(), json!({ "read": expected }), "{params}");
    }
    assert_eq!(log.lock().unwrap().len(), 8, "one read each");
}

#[tokio::test]
async fn a_review_failure_keeps_the_message_node_threw() {
    let handle = service(Log::default());
    let error = get(&handle, json!({ "scope": "turn", "threadId": "t1", "checkpointId": "gone" })).await.unwrap_err();
    assert_eq!(
        error,
        CoreError::DomainError { domain: "turnReview".into(), code: None, message: Some("checkpointId is required".into()), detail: None }
    );
}

#[tokio::test]
async fn a_thread_review_needs_its_thread_and_a_session_review_a_known_one() {
    let handle = service(Log::default());
    for params in [json!({ "scope": "turn" }), json!({ "scope": "session" })] {
        assert!(matches!(get(&handle, params).await, Err(CoreError::InvalidParams { path, .. }) if &*path == "threadId"));
    }
    assert!(matches!(
        get(&handle, json!({ "scope": "session", "threadId": "t2" })).await,
        Err(CoreError::ThreadNotFound { thread_id }) if thread_id.as_str() == "t2"
    ));
}

/// The repository form (`scope: repo`, `gitReview`) over a real repository answers Node's `GitReviewResult` and nothing more:
/// the harness recorded `{repository, root, base, files, untrackedOmitted}` for `gitReview` (no `key`, which only the thread review
/// carries for `known`, and no `totals`), and each row is `GitReviewFile`: `path`, `status`, `additions`, `deletions`,
/// `untracked`, `revision`.
#[tokio::test]
async fn a_repository_review_has_the_fields_of_nodes_git_review_and_no_key() {
    let (_guard, repo, _head) = crate::golden_tests::fixture_repo();
    let handle = service(Log::default());
    let reply = get(&handle, json!({ "scope": "repo", "cwd": repo.to_string_lossy() })).await.unwrap();
    let keys = |value: &Value| value.as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>();
    let expected = |names: &[&str]| names.iter().map(|name| (*name).to_owned()).collect::<std::collections::BTreeSet<_>>();
    assert_eq!(keys(&reply), expected(&["repository", "root", "base", "files", "untrackedOmitted"]), "{reply}");
    assert_eq!((reply["repository"].clone(), reply["base"].clone(), reply["untrackedOmitted"].clone()), (json!(true), json!("main"), json!(0)));
    let rows = reply["files"].as_array().unwrap();
    assert!(!rows.is_empty(), "the fixture has edits");
    for row in rows {
        assert_eq!(keys(row), expected(&["path", "status", "additions", "deletions", "untracked", "revision"]), "{row}");
    }
    let untracked = rows.iter().find(|row| row["path"] == "new.txt").expect("the untracked file is listed");
    assert_eq!((untracked["status"].clone(), untracked["additions"].clone(), untracked["deletions"].clone(), untracked["untracked"].clone()), (json!("A"), json!(1), json!(0), json!(true)));
}


#[cfg(node_twin)]
include!("node-twin/review_dispatch_tests.rs");

/// A repository with `base` committed and the worktree left to the test.
fn review_repo(files: &[(&str, &str)]) -> (tempfile::TempDir, std::path::PathBuf) {
    use crate::golden_tests::git;
    let dir = tempfile::tempdir().unwrap();
    let repo = std::fs::canonicalize(dir.path()).unwrap().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "core.autocrlf", "false"]);
    for (name, text) in files {
        let path = repo.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "base"]);
    (dir, repo)
}

/// A review over a dirty repository lists a modified, a staged-added, a deleted and a renamed file (the review reads without
/// renames: a delete and an add), a changed file in a folder, and untracked files, each with its line counts; a deleted file's
/// revision is `deleted` and any other's is `size:mtimeNs:ctimeNs:ino`.
#[tokio::test]
async fn a_dirty_repository_review_lists_every_kind_of_change_with_its_counts() {
    use crate::golden_tests::git;
    let (_dir, repo) = review_repo(&[("mod.txt", "one\ntwo\nthree\n"), ("del.txt", "gone\nsoon\n"), ("ren.txt", "alpha\nbeta\ngamma\ndelta\n"), ("same.txt", "unchanged\n"), ("dir/inner.txt", "in\n")]);
    std::fs::write(repo.join("mod.txt"), "one\nTWO\nthree\nfour\n").unwrap();
    std::fs::remove_file(repo.join("del.txt")).unwrap();
    std::fs::write(repo.join("added.txt"), "added\nlines\n").unwrap();
    git(&repo, &["add", "added.txt"]);
    git(&repo, &["mv", "ren.txt", "moved.txt"]);
    std::fs::write(repo.join("dir/inner.txt"), "in\nside\n").unwrap();
    std::fs::write(repo.join("new.txt"), "untracked\n").unwrap();

    let reply = get(&service(Log::default()), json!({ "scope": "repo", "cwd": repo.to_string_lossy() })).await.unwrap();
    assert_eq!((&reply["repository"], &reply["base"], &reply["untrackedOmitted"]), (&json!(true), &json!("main"), &json!(0)));
    let rows: Vec<(String, String, u64, u64, bool)> = reply["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| (row["path"].as_str().unwrap().to_owned(), row["status"].as_str().unwrap().to_owned(), row["additions"].as_u64().unwrap(), row["deletions"].as_u64().unwrap(), row["untracked"].as_bool().unwrap()))
        .collect();
    let row = |path: &str, status: &str, additions, deletions, untracked| (path.to_owned(), status.to_owned(), additions, deletions, untracked);
    // Sorted by path, case-insensitively.
    assert_eq!(
        rows,
        [
            row("added.txt", "A", 2, 0, false),
            row("del.txt", "D", 0, 2, false),
            row("dir/inner.txt", "M", 1, 0, false),
            row("mod.txt", "M", 2, 1, false),
            row("moved.txt", "A", 4, 0, false),
            row("new.txt", "A", 1, 0, true),
            row("ren.txt", "D", 0, 4, false),
        ]
    );
    for file in reply["files"].as_array().unwrap() {
        let revision = file["revision"].as_str().unwrap();
        if file["status"] == "D" {
            assert_eq!(revision, "deleted");
        } else {
            assert!(revision.split(':').count() == 4 && revision.split(':').all(|part| part.parse::<u64>().is_ok()), "{}: {revision}", file["path"]);
        }
    }
}

/// Past 256 untracked files the review lists the first 256 (in git's byte order of paths), counts the rest in `untrackedOmitted`,
/// and never caps the tracked rows.
#[tokio::test]
async fn untracked_rows_past_the_limit_are_counted_not_listed() {
    let (_dir, repo) = review_repo(&[("mod.txt", "one\ntwo\n")]);
    std::fs::write(repo.join("mod.txt"), "one\nTWO\nthree\n").unwrap();
    for number in 0..300 {
        std::fs::write(repo.join(format!("u{number:03}.txt")), "x\n").unwrap();
    }
    let reply = get(&service(Log::default()), json!({ "scope": "repo", "cwd": repo.to_string_lossy() })).await.unwrap();
    assert_eq!(reply["untrackedOmitted"], 44);
    let paths: Vec<&str> = reply["files"].as_array().unwrap().iter().map(|row| row["path"].as_str().unwrap()).collect();
    assert_eq!(paths.len(), 257);
    assert!(paths.contains(&"mod.txt") && paths.contains(&"u255.txt") && !paths.contains(&"u256.txt"));
}

/// A nested repository (with or without a commit in it) is one untracked row named `folder/`, with no line counts.
#[tokio::test]
async fn a_nested_repository_is_one_untracked_folder_row() {
    use crate::golden_tests::git;
    let (_dir, repo) = review_repo(&[("mod.txt", "one\ntwo\n")]);
    let (inner, bare) = (repo.join("inner"), repo.join("zz-bare"));
    for folder in [&inner, &bare] {
        std::fs::create_dir_all(folder).unwrap();
        git(folder, &["init", "-q", "-b", "main"]);
    }
    std::fs::write(inner.join("a.txt"), "a\n").unwrap();
    git(&inner, &["add", "-A"]);
    git(&inner, &["commit", "-q", "-m", "inner"]);
    std::fs::write(repo.join("plain.txt"), "plain\n").unwrap();
    let reply = get(&service(Log::default()), json!({ "scope": "repo", "cwd": repo.to_string_lossy() })).await.unwrap();
    let rows: Vec<(&str, &str, u64, u64, bool)> = reply["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| (row["path"].as_str().unwrap(), row["status"].as_str().unwrap(), row["additions"].as_u64().unwrap(), row["deletions"].as_u64().unwrap(), row["untracked"].as_bool().unwrap()))
        .collect();
    assert_eq!(rows, [("inner/", "A", 0, 0, true), ("plain.txt", "A", 1, 0, true), ("zz-bare/", "A", 0, 0, true)]);
}
