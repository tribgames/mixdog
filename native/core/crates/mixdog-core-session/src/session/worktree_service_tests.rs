//! The thread SCM methods against Node's real functions (`fixtures/thread-scm/golden.json`,
//! recorded by `record-thread-scm.mjs`): the workspace steps replay over a real repository and
//! the real transitions, the turn-change steps over the real turn review. Temp paths, commit ids
//! and times are masked the same way the recorder masks them.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "tests drive git and the disk directly")]

use std::path::Path;

use bytes::Bytes;
use mixdog_core_api::CoreError;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_base::support::OpScopes;
use mixdog_core_api::turn_review::CallChange;
use mixdog_core_api::turn_review::ReviewContent;
use mixdog_core_api::turn_review::TurnOpen;
use mixdog_core_api::turn_review::TurnReviewApi;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::scopes;
use mixdog_core_base::support::testing::with_op;
use mixdog_core_review::turn_review::testing::test_review;
use serde_json::Value;
use serde_json::json;

use super::worktree_tests::git;
use super::worktree_tests::rig;
use super::*;

const GOLDEN: &str = include_str!("../../../../fixtures/thread-scm/golden.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("golden")
}

fn is_sha(text: &str) -> bool {
    text.len() == 40 && text.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// The recorder's masks: roots, the per-project store folder, commit ids, times.
fn mask(value: &mut Value, roots: &[(String, &str)]) {
    match value {
        Value::String(text) => {
            let mut out = text.replace('\\', "/");
            for (from, to) in roots {
                out = out.replace(from, to);
            }
            if let Some(at) = out.find("worktrees-v1/") {
                let from = at + "worktrees-v1/".len();
                if out.len() >= from + 17 && out.as_bytes()[from + 16] == b'/' {
                    out.replace_range(from..from + 16, "<project>");
                }
            }
            *text = if is_sha(&out) { "<sha>".into() } else { out };
        }
        Value::Array(items) => items.iter_mut().for_each(|item| mask(item, roots)),
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                match key.as_str() {
                    "createdAt" => *item = json!("<ms>"),
                    "lastCommitAt" => *item = json!("<time>"),
                    _ => mask(item, roots),
                }
            }
        }
        _ => {}
    }
}

fn root_forms(path: &Path) -> Vec<String> {
    let plain = |p: &Path| p.to_string_lossy().replace('\\', "/").trim_start_matches("//?/").to_owned();
    let mut forms = vec![plain(path)];
    if let Ok(real) = path.canonicalize() {
        forms.push(plain(&real));
    }
    forms.dedup();
    forms
}

/// `{ ok }` or `{ error: { code, message, details } }` as the recorder wrote a step.
fn outcome(result: Result<Reply, CoreError>) -> Value {
    match result {
        Ok(Reply::Value(value)) => json!({ "ok": value }),
        Ok(_) => panic!("a value reply"),
        Err(CoreError::DomainError { code, message, detail, .. }) => {
            // The typed detail carries a `type` tag the wire text of Node's thrown details never had.
            let details = match detail.map(|d| serde_json::to_value(d).unwrap()) {
                Some(Value::Object(mut fields)) => {
                    fields.shift_remove("type");
                    Value::Object(fields)
                }
                _ => Value::Null,
            };
            json!({ "error": { "code": code.as_deref(), "message": message.as_deref(), "details": details } })
        }
        Err(other) => panic!("not a domain error: {other:?}"),
    }
}

fn service(rig: &super::worktree_tests::Rig, review: Arc<dyn TurnReviewApi>, ops: OpScopes) -> ThreadScmService {
    ThreadScmService::new(rig.ws.clone(), review, ops)
}

