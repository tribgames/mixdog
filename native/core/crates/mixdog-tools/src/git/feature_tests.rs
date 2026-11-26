//! `git` tool behaviour against real repositories: command forms and refusals, staging by diff id, the worktree
//! rules for a Lead and a worker, and the session transitions a Lead sends to its runtime (scripted here).
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the test builds real repositories with blocking filesystem and process calls")]

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::tool::*;
use mixdog_protocol::DomainErrorDetail;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use mixdog_scm::engine::Scm;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::worktree::maintenance::SessionActivity;
use mixdog_scm::worktree::maintenance::SessionSource;
use mixdog_scm::worktree::maintenance::ShellJob;
use mixdog_scm::worktree::manager::Worktrees;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::GitTool;
use super::SessionOp;
use super::SessionWorktrees;
use super::WorktreeServices;

#[path = "../../../mixdog-scm/src/testing.rs"]
mod processes;

fn pin_environment() {
    // Fixed identities and dates make commit ids reproducible; no user or system config leaks in.
    for (key, value) in [
        ("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" }),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_AUTHOR_NAME", "Golden"),
        ("GIT_AUTHOR_EMAIL", "golden@example.com"),
        ("GIT_COMMITTER_NAME", "Golden"),
        ("GIT_COMMITTER_EMAIL", "golden@example.com"),
        ("GIT_AUTHOR_DATE", "2026-01-02T03:04:05Z"),
        ("GIT_COMMITTER_DATE", "2026-01-02T03:04:05Z"),
    ] {
        // SAFETY: set once before any test thread reads the environment.
        unsafe { std::env::set_var(key, value) };
    }
}

fn apply_setup(ws: &Path, ops: &[Value]) {
    for op in ops {
        apply_op(ws, op);
    }
}

fn apply_op(ws: &Path, op: &Value) {
    if let Some(write) = op.get("write") {
        let target = ws.join(write[0].as_str().unwrap());
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, write[1].as_str().unwrap()).unwrap();
        return;
    }
    let args: Vec<&str> = op["git"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
    let status = Command::new("git").args(&args).current_dir(ws).output().unwrap();
    assert!(status.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&status.stderr));
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    match path.to_string_lossy().strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// The session runtime, scripted from a golden: the Lead is `session`, and every transition
/// answers what Node's host answered (an `error` entry becomes a coded failure).
struct ScriptSessions {
    session: String,
    script: Value,
    requests: Mutex<Vec<Value>>,
}

/// The Node request object of a transition, as the golden records it.
fn node_request(op: &SessionOp) -> Value {
    let mut out = serde_json::Map::new();
    let mut put = |key: &str, value: Value| {
        out.insert(key.to_owned(), value);
    };
    match op {
        SessionOp::Enter { session_id, name, branch, create, carry, confirm_large, tx_id } => {
            put("op", json!("enter"));
            if let Some(id) = session_id {
                put("sessionId", json!(id));
            }
            if let Some(name) = name {
                put("name", json!(name));
            }
            put("branch", json!(branch));
            put("create", json!(create));
            if let Some(carry) = carry {
                put("carry", json!(carry));
            }
            put("confirmLarge", json!(confirm_large));
            put("txId", json!(tx_id));
        }
        SessionOp::Return { session_id, tx_id } | SessionOp::Merge { session_id, tx_id } => {
            put("op", json!(if matches!(op, SessionOp::Return { .. }) { "return" } else { "merge" }));
            if let Some(id) = session_id {
                put("sessionId", json!(id));
            }
            put("txId", json!(tx_id));
        }
        SessionOp::Remove { session_id, branch, force, tx_id } => {
            put("op", json!("remove"));
            if let Some(id) = session_id {
                put("sessionId", json!(id));
            }
            put("force", json!(force));
            if let Some(branch) = branch {
                put("branch", json!(branch));
            }
            put("txId", json!(tx_id));
        }
        SessionOp::RemovePath { path, force } => {
            put("op", json!("remove-path"));
            put("path", json!(path));
            put("force", json!(force));
        }
        SessionOp::Add { branch, create, start_point, confirm_large, tx_id, repo_common_dir } => {
            put("op", json!("add"));
            put("branch", json!(branch));
            put("create", json!(create));
            if let Some(start) = start_point {
                put("startPoint", json!(start));
            }
            put("confirmLarge", json!(confirm_large));
            put("txId", json!(tx_id));
            if let Some(dir) = repo_common_dir {
                put("repoCommonDir", json!(dir));
            }
        }
        SessionOp::Snapshot { commit, confirm_large, tx_id, repo_common_dir } => {
            put("op", json!("snapshot"));
            put("commit", json!(commit));
            put("confirmLarge", json!(confirm_large));
            put("txId", json!(tx_id));
            if let Some(dir) = repo_common_dir {
                put("repoCommonDir", json!(dir));
            }
        }
    }
    Value::Object(out)
}

