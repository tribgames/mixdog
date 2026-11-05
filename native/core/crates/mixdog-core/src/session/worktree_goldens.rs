//! Refusal and transition texts against the Node recording (`worktree_goldens/goldens.json`,
//! made by `worktree_goldens/record.mjs` from the Node implementation on real git
//! repositories). Every scenario here runs the same steps on the Rust port and asserts the
//! recorded `{code, message, details}` (or result fields) equal, byte for byte. Machine paths
//! are the placeholders `<REPO>`, `<WT>` and `<DATA>`, with `/` separators.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "tests drive git and the disk directly")]

use std::sync::atomic::Ordering;

use serde_json::Value;

use super::worktree_tests::Rig;
use super::worktree_tests::enter;
use super::worktree_tests::git;
use super::worktree_tests::rig;
use super::worktree_tests::run;
use super::*;

fn goldens() -> Value {
    serde_json::from_str(include_str!("worktree_goldens/goldens.json")).expect("goldens.json parses")
}

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

/// Paths as the goldens spell them: the worktree first (it lives under the data dir).
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

/// `{error: {code, message, details}}`, as Node's `failure()` recorded a throw.
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

fn assert_golden(name: &str, actual: Value) {
    assert_eq!(actual, goldens()[name], "scenario {name}");
}

fn worktree_of(entered: &Value) -> String {
    entered["workspace"]["cwd"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn dirty_choice_text_equals_nodes() {
    let rig = rig();
    std::fs::write(rig.repo.join("f.txt"), "changed\n").unwrap();
    let actual = thrown(run(&rig, enter("feat", "c1:enter")).await);
    assert_golden("dirty_choice", recorded(&rig, None, actual));
}

#[tokio::test]
async fn stale_revision_and_running_turn_texts_equal_nodes() {
    let rig = rig();
    let cancel = CancellationToken::new();
    let stale = rig
        .ws
        .select_branch("lead", SelectBranch { branch: "x".into(), expected_revision: Some(5), ..SelectBranch::default() }, true, &cancel)
        .await;
    assert_golden("stale_revision", recorded(&rig, None, thrown(stale)));

    rig.state.lock().unwrap().turn_running = true;
    let busy = rig
        .ws
        .select_branch("lead", SelectBranch { branch: "x".into(), create: true, ..SelectBranch::default() }, false, &cancel)
        .await;
    assert_golden("turn_running", recorded(&rig, None, thrown(busy)));
}

#[tokio::test]
async fn dirty_worktree_removal_text_equals_nodes() {
    let rig = rig();
    let entered = run(&rig, enter("feat", "c1:enter")).await.unwrap();
    let worktree = worktree_of(&entered);
    std::fs::write(std::path::Path::new(&worktree).join("new.txt"), "wip\n").unwrap();
    let refused = run(&rig, SessionOp::Remove { session_id: None, branch: None, force: false, tx_id: "c2:remove".into() }).await;
    assert_golden("dirty_worktree_remove", recorded(&rig, Some(&worktree), thrown(refused)));
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
async fn merge_cleanup_texts_equal_nodes() {
    let rig = rig();
    assert_golden("merge_cleanup_refused", merged_cleanup(&rig).await);
    let off = self::rig();
    off.auto_cleanup.store(false, Ordering::SeqCst);
    assert_golden("merge_cleanup_off", merged_cleanup(&off).await);
}

#[tokio::test]
async fn git_tool_removal_texts_equal_nodes() {
    let rig = rig();
    let by_branch = run(&rig, SessionOp::Remove { session_id: None, branch: Some("other".into()), force: false, tx_id: "c1:remove".into() }).await;
    assert_golden("remove_branch_not_owned", recorded(&rig, None, thrown(by_branch)));
    let path = rig.repo.join("nowhere").to_string_lossy().into_owned();
    let by_path = rig.ws.inner.remove_path(&path, false, "lead", &CancellationToken::new()).await;
    assert_golden("remove_path_unmanaged", recorded(&rig, None, thrown(by_path)));
}

#[tokio::test]
async fn an_unattended_run_text_equals_nodes() {
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
    assert_golden("unattended_session", recorded(&rig, None, Value::Object(actual)));
}

#[tokio::test]
async fn the_three_transition_refusals_equal_nodes() {
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
    assert_golden("transition_texts", actual);
}

#[tokio::test]
async fn a_missing_worktree_turn_text_equals_nodes() {
    let rig = rig();
    let entered = run(&rig, enter("feat", "c1:enter")).await.unwrap();
    let worktree = worktree_of(&entered);
    std::fs::remove_dir_all(&worktree).unwrap();
    let recovery = restore_workspace_after_resume(rig.state.lock().unwrap().workspace.as_ref(), false);
    rig.state.lock().unwrap().workspace = recovery.workspace;
    let refused = rig.ws.prepare_turn_workspace("lead", TurnStart { submission_id: "sub1".into(), ..TurnStart::default() }, &CancellationToken::new()).await;
    let actual = thrown(refused.map(|v| v.unwrap_or(Value::Null)));
    assert_golden("worktree_missing_turn", recorded(&rig, Some(&worktree), actual));
}

#[tokio::test]
async fn a_project_folder_in_use_text_equals_nodes() {
    let rig = rig();
    git(&rig.repo, &["branch", "feature"]);
    rig.state.lock().unwrap().live = vec![LiveSession {
        id: "other".into(),
        cwd: Some(rig.repo.join("sub").to_string_lossy().into_owned()),
        active: true,
        ..LiveSession::default()
    }];
    let refused = rig.ws.folder_admission(None).admit(&[rig.repo.clone()], false).await;
    assert_golden("project_folder_in_use", recorded(&rig, None, error_value(&refused.err().unwrap())));
}

#[tokio::test]
async fn input_validation_texts_equal_nodes() {
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
    assert_golden("input_validation", recorded(&rig, None, actual));
}
