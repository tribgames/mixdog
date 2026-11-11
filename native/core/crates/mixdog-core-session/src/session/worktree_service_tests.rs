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

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/thread-scm/golden.json");

fn golden() -> Value {
    serde_json::from_str(&GOLDEN).expect("golden")
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

/// The turn the recorder edits: `a.txt` changed, `b.txt` removed, `new.txt` created, one review.
async fn recorded_turn(parent: &Path, name: &str, sid: &str) -> (std::path::PathBuf, Arc<dyn TurnReviewApi>) {
    let repo = parent.join(name);
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "core.autocrlf", "false"]);
    for (file, text) in [("a.txt", "a\n"), ("b.txt", "b\n"), ("keep.txt", "keep\n")] {
        std::fs::write(repo.join(file), text).unwrap();
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    let root = repo.to_string_lossy().into_owned();
    let review: Arc<dyn TurnReviewApi> = Arc::new(test_review(&parent.join(format!("review-{name}"))));
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
    (repo, review)
}

/// `git` as the recorder reads state: its output, or `exit N`.
fn git_out(cwd: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").current_dir(cwd).args(args).output().expect("git runs");
    if out.status.success() { String::from_utf8_lossy(&out.stdout).trim().to_owned() } else { format!("exit {}", out.status.code().unwrap_or(-1)) }
}

fn lines(text: &str) -> Vec<String> {
    text.split('\n').map(|l| l.trim_end_matches('\r').to_owned()).filter(|l| !l.is_empty()).collect()
}

fn sorted(mut items: Vec<String>) -> Vec<String> {
    items.sort();
    items
}

/// Every file under `dir` (but the top-level `.git` and `.mixdog`) with its text, by path.
fn dir_files(dir: &Path, rel: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let here = if rel.is_empty() { dir.to_path_buf() } else { dir.join(rel) };
    for entry in std::fs::read_dir(here).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        if rel.is_empty() && (name == ".git" || name == ".mixdog") {
            continue;
        }
        let path = if rel.is_empty() { name } else { format!("{rel}/{name}") };
        if entry.file_type().unwrap().is_dir() {
            out.extend(dir_files(dir, &path));
        } else {
            out.push(json!({ "path": path, "content": std::fs::read_to_string(dir.join(&path)).unwrap() }));
        }
    }
    out.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    out
}

/// The recorder's `checkoutState`: branch, status, branches, subjects, linked worktrees, files.
fn checkout_state(dir: Option<&Path>) -> Value {
    let Some(dir) = dir.filter(|d| d.exists()) else {
        return json!({ "exists": false });
    };
    let worktrees = lines(&git_out(dir, &["worktree", "list", "--porcelain"])).into_iter().filter(|l| l.starts_with("branch ") || l == "detached").collect();
    json!({
        "exists": true,
        "head": git_out(dir, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "status": sorted(lines(&git_out(dir, &["status", "--porcelain", "--untracked-files=all"]))),
        "branches": sorted(lines(&git_out(dir, &["for-each-ref", "--format=%(refname:short)", "refs/heads"]))),
        "log": lines(&git_out(dir, &["log", "--format=%s", "-n", "20"])),
        "worktrees": sorted(worktrees),
        "files": dir_files(dir, ""),
    })
}

/// A recorded `write`/`rm` action applied to `base`.
fn apply_file_action(base: &Path, action: &Value) {
    let path = base.join(action["path"].as_str().unwrap());
    match action["do"].as_str().unwrap() {
        "write" => std::fs::write(path, action["content"].as_str().unwrap()).unwrap(),
        "rm" if path.is_dir() => std::fs::remove_dir_all(path).unwrap(),
        "rm" => {
            let _ = std::fs::remove_file(path);
        }
        other => panic!("unplanned action {other}"),
    }
}

#[tokio::test]
async fn undo_and_reapply_answer_what_nodes_turn_changes_answered() {
    let dir = tempfile::tempdir().unwrap();
    let sid = "turn-session";
    let (repo, review) = recorded_turn(dir.path(), "turn", sid).await;
    let svc = ThreadScmService::new(rig().ws.clone(), review, scopes(dir.path(), "thread").await);
    let mut roots: Vec<(String, &str)> = Vec::new();
    for form in root_forms(&repo) {
        roots.push((form, "<repo>"));
    }
    let golden = golden();
    let (mut next_op, mut revision) = (0u64, 1i64);
    for step in golden["changes"].as_array().unwrap() {
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
        got["files"] = Value::Array(dir_files(&repo, ""));
        assert_eq!(got, *step.as_object().map(|o| {
            let mut o = o.clone();
            o.shift_remove("name");
            o
        }).map(Value::Object).as_ref().unwrap(), "step {name}");
    }
}

#[tokio::test]
async fn undo_and_reapply_refuse_and_leave_the_files_as_nodes_did() {
    let golden = golden();
    for scenario in golden["turnScenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let sid = scenario["threadId"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let (repo, review) = recorded_turn(dir.path(), "turn-sc", sid).await;
        for action in scenario["tweak"].as_array().unwrap() {
            apply_file_action(&repo, action);
        }
        let svc = ThreadScmService::new(rig().ws.clone(), review, scopes(dir.path(), "thread").await);
        let mut roots: Vec<(String, &str)> = Vec::new();
        for form in root_forms(&repo) {
            roots.push((form, "<repo>"));
        }
        let (mut next_op, mut revision) = (0u64, scenario["startRevision"].as_i64().unwrap());
        for step in scenario["steps"].as_array().unwrap() {
            let method = if step["kind"] == "revert" { "thread/revertTurnChanges" } else { "thread/reapplyTurnChanges" };
            next_op += 1;
            let params = with_op(json!({ "threadId": sid, "checkpointId": "cp", "file": step["file"], "revision": revision }), next_op);
            let mut got = outcome(svc.call(request(method, params, Some(next_op))).await);
            if let Some(next) = got["ok"]["revision"].as_i64() {
                revision = next;
            }
            mask(&mut got, &roots);
            got["files"] = Value::Array(dir_files(&repo, ""));
            let mut want = step.clone();
            want.as_object_mut().unwrap().remove("kind");
            want.as_object_mut().unwrap().remove("file");
            assert_eq!(got, want, "{name}: {} {}", step["kind"], step["file"]);
        }
    }
}

/// The scenarios share nothing (each has its own repository, data dir and service) and spend their
/// time waiting on git processes (about 1,500 of them, ~100 s one after the other for ~11 s of
/// processor), so each runs on a thread of its own with a runtime of its own.
#[test]
fn the_safety_scenarios_leave_the_git_and_disk_state_nodes_left() {
    let golden = golden();
    std::thread::scope(|scope| {
        for scenario in golden["scenarios"].as_array().unwrap() {
            scope.spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("a runtime for the scenario")
                    .block_on(safety_scenario(scenario));
            });
        }
    });
}