fn scripted_failure(error: &Value) -> ScmFailure {
    let code = error["code"].as_str().unwrap();
    let mut details = error.get("details").cloned().unwrap_or_else(|| json!({}));
    let (code, tag): (&'static str, &str) = match code {
        "WORKTREE_LARGE_REPO_CONFIRM" => ("WORKTREE_LARGE_REPO_CONFIRM", "worktreeLargeRepoConfirm"),
        "MERGE_CONFLICT" => ("MERGE_CONFLICT", "mergeConflict"),
        "WORKTREE_DIRTY" => ("WORKTREE_DIRTY", "worktreeDirty"),
        "WORKTREE_BUSY_JOBS" => ("WORKTREE_BUSY_JOBS", "worktreeBusyJobs"),
        "WORKTREE_PROJECT_MISMATCH" => ("WORKTREE_PROJECT_MISMATCH", "worktreeProjectMismatch"),
        "WORKTREE_BRANCH_OCCUPIED" => ("WORKTREE_BRANCH_OCCUPIED", "worktreeBranchOccupied"),
        "WORKTREE_DISK_INSUFFICIENT" => {
            details["path"] = json!("");
            ("WORKTREE_DISK_INSUFFICIENT", "worktreeDiskInsufficient")
        }
        _ => return ScmFailure::git(error["message"].as_str().unwrap()),
    };
    details["type"] = json!(tag);
    ScmFailure::coded_with_message(code, serde_json::from_value::<DomainErrorDetail>(details).unwrap(), error["message"].as_str().unwrap())
}

/// Real-repository [`SessionWorktrees`] for the git tool tests: delegates raw `add`, `snapshot`
/// and `remove-path` to `Worktrees` with the Lead session's project and owner checks.
struct LocalSessions {
    session: String,
    project: PathBuf,
    worktrees: Arc<Worktrees>,
}

#[async_trait]
impl SessionWorktrees for LocalSessions {
    async fn is_lead(&self, session_id: &str) -> bool {
        session_id == self.session
    }

    async fn run(&self, op: SessionOp, caller: &str, cancel: &CancellationToken) -> Result<JsonValue, ScmFailure> {
        match op {
            SessionOp::Add { branch, create, start_point, confirm_large, tx_id, .. } => {
                let record = self
                    .worktrees
                    .create(
                        mixdog_scm::worktree::manager::CreateRequest {
                            project_path: self.project.clone(),
                            session_id: caller.to_owned(),
                            tx_id,
                            name_hint: branch.clone(),
                            base_branch: None,
                            branch: Some(branch.clone()),
                            existing_branch: !create,
                            start_commit: start_point,
                            confirm_large,
                            carry: None,
                            runtime_token: String::new(),
                        },
                        cancel,
                    )
                    .await?;
                Ok(json!({
                    "path": record.path,
                    "branch": branch,
                    "worktreeId": record.id,
                    "created": true,
                    "baseCommit": record.base_commit,
                    "mergeTarget": record.merge_target,
                }))
            }
            SessionOp::Snapshot { commit, confirm_large, tx_id, .. } => {
                self.worktrees.create_worker_snapshot(caller, &self.project, &commit, &tx_id, confirm_large, cancel).await
            }
            SessionOp::RemovePath { path, force } => {
                self.worktrees.remove_by_path(Path::new(&path), force, Some(caller), cancel).await.map_err(|failure| match failure {
                    ScmFailure::Coded { code: "WORKTREE_PATH_UNSAFE", .. } => ScmFailure::git(format!(
                        "git worktree remove: {path} is not a Mixdog-managed worktree; unmanaged worktrees are not removed through the git tool"
                    )),
                    other => other,
                })
            }
            other => Err(ScmFailure::git(format!("unexpected session op in LocalSessions: {other:?}"))),
        }
    }
}

#[async_trait]
impl SessionWorktrees for ScriptSessions {
    async fn is_lead(&self, session_id: &str) -> bool {
        session_id == self.session
    }

    async fn run(&self, op: SessionOp, _caller: &str, _cancel: &CancellationToken) -> Result<JsonValue, ScmFailure> {
        let request = node_request(&op);
        let reply = self.script[request["op"].as_str().unwrap()].clone();
        self.requests.lock().unwrap().push(request);
        match reply.get("error") {
            Some(error) => Err(scripted_failure(error)),
            None => Ok(reply),
        }
    }
}

/// The store keeps the case's session, so its worktrees are retained; nothing else is stored, a
/// favorite, archived or running a job.
struct Stores(String);

