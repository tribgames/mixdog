//! The refusal and transition texts a person reads, on real git repositories: each scenario runs its steps and asserts the
//! {code, message, details} (or result fields) byte for byte. Machine paths are the placeholders <REPO>, <WT> and <DATA>, with / separators.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "tests drive git and the disk directly")]

use std::sync::atomic::Ordering;

use serde_json::Value;

use super::worktree_tests::Rig;
use super::worktree_tests::enter;
use super::worktree_tests::git;
use super::worktree_tests::rig;
use super::worktree_tests::run;
use super::*;

fn expected(text: &str) -> Value {
    serde_json::from_str(text).expect("the expected text parses")
}

const DIRTY_CHOICE: &str = r##"{"error":{"code":"WORKTREE_DIRTY_CHOICE","message":"The project folder has uncommitted changes; choose whether to leave them there or carry them into the worktree.","details":{"count":1,"paths":["f.txt"]}}}"##;
const STALE_REVISION: &str = r##"{"error":{"code":"WORKTREE_REVISION_CONFLICT","message":"The session workspace changed; reload and try again.","details":{"expectedRevision":5,"revision":0}}}"##;
const TURN_RUNNING: &str = r##"{"error":{"code":"WORKTREE_BUSY_JOBS","message":"The session is running a turn; wait for it to finish.","details":{"reason":"turn"}}}"##;
const DIRTY_WORKTREE_REMOVE: &str = r##"{"error":{"code":"WORKTREE_DIRTY","message":"The worktree has uncommitted changes.","details":{"entryId":"feat","files":["new.txt"],"count":1}}}"##;
const MERGE_CLEANUP_REFUSED: &str = r##"{"merged":true,"cleanup":{"removed":false,"reason":"WORKTREE_BUSY_JOBS","code":"WORKTREE_BUSY_JOBS","message":"Sessions or workers still use an affected folder. Finish or move them before continuing."}}"##;
const MERGE_CLEANUP_OFF: &str = r##"{"merged":true,"cleanup":{"removed":false,"reason":"auto-cleanup-off","message":"Auto cleanup is off; the worktree is kept."}}"##;
const REMOVE_BRANCH_NOT_OWNED: &str = r##"{"error":{"code":null,"message":"git worktree remove: this session owns no managed worktree of branch other; git worktree list shows them","details":null}}"##;
const REMOVE_PATH_UNMANAGED: &str = r##"{"error":{"code":null,"message":"git worktree remove: <REPO>/nowhere is not a Mixdog-managed worktree; unmanaged worktrees are not removed through the git tool","details":null}}"##;
const UNATTENDED_SESSION: &str = r##"{"enter":{"error":{"code":null,"message":"git worktree enter changes worktrees only in a conversation session (a Lead session or a bot chat); schedule, webhook, routine and room runs may only list them","details":null}},"return":{"error":{"code":null,"message":"git worktree return changes worktrees only in a conversation session (a Lead session or a bot chat); schedule, webhook, routine and room runs may only list them","details":null}},"merge":{"error":{"code":null,"message":"git worktree merge changes worktrees only in a conversation session (a Lead session or a bot chat); schedule, webhook, routine and room runs may only list them","details":null}},"remove":{"error":{"code":null,"message":"git worktree remove changes worktrees only in a conversation session (a Lead session or a bot chat); schedule, webhook, routine and room runs may only list them","details":null}}}"##;
const WORKTREE_MISSING_TURN: &str = r##"{"error":{"code":"WORKTREE_MISSING","message":"The worktree for this session no longer exists; pick a branch or remove the worktree to continue.","details":{"worktreeId":"feat","path":"<WT>"}}}"##;
const PROJECT_FOLDER_IN_USE: &str = r##"{"error":{"code":"WORKTREE_BUSY_JOBS","message":"Sessions or workers still use an affected folder. Finish or move them before continuing.","details":{"sessions":["other"],"reason":"folder-in-use"}}}"##;
const INPUT_VALIDATION: &str = r##"{"invalid_name":{"error":{"code":null,"message":"worktree name is invalid: use letters, digits, \".\", \"_\" or \"-\", starting with a letter or digit","details":null}},"bad_carry":{"error":{"code":null,"message":"carryChanges must be one of leave, carry.","details":null}},"empty_branch":{"error":{"code":null,"message":"workspace target branch must be a non-empty string.","details":null}},"bad_branch":{"error":{"code":null,"message":"Invalid branch name.","details":null}}}"##;
const TRANSITION_TEXTS: &str = r##"{"session":{"error":{"code":"WORKTREE_BUSY_JOBS","message":"Another workspace change is in progress for this session.","details":{"reason":"transition"}}},"spawn":{"error":{"code":"WORKTREE_BUSY_JOBS","message":"The Lead workspace is changing; spawn the worker after it settles.","details":{"reason":"transition"}}},"folder":{"error":{"code":"WORKTREE_BUSY_JOBS","message":"Another branch change is in progress in the project folder.","details":{"reason":"transition"}}}}"##;