async fn safety_scenario(scenario: &Value) {
    let name = scenario["name"].as_str().unwrap();
    let tid = scenario["threadId"].as_str().unwrap();
    let rig = rig();
    let dir = tempfile::tempdir().unwrap();
    let review: Arc<dyn TurnReviewApi> = Arc::new(test_review(dir.path()));
    let svc = service(&rig, review, scopes(dir.path(), "thread").await);
    let mut roots: Vec<(String, &str)> = Vec::new();
    for form in root_forms(&rig.repo) {
        roots.push((form, "<repo>"));
    }
    for form in root_forms(&rig.data) {
        roots.push((form, "<data>"));
    }
    for form in root_forms(rig.repo.parent().unwrap()) {
        roots.push((form, "<base>"));
    }
    let mut worktree: Option<std::path::PathBuf> = None;
    let mut next_op = 0u64;
    for (at, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
        let action = &step["action"];
        let mut result: Option<Value> = None;
        let in_dir = |worktree: &Option<std::path::PathBuf>| match action["in"].as_str() {
            Some("repo") => rig.repo.clone(),
            _ => worktree.clone().expect("a worktree"),
        };
        match action["do"].as_str().unwrap() {
            "call" => {
                let method = action["method"].as_str().unwrap();
                let input = &action["input"];
                let params = if input.is_null() { json!({ "threadId": tid }) } else { json!({ "threadId": tid, "input": input }) };
                let req = match method {
                    "getBranchMenu" => request("thread/getBranchMenu", params, None),
                    "getSessionWorktreeWork" => request("thread/getSessionWorktreeWork", params, None),
                    "requestWorktree" | "selectBranch" | "mergeWorkspace" => {
                        next_op += 1;
                        let wire = match method {
                            "requestWorktree" => "thread/requestWorktree",
                            "selectBranch" => "thread/selectBranch",
                            _ => "thread/mergeWorkspace",
                        };
                        request(wire, with_op(params, next_op), Some(next_op))
                    }
                    other => panic!("unplanned method {other}"),
                };
                let raw = outcome(svc.call(req).await);
                if let Some(cwd) = raw["ok"]["workspace"]["cwd"].as_str() {
                    let cwd = std::path::PathBuf::from(cwd);
                    if cwd.canonicalize().ok() != rig.repo.canonicalize().ok() && worktree.as_ref() != Some(&cwd) {
                        roots.insert(0, (cwd.to_string_lossy().replace('\\', "/"), "<worktree>"));
                        worktree = Some(cwd);
                    }
                }
                let mut got = raw;
                mask(&mut got, &roots);
                result = Some(got);
            }
            "git" => {
                let args: Vec<&str> = action["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
                git(&in_dir(&worktree), &args);
            }
            _ => apply_file_action(&in_dir(&worktree), action),
        }
        let state = json!({ "repo": checkout_state(Some(&rig.repo)), "worktree": checkout_state(worktree.as_deref()) });
        if let Some(want) = step.get("result") {
            assert_eq!(result.as_ref(), Some(want), "{name} #{at} {action}");
        }
        assert_eq!(state, step["state"], "{name} #{at} {action}");
    }
}