#[async_trait]
impl SessionSource for Stores {
    async fn stored_session_ids(&self) -> Result<HashSet<String>, ScmFailure> {
        Ok([self.0.clone()].into())
    }
    async fn favorites(&self) -> Option<HashSet<String>> {
        None
    }
    async fn archived(&self) -> Option<HashSet<String>> {
        None
    }
    async fn activity(&self, _: &[String]) -> HashMap<String, SessionActivity> {
        HashMap::new()
    }
    async fn running_jobs(&self) -> Result<Vec<ShellJob>, ScmFailure> {
        Ok(Vec::new())
    }
}

/// `session` is the one the store keeps; no session is open in this process.
fn services(sessions: Arc<dyn SessionWorktrees>, session: &str, data_dir: PathBuf) -> Arc<WorktreeServices> {
    let tokens = mixdog_rt::testing::tokens();
    let scm = Scm::new(processes::TestProcesses::shared(), tokens.maintenance_io, data_dir.join("scratch"));
    Arc::new(WorktreeServices {
        worktrees: Arc::new(Worktrees::new(scm, data_dir)),
        stored: Arc::new(Stores(session.to_owned())),
        live: Arc::new(HashSet::new),
        sessions,
    })
}

fn context(cwd: &Path, session: &str, call: &str) -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
    ToolContext {
        call_id: ToolCallId::from(call),
        thread_id: ThreadId::from(session),
        turn_id: TurnId::from("r"),
        tool: "git".into(),
        cwd: AbsPath::new(cwd).unwrap(),
        surface: SurfaceKind::Lead,
        cancel: CancellationToken::new(),
        deadline: None,
        progress: Arc::new(MockProgress::default()),
        io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        approvals: Arc::new(MockApprovalGate::default()),
        files: Arc::new(MockFileService::default()),
        processes: processes::TestProcesses::shared(),
        options: Default::default(),
        review: None,
    }
}

/// A finished git call — whatever it answered — tells the turn review the session's folder.
#[tokio::test(flavor = "multi_thread")]
async fn a_finished_git_call_notes_the_session_folder_for_the_turn_review() {
    let tmp = tempfile::tempdir().unwrap();
    let review = Arc::new(crate::exec::settle::RecordingReview::default());
    let tool = GitTool::new();
    let mut c1 = context(tmp.path(), "worker", "c1");
    c1.review = Some(review.clone());
    let mut c2 = context(tmp.path(), "worker", "c2");
    c2.review = Some(review.clone());
    let _ = tool.call(&c1, json!({"command": "git nonsense"})).await;
    let _ = tool.call(&c2, json!({})).await;
    let folder = tmp.path().to_string_lossy().into_owned();
    assert_eq!(*review.notes.lock().unwrap(), vec![Some(vec![folder.clone()]), Some(vec![folder])]);
}

fn text_of(outcome: ToolOutcome) -> String {
    match outcome.expect("the git tool answers in text").parts.first() {
        Some(ToolPart::Text(text)) => text.clone(),
        other => panic!("not text: {other:?}"),
    }
}

struct Rig {
    _tmp: tempfile::TempDir,
    ws: PathBuf,
    tool: GitTool,
    services: Arc<WorktreeServices>,
}

fn rig() -> Rig {
    pin_environment();
    let tmp = tempfile::tempdir().unwrap();
    let work = strip_verbatim(tmp.path().canonicalize().unwrap());
    let ws = work.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    apply_setup(
        &ws,
        &[
            json!({"git": ["init", "-q", "-b", "main"]}),
            json!({"write": ["f.txt", "a\n"]}),
            json!({"git": ["add", "."]}),
            json!({"git": ["commit", "-q", "-m", "init"]}),
        ],
    );
    let data_dir = work.join("data");
    let tokens = mixdog_rt::testing::tokens();
    let scm = Scm::new(processes::TestProcesses::shared(), tokens.maintenance_io, data_dir.join("scratch"));
    let worktrees = Arc::new(Worktrees::new(scm, data_dir));
    let sessions: Arc<dyn SessionWorktrees> = Arc::new(LocalSessions { session: "lead".into(), project: ws.clone(), worktrees: worktrees.clone() });
    let services = Arc::new(WorktreeServices { worktrees, stored: Arc::new(Stores("lead".into())), live: Arc::new(HashSet::new), sessions });
    Rig { tool: GitTool::new().with_worktrees(services.clone()), services, ws, _tmp: tmp }
}

async fn run(rig: &Rig, session: &str, cwd: &Path, input: Value) -> String {
    text_of(rig.tool.call(&context(cwd, session, "call1"), input).await)
}

fn parsed(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|e| panic!("not JSON ({e}): {text}"))
}