fn scrub(value: &mut Value, roots: &[(String, &'static str)]) {
    match value {
        Value::String(text) => {
            let mut out = text.replace('\\', "/");
            for (root, label) in roots {
                out = out.replace(root.as_str(), label);
            }
            *text = out;
        }
        Value::Array(items) => items.iter_mut().for_each(|item| scrub(item, roots)),
        Value::Object(map) => map.values_mut().for_each(|item| scrub(item, roots)),
        _ => {}
    }
}

fn slashes(path: impl AsRef<std::path::Path>) -> String {
    path.as_ref().to_string_lossy().replace('\\', "/")
}

/// Paths as the expected texts spell them: the worktree first (it lives under the data dir).
fn roots(rig: &Rig, worktree: Option<&str>) -> Vec<(String, &'static str)> {
    let mut roots = Vec::new();
    if let Some(worktree) = worktree {
        roots.push((slashes(worktree), "<WT>"));
    }
    roots.push((slashes(&rig.repo), "<REPO>"));
    roots.push((slashes(&rig.data), "<DATA>"));
    roots
}

fn recorded(rig: &Rig, worktree: Option<&str>, mut value: Value) -> Value {
    scrub(&mut value, &roots(rig, worktree));
    value
}

/// `{error: {code, message, details}}`, as a refused call answers.
fn error_value(failure: &ScmFailure) -> Value {
    let details = match failure.detail().map(serde_json::to_value) {
        Some(Ok(Value::Object(mut fields))) => {
            fields.remove("type");
            if fields.is_empty() { Value::Null } else { Value::Object(fields) }
        }
        _ => Value::Null,
    };
    json!({ "error": { "code": failure.code(), "message": thrown_message(failure), "details": details } })
}

fn thrown(result: Result<Value, ScmFailure>) -> Value {
    match result {
        Ok(value) => panic!("expected a refusal, got {value}"),
        Err(failure) => error_value(&failure),
    }
}


fn worktree_of(entered: &Value) -> String {
    entered["workspace"]["cwd"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn dirty_choice_text_is_what_the_user_reads() {
    let rig = rig();
    std::fs::write(rig.repo.join("f.txt"), "changed\n").unwrap();
    let actual = thrown(run(&rig, enter("feat", "c1:enter")).await);
    assert_eq!(recorded(&rig, None, actual), expected(DIRTY_CHOICE), "dirty_choice");
}

#[tokio::test]
async fn stale_revision_and_running_turn_texts_are_what_the_user_reads() {
    let rig = rig();
    let cancel = CancellationToken::new();
    let stale = rig
        .ws
        .select_branch("lead", SelectBranch { branch: "x".into(), expected_revision: Some(5), ..SelectBranch::default() }, true, &cancel)
        .await;
    assert_eq!(recorded(&rig, None, thrown(stale)), expected(STALE_REVISION), "stale_revision");

    rig.state.lock().unwrap().turn_running = true;
    let busy = rig
        .ws
        .select_branch("lead", SelectBranch { branch: "x".into(), create: true, ..SelectBranch::default() }, false, &cancel)
        .await;
    assert_eq!(recorded(&rig, None, thrown(busy)), expected(TURN_RUNNING), "turn_running");
}

#[tokio::test]
async fn dirty_worktree_removal_text_is_what_the_user_reads() {
    let rig = rig();
    let entered = run(&rig, enter("feat", "c1:enter")).await.unwrap();
    let worktree = worktree_of(&entered);
    std::fs::write(std::path::Path::new(&worktree).join("new.txt"), "wip\n").unwrap();
    let refused = run(&rig, SessionOp::Remove { session_id: None, branch: None, force: false, tx_id: "c2:remove".into() }).await;
    assert_eq!(recorded(&rig, Some(&worktree), thrown(refused)), expected(DIRTY_WORKTREE_REMOVE), "dirty_worktree_remove");
}

async fn merged_cleanup(rig: &Rig) -> Value {
    let entered = run(rig, enter("feat", "c1:enter")).await.unwrap();
    let worktree = worktree_of(&entered);
    std::fs::write(std::path::Path::new(&worktree).join("g.txt"), "x\n").unwrap();
    git(std::path::Path::new(&worktree), &["add", "."]);
    git(std::path::Path::new(&worktree), &["commit", "-q", "-m", "edit g.txt"]);
    let merged = run(rig, SessionOp::Merge { session_id: None, tx_id: "c2:merge".into() }).await.unwrap();
    recorded(rig, Some(&worktree), json!({ "merged": merged["merged"], "cleanup": merged["cleanup"] }))
}

#[tokio::test]
async fn merge_cleanup_texts_are_what_the_user_reads() {
    let rig = rig();
    assert_eq!(merged_cleanup(&rig).await, expected(MERGE_CLEANUP_REFUSED), "merge_cleanup_refused");
    let off = self::rig();
    off.auto_cleanup.store(false, Ordering::SeqCst);
    assert_eq!(merged_cleanup(&off).await, expected(MERGE_CLEANUP_OFF), "merge_cleanup_off");
}

#[tokio::test]
async fn git_tool_removal_texts_are_what_the_user_reads() {
    let rig = rig();
    let by_branch = run(&rig, SessionOp::Remove { session_id: None, branch: Some("other".into()), force: false, tx_id: "c1:remove".into() }).await;
    assert_eq!(recorded(&rig, None, thrown(by_branch)), expected(REMOVE_BRANCH_NOT_OWNED), "remove_branch_not_owned");
    let path = rig.repo.join("nowhere").to_string_lossy().into_owned();
    let by_path = rig.ws.inner.remove_path(&path, false, "lead", &CancellationToken::new()).await;
    assert_eq!(recorded(&rig, None, thrown(by_path)), expected(REMOVE_PATH_UNMANAGED), "remove_path_unmanaged");
}

#[tokio::test]
async fn an_unattended_run_text_is_what_the_user_reads() {
    let rig = rig();
    rig.state.lock().unwrap().unattended = true;
    let ops = [
        ("enter", enter("feat", "u:enter")),
        ("return", SessionOp::Return { session_id: None, tx_id: "u:return".into() }),
        ("merge", SessionOp::Merge { session_id: None, tx_id: "u:merge".into() }),
        ("remove", SessionOp::Remove { session_id: None, branch: None, force: false, tx_id: "u:remove".into() }),
    ];
    let mut actual = serde_json::Map::new();
    for (name, op) in ops {
        actual.insert(name.to_owned(), thrown(run(&rig, op).await));
    }
    assert_eq!(recorded(&rig, None, Value::Object(actual)), expected(UNATTENDED_SESSION), "unattended_session");
}

#[tokio::test]
async fn the_three_transition_refusals_say_what_is_in_progress() {
    let rig = rig();
    let gate = rig.ws.gate();
    let leave = gate.begin_transition("s-a", "tx").unwrap();
    let session = gate.begin_transition("s-a", "tx").err().unwrap();
    let spawn = gate.enter_worker_spawn(&["s-a"]).err().unwrap();
    drop(leave);
    let repo = rig.repo.to_string_lossy().into_owned();
    let _held = gate.hold_checkout_folder("s-b", &repo, true).unwrap();
    let folder = gate.hold_checkout_folder("s-c", &rig.repo.join("sub").to_string_lossy(), true).err().unwrap();
    let actual = json!({
        "session": error_value(&session),
        "spawn": error_value(&spawn),
        "folder": error_value(&folder),
    });
    assert_eq!(actual, expected(TRANSITION_TEXTS), "transition_texts");
}

#[tokio::test]
async fn a_missing_worktree_turn_text_is_what_the_user_reads() {
    let rig = rig();
    let entered = run(&rig, enter("feat", "c1:enter")).await.unwrap();
    let worktree = worktree_of(&entered);
    std::fs::remove_dir_all(&worktree).unwrap();
    let recovery = restore_workspace_after_resume(rig.state.lock().unwrap().workspace.as_ref(), false);
    rig.state.lock().unwrap().workspace = recovery.workspace;
    let refused = rig.ws.prepare_turn_workspace("lead", TurnStart { submission_id: "sub1".into(), ..TurnStart::default() }, &CancellationToken::new()).await;
    let actual = thrown(refused.map(|v| v.unwrap_or(Value::Null)));
    assert_eq!(recorded(&rig, Some(&worktree), actual), expected(WORKTREE_MISSING_TURN), "worktree_missing_turn");
}

#[tokio::test]
async fn a_project_folder_in_use_text_is_what_the_user_reads() {
    let rig = rig();
    git(&rig.repo, &["branch", "feature"]);
    rig.state.lock().unwrap().live = vec![LiveSession {
        id: "other".into(),
        cwd: Some(rig.repo.join("sub").to_string_lossy().into_owned()),
        active: true,
        ..LiveSession::default()
    }];
    let refused = rig.ws.folder_admission(None).admit(&[rig.repo.clone()], false).await;
    assert_eq!(recorded(&rig, None, error_value(&refused.err().unwrap())), expected(PROJECT_FOLDER_IN_USE), "project_folder_in_use");
}

#[tokio::test]
async fn input_validation_texts_are_what_the_user_reads() {
    let rig = rig();
    let cancel = CancellationToken::new();
    let request = |name: &str, carry: Option<&str>, tx: &str| RequestWorktree {
        name: Some(name.into()),
        provision: true,
        carry_changes: carry.map(str::to_owned),
        tx_id: tx.into(),
        ..RequestWorktree::default()
    };
    let select = |branch: &str, create: bool, tx: &str| SelectBranch { branch: branch.into(), create, tx_id: tx.into(), ..SelectBranch::default() };
    let actual = json!({
        "invalid_name": thrown(rig.ws.request_worktree("lead", request("Bad Name!", None, "v1"), false, &cancel).await),
        "bad_carry": thrown(rig.ws.request_worktree("lead", request("ok", Some("bogus"), "v2"), false, &cancel).await),
        "empty_branch": thrown(rig.ws.select_branch("lead", select("", false, "v3"), false, &cancel).await),
        "bad_branch": thrown(rig.ws.select_branch("lead", select("a..b", true, "v4"), false, &cancel).await),
    });
    assert_eq!(recorded(&rig, None, actual), expected(INPUT_VALIDATION), "input_validation");
}