#[tokio::test]
async fn the_workspace_methods_answer_what_nodes_transitions_answered() {
    let rig = rig();
    let dir = tempfile::tempdir().unwrap();
    let review: Arc<dyn TurnReviewApi> = Arc::new(test_review(dir.path()));
    let svc = service(&rig, review, scopes(dir.path(), "thread").await);
    git(&rig.repo, &["branch", "dev"]);

    let mut roots: Vec<(String, &str)> = Vec::new();
    for form in root_forms(&rig.repo) {
        roots.push((form, "<repo>"));
    }
    for form in root_forms(&rig.data) {
        roots.push((form, "<data>"));
    }
    let golden = golden();
    let mut next_op = 0u64;
    let mut worktree: Option<std::path::PathBuf> = None;
    for step in golden["steps"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        let mut op = |method: &'static str, params: Value| {
            next_op += 1;
            request(method, with_op(params, next_op), Some(next_op))
        };
        let plain = |method: &'static str, params: Value| request(method, params, None);
        let thread = json!({ "threadId": "lead" });
        let req = match name {
            "menu: never moved" | "menu: intent armed" | "menu: in worktree" | "menu: on dev" => {
                plain("thread/getBranchMenu", thread.clone())
            }
            "work: no ids" => plain("thread/getSessionWorktreeWork", json!({ "threadId": "lead", "input": { "sessionIds": [] } })),
            "work: nothing owned" => {
                plain("thread/getSessionWorktreeWork", json!({ "threadId": "lead", "input": { "sessionIds": ["lead", 7, ""] } }))
            }
            "work: clean worktree" | "work: merged but retained" => {
                plain("thread/getSessionWorktreeWork", json!({ "threadId": "lead", "input": { "sessionIds": ["lead"] } }))
            }
            "work: unmerged commit holds" => {
                let wt = worktree.as_ref().unwrap();
                std::fs::write(wt.join("g.txt"), "x\n").unwrap();
                git(wt, &["add", "."]);
                git(wt, &["commit", "-q", "-m", "work"]);
                plain("thread/getSessionWorktreeWork", json!({ "threadId": "lead", "input": { "sessionIds": ["lead", "other"] } }))
            }
            "request: armed intent" => op("thread/requestWorktree", json!({ "threadId": "lead", "input": { "name": "feat" } })),
            "request: bad name type" => op("thread/requestWorktree", json!({ "threadId": "lead", "input": { "name": 5 } })),
            "request: bad carry choice" => {
                op("thread/requestWorktree", json!({ "threadId": "lead", "input": { "name": "feat", "carryChanges": "maybe" } }))
            }
            "request: stale revision" => {
                op("thread/requestWorktree", json!({ "threadId": "lead", "input": { "name": "feat", "expectedRevision": 3 } }))
            }
            "request: provision" => op(
                "thread/requestWorktree",
                json!({ "threadId": "lead", "input": { "name": "feat", "provision": true, "txId": "c1" } }),
            ),
            "request: bound already" => op(
                "thread/requestWorktree",
                json!({ "threadId": "lead", "input": { "name": "feat", "provision": true, "txId": "c1b" } }),
            ),
            "merge: unconfirmed" => op("thread/mergeWorkspace", json!({ "threadId": "lead", "input": { "confirmed": false } })),
            "merge: stale revision" => {
                op("thread/mergeWorkspace", json!({ "threadId": "lead", "input": { "confirmed": true, "expectedRevision": 9 } }))
            }
            "merge: confirmed with cleanup" => {
                op("thread/mergeWorkspace", json!({ "threadId": "lead", "input": { "confirmed": true, "cleanup": true } }))
            }
            "select: dev" => op("thread/selectBranch", json!({ "threadId": "lead", "input": { "branch": "dev", "txId": "c2" } })),
            "select: dev again" => op("thread/selectBranch", json!({ "threadId": "lead", "input": { "branch": "dev", "txId": "c2b" } })),
            "select: unknown branch" => op("thread/selectBranch", json!({ "threadId": "lead", "input": { "branch": "nope", "txId": "c3" } })),
            "select: stale revision" => {
                op("thread/selectBranch", json!({ "threadId": "lead", "input": { "branch": "main", "expectedRevision": 40 } }))
            }
            other => panic!("unplanned step {other}"),
        };
        let raw = outcome(svc.call(req).await);
        if name == "request: provision" {
            let cwd = raw["ok"]["workspace"]["cwd"].as_str().expect("the worktree cwd");
            roots.insert(0, (cwd.replace('\\', "/"), "<worktree>"));
            worktree = Some(cwd.into());
        }
        let mut got = raw;
        mask(&mut got, &roots);
        let mut want = step.clone();
        want.as_object_mut().unwrap().remove("name");
        assert_eq!(got, want, "step {name}");
    }
}