#[tokio::test]
async fn a_lead_adds_lists_and_removes_a_managed_worktree_on_a_real_repository() {
    let rig = rig();
    let added = parsed(&run(&rig, "lead", &rig.ws, json!({"command": "git worktree add -b feat ../elsewhere"})).await);
    assert_eq!(added["ok"], true, "{added}");
    assert_eq!(added["branch"], "feat");
    assert_eq!(added["created"], true, "{added}");
    assert!(added["worktreeId"].as_str().is_some(), "{added}");
    let managed = PathBuf::from(added["path"].as_str().unwrap());
    assert!(managed.join(".git").exists() && !rig.ws.join("../elsewhere").exists());
    assert!(added["note"].as_str().unwrap().contains("worktree_action:\"enter\" with branch:\"feat\""));

    let listed = parsed(&run(&rig, "lead", &rig.ws, json!({"action": "worktree", "worktree_action": "list"})).await);
    let rows = listed["worktrees"].as_array().unwrap();
    assert_eq!(rows[0]["main"], true);
    let row = rows.iter().find(|r| r["branch"] == "feat").expect("the managed row is listed");
    assert_eq!(row["ownerSessionId"], "lead");
    assert_eq!(row["removable"], false, "a retained worktree is not removable: {row}");

    let dry = parsed(&run(&rig, "lead", &rig.ws, json!({"command": "git worktree prune -n"})).await);
    assert_eq!(dry["dryRun"], true);
    assert_eq!(dry["wouldRemove"].as_array().unwrap().len(), 0);

    let removed = parsed(&run(&rig, "lead", &rig.ws, json!({"command": format!("git worktree remove {}", managed.display())})).await);
    assert_eq!(removed["ok"], true, "{removed}");
    assert_eq!(removed["removed"], true);
    assert!(!managed.exists());
}

#[tokio::test]
async fn a_snapshot_is_leased_by_commands_in_it_and_removed_through_its_ledger() {
    let rig = rig();
    let snapshot = parsed(&run(&rig, "lead", &rig.ws, json!({"command": "git worktree add --detach ../snap"})).await);
    assert_eq!(snapshot["snapshot"], true, "{snapshot}");
    let path = PathBuf::from(snapshot["path"].as_str().unwrap());
    assert!(path.join("f.txt").exists());
    // A command run in the snapshot works and leaves no lease behind.
    let status = run(&rig, "lead", &path, json!({"command": "git status --short"})).await;
    assert!(!status.starts_with("error:"), "{status}");
    let listed = parsed(&run(&rig, "lead", &rig.ws, json!({"command": "git worktree list"})).await);
    assert!(listed["worktrees"].as_array().unwrap().iter().any(|r| r["snapshot"] == true));

    // While a lease is held the ledger refuses the removal; once released it goes.
    let lease = rig.services.worktrees.ledger().admit(&path).unwrap();
    let refused = run(&rig, "lead", &rig.ws, json!({"command": format!("git worktree remove -f {}", path.display())})).await;
    assert!(refused.contains("WORKTREE_BUSY_JOBS"), "{refused}");
    drop(lease);
    let removed = parsed(&run(&rig, "lead", &rig.ws, json!({"command": format!("git worktree remove -f {}", path.display())})).await);
    assert_eq!(removed["removed"], true, "{removed}");
    assert!(!path.exists());
}

#[tokio::test]
async fn a_worker_may_only_make_a_snapshot_and_an_unmanaged_path_is_not_removed() {
    let rig = rig();
    let refused = run(&rig, "worker", &rig.ws, json!({"command": "git worktree add -b feat ../w"})).await;
    assert!(refused.starts_with("error: git worktree add belongs to the Lead session"), "{refused}");
    let snap = parsed(&run(&rig, "worker", &rig.ws, json!({"command": "git worktree add --detach ../w"})).await);
    assert_eq!(snap["snapshot"], true, "{snap}");
    let listed = run(&rig, "worker", &rig.ws, json!({"command": "git worktree remove ../w"})).await;
    assert!(listed.starts_with("error: git worktree remove belongs to the Lead session"), "{listed}");
    let unmanaged = run(&rig, "lead", &rig.ws, json!({"command": "git worktree remove ../nowhere"})).await;
    assert!(unmanaged.contains("is not a Mixdog-managed worktree"), "{unmanaged}");
}

#[tokio::test]
async fn a_file_name_with_non_ascii_characters_is_shown_as_it_is() {
    let rig = rig();
    std::fs::write(rig.ws.join("한글.txt"), "x\n").unwrap();
    let status = run(&rig, "lead", &rig.ws, json!({"command": "git status --short"})).await;
    assert!(status.contains("한글.txt"), "not octal-escaped: {status}");
}

/// A repository (`f.txt` committed as `a`) with `f.txt` changed and an untracked `u.txt`, driven by a tool without a worktree host.
struct Plain {
    _tmp: tempfile::TempDir,
    ws: PathBuf,
    tool: GitTool,
}

fn plain() -> Plain {
    let rig = rig();
    std::fs::write(rig.ws.join("f.txt"), "A\n").unwrap();
    std::fs::write(rig.ws.join("u.txt"), "new\n").unwrap();
    Plain { tool: GitTool::new(), ws: rig.ws, _tmp: rig._tmp }
}

impl Plain {
    async fn run(&self, input: Value) -> String {
        text_of(self.tool.call(&context(&self.ws, "worker", "call1"), input).await)
    }
}

#[tokio::test]
async fn a_git_batch_rejects_invalid_later_syntax_before_any_spawn() {
    let tmp = tempfile::tempdir().unwrap();
    let processes = Arc::new(MockProcessManager::default());
    let mut ctx = context(tmp.path(), "worker", "preflight");
    ctx.processes = processes.clone();
    let result = GitTool::new().call(&ctx, json!({"command": ["git init", "git log | head"]})).await;
    assert!(text_of(result).starts_with("error: git command 2:"));
    assert!(processes.list().is_empty());
}

#[tokio::test]
async fn a_git_command_runs_with_or_without_its_git_word_and_a_list_runs_each_in_turn() {
    let p = plain();
    let status = "## main\n M f.txt\n?? u.txt\n";
    assert_eq!(p.run(json!({"command": "git status --short"})).await, status);
    assert_eq!(p.run(json!({"command": "status -s"})).await, status);
    assert_eq!(p.run(json!({"command": ["git log --format=%s", "git branch --list"]})).await, "## 1: git log\ninit\n\n## 2: git branch\n* main\n");
    assert_eq!(p.run(json!({"command": "[\"git log --format=%s\",\"git branch --list\"]"})).await, "## 1: git log\ninit\n\n## 2: git branch\n* main\n");
    assert_eq!(p.run(json!({"command": "git log --format=%h|%s -n 1"})).await.split_once('|').map(|(_, s)| s), Some("init\n"));
    let failing = p.run(json!({"command": ["git status --short", "git not-a-command", "git log"]})).await;
    assert!(failing.starts_with(&format!("## 1: git status\n{status}\n## 2: git not-a-command\nexit 1\n")), "{failing}");
    assert!(failing.ends_with("error: command failed: 2: git not-a-command"), "{failing}");
    assert_eq!(p.run(json!({"command": "git add f.txt && git status --short"})).await, "## 1: git add\n\n## 2: git status\n## main\nM  f.txt\n?? u.txt\n");
}

#[tokio::test]
async fn a_command_that_finds_nothing_or_fails_reports_its_exit_and_a_non_repository_says_so() {
    let p = plain();
    assert_eq!(p.run(json!({"command": "git grep nomatch"})).await, "exit 1\n[outcome: no-match]");
    assert!(p.run(json!({"command": "git diff --exit-code"})).await.starts_with("exit 1\n[outcome: no-match]\ndiff --git a/f.txt b/f.txt\n"));
    assert_eq!(p.run(json!({"command": "git config user.name"})).await, "exit 1");
    let capped = p.run(json!({"command": "git status", "output_limit": 1})).await;
    assert!(capped.starts_with("## main\n[output capped at 1 lines; 2 more lines omitted;"), "{capped}");
    let outside = tempfile::tempdir().unwrap();
    let text = text_of(p.tool.call(&context(outside.path(), "worker", "call1"), json!({"command": "git status"})).await);
    assert!(text.starts_with("exit 128\nfatal: not a git repository"), "{text}");
}

#[tokio::test]
async fn a_command_that_would_hang_leave_the_repository_or_chain_shell_work_is_refused_before_it_runs() {
    let p = plain();
    for (input, want) in [
        (json!({"command": "git config --global user.name x"}), "error: git config --global is outside the local repository scope"),
        (
            json!({"command": "git log | head"}),
            "error: git command must not contain shell operators or substitution; multiple commands belong in the command array. For | head/tail use output_limit, for | grep use the grep tool",
        ),
        (
            json!({"command": "git gui"}),
            "error: git gui opens an interactive GUI and would never return here; use its non-interactive form (diff, merge, add -p)",
        ),
        (json!({"command": "git archive HEAD"}), "error: git archive requires -o/--output; binary stdout is not returned"),
        (json!({"command": "git -C"}), "error: git -C requires a path"),
        (json!({"command": []}), "error: git command array requires 1 to 10 commands"),
        (json!({}), "error: git requires command: a full command starting with git, e.g. command:\"git status\""),
        (
            json!({"include_stage_ids": true}),
            "error: git requires command; staging IDs come from command:\"git diff\" (or \"git diff -- <paths>\") with include_stage_ids:true",
        ),
        (json!({"action": "sideways"}), "error: git action must be command, stage or worktree"),
        (json!({"command": "git worktree add --help"}), "error: git manual help can open an external viewer; use the subcommand -h form for terminal usage"),
    ] {
        assert_eq!(p.run(input.clone()).await, want, "{input}");
    }
}