fn change(path: &Path, before: Option<&str>, after: Option<&str>) -> CallChange {
    let content = |text: Option<&str>| text.map_or(ReviewContent::Absent, |t| ReviewContent::Bytes(Bytes::copy_from_slice(t.as_bytes())));
    CallChange { path: path.to_string_lossy().into_owned(), new_path: None, before: content(before), after: content(after) }
}

#[tokio::test]
async fn undo_and_reapply_answer_what_nodes_turn_changes_answered() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("turn");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "core.autocrlf", "false"]);
    for (file, text) in [("a.txt", "a\n"), ("b.txt", "b\n"), ("keep.txt", "keep\n")] {
        std::fs::write(repo.join(file), text).unwrap();
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    let root = repo.to_string_lossy().into_owned();

    let review: Arc<dyn TurnReviewApi> = Arc::new(test_review(&dir.path().join("review")));
    let sid = "turn-session";
    review.begin_turn(&root, sid, TurnOpen { checkpoint_id: "cp".into(), continue_turn: false }).await.expect("a turn");
    std::fs::write(repo.join("a.txt"), "A\n").unwrap();
    std::fs::remove_file(repo.join("b.txt")).unwrap();
    std::fs::write(repo.join("new.txt"), "new\n").unwrap();
    review
        .record_tool_changes(
            sid,
            &root,
            vec![
                change(&repo.join("a.txt"), Some("a\n"), Some("A\n")),
                change(&repo.join("b.txt"), Some("b\n"), None),
                change(&repo.join("new.txt"), None, Some("new\n")),
            ],
        )
        .await;
    assert!(review.complete_turn(sid, None).await);

    let svc = ThreadScmService::new(rig().ws.clone(), review, scopes(dir.path(), "thread").await);
    let mut roots: Vec<(String, &str)> = Vec::new();
    for form in root_forms(&repo) {
        roots.push((form, "<repo>"));
    }
    let golden = golden();
    let steps = golden["changes"].as_array().unwrap();
    let (mut next_op, mut revision) = (0u64, 1i64);
    for step in steps {
        let name = step["name"].as_str().unwrap();
        let (method, file, at, checkpoint): (&'static str, Value, i64, &str) = match name {
            "revert: stale revision" => ("thread/revertTurnChanges", Value::Null, revision + 1, "cp"),
            "revert: one file" | "revert: same file again" => ("thread/revertTurnChanges", json!("a.txt"), revision, "cp"),
            "revert: whole turn" | "revert: nothing left" => ("thread/revertTurnChanges", Value::Null, revision, "cp"),
            "revert: unknown checkpoint" => ("thread/revertTurnChanges", Value::Null, 1, "cp-unknown"),
            "reapply: one file" => ("thread/reapplyTurnChanges", json!("new.txt"), revision, "cp"),
            "reapply: whole turn" | "reapply: nothing left" => ("thread/reapplyTurnChanges", Value::Null, revision, "cp"),
            other => panic!("unplanned step {other}"),
        };
        next_op += 1;
        let params = with_op(json!({ "threadId": sid, "checkpointId": checkpoint, "file": file, "revision": at }), next_op);
        let mut got = outcome(svc.call(request(method, params, Some(next_op))).await);
        if let Some(next) = got["ok"]["revision"].as_i64() {
            revision = next;
        }
        mask(&mut got, &roots);
        let mut want = step.clone();
        want.as_object_mut().unwrap().remove("name");
        // A plain Error carries a message alone: the golden has no code or details to compare.
        if want.get("error").is_some() {
            want = json!({ "error": { "message": want["error"]["message"] } });
            got = json!({ "error": { "message": got["error"]["message"] } });
        }
        assert_eq!(got, want, "step {name}");
    }
}