#[tokio::test]
async fn git_writes_commit_branch_and_tag_through_the_tool() {
    let p = plain();
    for command in ["git add -A", "git commit -q -m second", "git branch topic", "git tag -a v1 -m x"] {
        assert_eq!(p.run(json!({"command": command})).await, "", "{command}");
    }
    assert_eq!(p.run(json!({"command": "git log --format=%s"})).await, "second\ninit\n");
    assert_eq!(p.run(json!({"command": "git branch --list"})).await, "* main\n  topic\n");
}

fn diff_id_of(text: &str) -> String {
    let rest = &text[text.find("diff_id: ").expect("a diff id") + "diff_id: ".len()..];
    rest[..rest.find(' ').unwrap()].to_owned()
}

#[tokio::test]
async fn staged_changes_are_chosen_by_the_ids_a_diff_hands_out() {
    let p = plain();
    let diff = p.run(json!({"command": "git diff", "include_stage_ids": true})).await;
    assert!(diff.contains("f.txt: c1\nu.txt: c2 [whole file]"), "{diff}");
    let id = diff_id_of(&diff);
    let staged = p.run(json!({"action": "stage", "change_ids": "[\"c1\",\"c2\"]", "diff_id": id})).await;
    assert_eq!(
        parsed(&staged),
        json!({"ok": true, "staged": true, "changes": 2, "additions": 2, "deletions": 1, "files": ["f.txt: 1 change +1 -1", "u.txt: 1 change +1 -0"]})
    );
    assert_eq!(p.run(json!({"command": "git status --short"})).await, "## main\nM  f.txt\nA  u.txt\n");
}

#[tokio::test]
async fn a_stage_request_for_a_gone_changed_or_foreign_diff_is_declined_with_what_to_do() {
    let p = plain();
    let id = diff_id_of(&p.run(json!({"command": "git diff", "include_stage_ids": true})).await);
    let expired = parsed(&p.run(json!({"action": "stage", "change_ids": ["c1"], "diff_id": "diff_nope"})).await);
    assert_eq!(expired["reason"], "expired_diff");
    assert_eq!(expired["staged"], false);
    assert_eq!(p.run(json!({"action": "stage", "change_ids": ["c99"], "diff_id": id})).await, "error: git stage change_ids are not present in the diff: c99");
    std::fs::create_dir(p.ws.join("sub")).unwrap();
    let scope = text_of(p.tool.call(&context(&p.ws.join("sub"), "worker", "call1"), json!({"action": "stage", "change_ids": ["c1"], "diff_id": id})).await);
    assert_eq!(parsed(&scope)["reason"], "scope_mismatch");
    std::fs::write(p.ws.join("f.txt"), "A\nmore\n").unwrap();
    let stale = parsed(&p.run(json!({"action": "stage", "change_ids": ["c1"], "diff_id": id})).await);
    assert_eq!(stale["reason"], "stale_diff");
}

#[tokio::test]
async fn a_stage_or_worktree_call_with_arguments_that_do_not_belong_together_is_refused_naming_them() {
    let p = plain();
    let fifty_one: Vec<String> = (1..=51).map(|n| format!("c{n}")).collect();
    for (input, want) in [
        (json!({"action": "stage", "change_ids": ["c1"]}), "error: git stage requires diff_id from a prior git diff"),
        (json!({"action": "stage", "diff_id": "diff_x"}), "error: git stage requires at least one change_id"),
        (json!({"action": "stage", "change_ids": fifty_one, "diff_id": "d"}), "error: git stage accepts at most 50 change_ids"),
        (
            json!({"action": "stage", "change_ids": ["c1"], "command": "git status", "diff_id": "diff_x"}),
            "error: git action:stage accepts diff_id/change_ids, not command/include_stage_ids",
        ),
        (json!({"command": "git status", "diff_id": "diff_x"}), "error: git diff_id/change_ids require action:stage"),
        (json!({"action": "worktree"}), "error: git action:worktree requires worktree_action: enter, return, merge, remove, list, prune"),
        (json!({"action": "worktree", "command": "git status", "worktree_action": "list"}), "error: git action:worktree does not take command"),
        (json!({"action": "worktree", "force": true, "worktree_action": "merge"}), "error: force applies to worktree_action remove, not merge"),
        (json!({"action": "worktree", "branch": "x", "worktree_action": "merge"}), "error: branch applies to worktree_action enter, remove, not merge"),
        (json!({"action": "worktree", "create": true, "worktree_action": "enter"}), "error: create needs branch"),
        (
            json!({"action": "worktree", "branch": "b", "name": "n", "worktree_action": "enter"}),
            "error: branch excludes name and carry (the branch names the worktree; changes stay in the project folder)",
        ),
        (json!({"action": "worktree", "carry": "maybe", "worktree_action": "enter"}), "error: carry must be leave or carry"),
        (
            json!({"action": "worktree", "branch": "b", "session_id": "s", "worktree_action": "remove"}),
            "error: branch names one of this session's own worktrees; it excludes session_id",
        ),
        (json!({"command": "git status", "worktree_action": "list"}), "error: git worktree_action requires action:worktree"),
        (json!({"command": "git status", "force": true}), "error: git force requires action:worktree"),
        (
            json!({"action": "stage", "change_ids": ["c1"], "confirm_large": true, "diff_id": "d"}),
            "error: git confirm_large applies to action:worktree or a git worktree add command",
        ),
    ] {
        assert_eq!(p.run(input.clone()).await, want, "{input}");
    }
}

#[tokio::test]
async fn without_a_lead_session_worktrees_are_only_listed_and_snapshots_are_the_only_addition() {
    let p = plain();
    let listed = parsed(&p.run(json!({"action": "worktree", "worktree_action": "list"})).await);
    assert_eq!(listed["worktrees"].as_array().unwrap().len(), 1);
    assert_eq!(listed["worktrees"][0]["branch"], "main");
    assert_eq!(listed["worktrees"][0]["main"], true);
    assert_eq!(p.run(json!({"command": "git worktree list -x"})).await, "error: git worktree list: option -x is not supported");
    assert_eq!(
        p.run(json!({"command": "git worktree add ../wt"})).await,
        "error: git worktree add belongs to the Lead session; a delegated worker may only make a read-only snapshot: git worktree add --detach <path> [<commit>]"
    );
    assert_eq!(
        p.run(json!({"command": "git worktree prune"})).await,
        "error: git worktree prune belongs to the Lead session; delegated workers cannot create, change or remove worktrees"
    );
    assert_eq!(
        p.run(json!({"action": "worktree", "branch": "feat", "worktree_action": "enter"})).await,
        "error: git worktree_action enter belongs to the Lead session; delegated workers cannot create, change or remove worktrees"
    );
    assert_eq!(
        p.run(json!({"command": "git worktree move a b"})).await,
        "error: git worktree move is refused: Mixdog-managed worktrees stay at their fixed, locked locations. Use git worktree list/remove/prune or action:\"worktree\""
    );
    assert_eq!(
        p.run(json!({"command": "git worktree frob"})).await,
        "error: git worktree frob is not supported; use add, remove, list, prune or action:\"worktree\""
    );
}

#[tokio::test]
async fn a_lead_worktree_add_with_options_that_cannot_be_managed_is_refused_naming_the_option() {
    let rig = rig();
    for (command, want) in [
        ("git worktree add -b main ../w", "error: git worktree add: a branch named 'main' already exists (omit -b to check it out)"),
        (
            "git worktree add -B main ../w",
            "error: git worktree add: -B would reset the existing branch main; managed worktrees never reset a branch (omit -B to check it out as it is)",
        ),
        ("git worktree add -b", "error: git worktree add: -b requires a branch name"),
        ("git worktree add --detach -b x ../w", "error: git worktree add: --detach excludes -b/-B"),
        ("git worktree add --orphan ../w", "error: git worktree add: --orphan is not supported for managed worktrees"),
        ("git worktree add --bogus ../w", "error: git worktree add: option --bogus is not supported for managed worktrees"),
        ("git worktree add", "error: git worktree add requires <path> [<commit-ish>]"),
        ("git worktree add a b c", "error: git worktree add requires <path> [<commit-ish>]"),
        ("git worktree add ../w nonsense-ref", "error: git worktree add: nonsense-ref is not a commit"),
        ("git worktree remove", "error: git worktree remove requires exactly one <path>"),
        ("git worktree remove --weird ../w", "error: git worktree remove: option --weird is not supported"),
        (
            "git worktree prune --expire=now",
            "error: git worktree prune: option --expire=now is not supported (managed prune takes -n/--dry-run and -v/--verbose)",
        ),
        ("git worktree prune extra", "error: git worktree prune: unexpected argument extra"),
    ] {
        assert_eq!(run(&rig, "lead", &rig.ws, json!({"command": command})).await, want, "{command}");
    }
}

#[tokio::test]
async fn a_lead_session_transition_is_sent_to_the_runtime_with_what_was_asked_and_its_answer_is_relayed() {
    let tmp = tempfile::tempdir().unwrap();
    let work = strip_verbatim(tmp.path().canonicalize().unwrap());
    let ws = work.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let sessions = Arc::new(ScriptSessions {
        session: "lead".into(),
        script: json!({
            "enter": {"extra": 1, "workspace": {"cwd": "/wt", "branch": "feat"}},
            "return": {"unchanged": false},
            "merge": {"error": {"code": "MERGE_CONFLICT", "message": "Nothing was merged.", "details": {"files": ["a", "b"]}}},
            "remove": {"error": {"code": "OTHER", "message": "git merge failed (exit 1): nope"}},
        }),
        requests: Mutex::new(Vec::new()),
    });
    let tool = GitTool::new().with_worktrees(services(sessions.clone(), "lead", work.join("data")));
    let go = |input: Value| text_of_future(&tool, &ws, input);
    let entered = parsed(&go(json!({"action": "worktree", "worktree_action": "enter", "branch": "feat", "create": true})).await);
    assert_eq!(
        (&entered["ok"], &entered["worktree_action"], &entered["extra"], &entered["workspace"]["branch"]),
        (&json!(true), &json!("enter"), &json!(1), &json!("feat"))
    );
    let returned = parsed(&go(json!({"action": "worktree", "worktree_action": "return", "session_id": "other"})).await);
    assert_eq!((&returned["ok"], &returned["sessionId"], &returned["unchanged"]), (&json!(true), &json!("other"), &json!(false)));
    let conflict = parsed(&go(json!({"action": "worktree", "worktree_action": "merge"})).await);
    assert_eq!((&conflict["ok"], &conflict["code"]), (&json!(false), &json!("MERGE_CONFLICT")));
    assert_eq!(conflict["details"]["files"], json!(["a", "b"]));
    assert!(conflict["next"].as_str().unwrap().contains("Resolve the conflict"), "{conflict}");
    let plain = go(json!({"action": "worktree", "worktree_action": "remove", "force": true})).await;
    assert_eq!(plain, "error: git merge failed (exit 1): nope");

    let seen = sessions.requests.lock().unwrap().clone();
    assert_eq!(seen.iter().map(|r| r["op"].as_str().unwrap()).collect::<Vec<_>>(), ["enter", "return", "merge", "remove"]);
    assert_eq!((&seen[0]["branch"], &seen[0]["create"]), (&json!("feat"), &json!(true)));
    assert_eq!(seen[1]["sessionId"], "other");
    assert_eq!(seen[3]["force"], true);
}

async fn text_of_future(tool: &GitTool, cwd: &Path, input: Value) -> String {
    text_of(tool.call(&context(cwd, "lead", "call1"), input).await)
}

#[tokio::test]
async fn raw_worktree_add_snapshot_and_remove_route_through_session_worktrees() {
    pin_environment();
    let tmp = tempfile::tempdir().unwrap();
    let work = strip_verbatim(tmp.path().canonicalize().unwrap());
    let ws = work.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    apply_setup(
        &ws,
        &[
            json!({"git": ["init", "-q", "-b", "main"]}),
            json!({"write": ["f.txt", "a\n"]}),
            json!({"git": ["add", "."]}),
            json!({"git": ["commit", "-q", "-m", "init"]}),
        ],
    );
    let sessions = Arc::new(ScriptSessions {
        session: "lead".into(),
        script: json!({
            "add": {"error": {"code": "WORKTREE_PROJECT_MISMATCH", "message": "Managed worktrees belong to this session's Project repository; run the command there.", "details": {"projectPath": "/other", "repoCommonDir": "/ws/.git"}}},
            "snapshot": {"id": "snapshot-1", "path": "/data/snapshot-1", "baseCommit": "abc"},
            "remove-path": {"error": {"code": "WORKTREE_BUSY_JOBS", "message": "This snapshot belongs to another session's turn; it is removed when that turn ends, or by a prune.", "details": {"reason": "snapshot-held", "sessionId": "other", "entryId": "snapshot-1"}}},
        }),
        requests: Mutex::new(Vec::new()),
    });
    let tool = GitTool::new().with_worktrees(services(sessions.clone(), "lead", work.join("data")));
    let mismatch = parsed(&text_of_future(&tool, &ws, json!({"command": "git worktree add -b feat ../w"})).await);
    assert_eq!((&mismatch["ok"], &mismatch["code"]), (&json!(false), &json!("WORKTREE_PROJECT_MISMATCH")));
    let snap = parsed(&text_of_future(&tool, &ws, json!({"command": "git worktree add --detach ../s"})).await);
    assert_eq!((&snap["ok"], &snap["snapshot"], &snap["worktreeId"]), (&json!(true), &json!(true), &json!("snapshot-1")));
    let refused = parsed(&text_of_future(&tool, &ws, json!({"command": "git worktree remove -f ../s"})).await);
    assert_eq!((&refused["ok"], &refused["code"]), (&json!(false), &json!("WORKTREE_BUSY_JOBS")));
    assert_eq!(refused["error"], "This snapshot belongs to another session's turn; it is removed when that turn ends, or by a prune.");

    let seen = sessions.requests.lock().unwrap().clone();
    assert_eq!(seen.iter().map(|r| r["op"].as_str().unwrap()).collect::<Vec<_>>(), ["add", "snapshot", "remove-path"]);
    assert_eq!((&seen[0]["branch"], &seen[0]["create"]), (&json!("feat"), &json!(true)));
    assert!(seen[0]["repoCommonDir"].as_str().is_some());
    assert!(seen[1]["repoCommonDir"].as_str().is_some());
    assert_eq!(seen[2]["force"], true);
}
