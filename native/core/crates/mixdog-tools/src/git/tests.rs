//! `git` tool behaviour against real repositories and the recorded Node goldens
//! (`fixtures/tools/git/*.json`, recorded by `record-tools-git.mjs`): every case rebuilds its
//! repository, replays its inputs and compares the text with Node's. A worktree case also
//! compares the requests the scripted session runtime received. Steps whose Node result came
//! from Node's own worktree manager (list, add, snapshot, remove-path, prune) are covered by
//! the real-repository tests below, which use `mixdog-scm`'s manager.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the test builds real repositories with blocking filesystem and process calls"
)]

use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::tool::*;
use mixdog_protocol::DomainErrorDetail;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use mixdog_scm::engine::Scm;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::worktree::manager::Retention;
use mixdog_scm::worktree::manager::Worktrees;
use mixdog_scm::worktree::registry::WorktreeRecord;
use regex::Regex;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::GitTool;
use super::SessionOp;
use super::SessionWorktrees;
use super::WorktreeServices;

#[path = "../../../mixdog-scm/src/testing.rs"]
mod processes;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tools/git")
}

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

struct Scrubber {
    forms: Vec<(String, &'static str)>,
}

impl Scrubber {
    fn new(root: &Path, work: &Path) -> Self {
        let mut forms = Vec::new();
        for (path, tag) in [(root, "<ROOT>"), (work, "<WORK>")] {
            let plain = path.to_string_lossy().into_owned();
            for n in [1usize, 2, 4, 8] {
                let spelled = plain.replace('\\', &"\\".repeat(n));
                forms.push((spelled.to_lowercase(), tag));
                forms.push((spelled, tag));
            }
            let fwd = plain.replace('\\', "/");
            forms.push((fwd.to_lowercase(), tag));
            forms.push((fwd, tag));
        }
        Self { forms }
    }

    fn text(&self, input: &str) -> String {
        let mut text = input.to_owned();
        for (form, tag) in &self.forms {
            text = text.replace(form.as_str(), tag);
        }
        let seps = Regex::new(r#"<(ROOT|WORK)>((?:\\+|/)[^"\s,}\]\\]*(?:\\+[^"\s,}\]\\]+)*)"#).unwrap();
        let runs = Regex::new(r"\\+").unwrap();
        text = seps
            .replace_all(&text, |c: &regex::Captures| format!("<{}>{}", &c[1], runs.replace_all(&c[2], "/")))
            .into_owned();
        let text = Regex::new(r"\b[0-9a-f]{40}\b").unwrap().replace_all(&text, "<SHA>").into_owned();
        Regex::new(r"diff_[0-9a-f]{20}").unwrap().replace_all(&text, "<DIFF_ID>").into_owned()
    }

    fn value(&self, value: &Value) -> Value {
        serde_json::from_str(&self.text(&value.to_string())).unwrap()
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
    }
    Value::Object(out)
}

fn scripted_failure(error: &Value) -> ScmFailure {
    let code = error["code"].as_str().unwrap();
    let mut details = error.get("details").cloned().unwrap_or_else(|| json!({}));
    let (code, tag): (&'static str, &str) = match code {
        "WORKTREE_LARGE_REPO_CONFIRM" => {
            details["thresholdBytes"] = json!(0);
            ("WORKTREE_LARGE_REPO_CONFIRM", "worktreeLargeRepoConfirm")
        }
        "WORKTREE_DIRTY" => ("WORKTREE_DIRTY", "worktreeDirty"),
        "WORKTREE_BUSY_JOBS" => ("WORKTREE_BUSY_JOBS", "worktreeBusyJobs"),
        "WORKTREE_DISK_INSUFFICIENT" => {
            details["path"] = json!("");
            ("WORKTREE_DISK_INSUFFICIENT", "worktreeDiskInsufficient")
        }
        _ => return ScmFailure::git(error["message"].as_str().unwrap()),
    };
    details["type"] = json!(tag);
    ScmFailure::coded(code, serde_json::from_value::<DomainErrorDetail>(details).unwrap())
}

#[async_trait]
impl SessionWorktrees for ScriptSessions {
    fn is_lead(&self, session_id: &str) -> bool {
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

/// Nobody is live and every session keeps its worktrees.
struct KeepAll;

impl Retention for KeepAll {
    fn owner_live(&self, _record: &WorktreeRecord) -> bool {
        false
    }

    fn retained(&self, _record: &WorktreeRecord) -> bool {
        true
    }
}

fn services(sessions: Arc<dyn SessionWorktrees>, data_dir: PathBuf) -> Arc<WorktreeServices> {
    let tokens = mixdog_rt::testing::tokens();
    let scm = Scm::new(processes::TestProcesses::shared(), tokens.maintenance_io, data_dir.join("scratch"));
    Arc::new(WorktreeServices {
        worktrees: Arc::new(Worktrees::new(scm, data_dir)),
        retention: Arc::new(KeepAll),
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
        io: ToolIo {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
        },
        approvals: Arc::new(MockApprovalGate::default()),
        files: Arc::new(MockFileService::default()),
        processes: processes::TestProcesses::shared(),
        options: Default::default(),
    }
}

fn text_of(outcome: ToolOutcome) -> String {
    match outcome.expect("the git tool answers in text").parts.first() {
        Some(ToolPart::Text(text)) => text.clone(),
        other => panic!("not text: {other:?}"),
    }
}

/// Session transitions are the only host operations this tool still sends out. Two scripted
/// refusals are left out until `mixdog-scm`'s `worktree::texts` words them: `MERGE_CONFLICT`
/// (no typed detail, no text) and `WORKTREE_LARGE_REPO_CONFIRM` (no text for the code itself).
fn replayable(step: &Value, case: &Value) -> bool {
    let unworded = |op: &str| {
        let code = case["host"]["script"][op]["error"]["code"].as_str();
        matches!(code, Some("MERGE_CONFLICT" | "WORKTREE_LARGE_REPO_CONFIRM"))
    };
    step.get("requests").and_then(Value::as_array).is_none_or(|requests| {
        requests.iter().all(|r| {
            matches!(r["op"].as_str(), Some("enter" | "return" | "merge" | "remove")) && !unworded(r["op"].as_str().unwrap_or(""))
        })
    })
}

#[tokio::test]
async fn every_recorded_case_replays_to_nodes_text() {
    pin_environment();
    let mut names: Vec<PathBuf> = std::fs::read_dir(fixtures())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    names.sort();
    assert!(names.len() >= 17, "git goldens are recorded");
    let mut failures: Vec<String> = Vec::new();
    let mut replayed = 0;
    let diff_id = Regex::new(r"diff_[0-9a-f]{20}").unwrap();
    for path in names {
        let case: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let work = strip_verbatim(tmp.path().canonicalize().unwrap());
        let ws = work.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        apply_setup(&ws, case["setup"].as_array().unwrap());
        let scrub = Scrubber::new(&ws, &work);
        let unscrub = |value: &Value| -> Value {
            serde_json::from_str(&value.to_string().replace("<ROOT>", &ws.to_string_lossy().replace('\\', "/"))).unwrap()
        };
        let script = case.get("host").map(|h| {
            Arc::new(ScriptSessions {
                session: h["sessionId"].as_str().unwrap().to_owned(),
                script: unscrub(&h["script"]),
                requests: Mutex::new(Vec::new()),
            })
        });
        let tool = match &script {
            Some(sessions) => GitTool::new().with_worktrees(services(sessions.clone(), work.join("data"))),
            None => GitTool::new(),
        };
        let session = case.get("host").map_or("worker", |h| h["sessionId"].as_str().unwrap());
        let call = case.get("host").map_or("", |h| h["toolCallId"].as_str().unwrap());
        let mut last_diff_id: Option<String> = None;
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            if let Some(write) = step.get("write") {
                apply_op(&ws, &json!({ "write": write }));
                continue;
            }
            if !replayable(step, &case) {
                continue;
            }
            let mut input = step["input"].to_string();
            if let Some(id) = &last_diff_id {
                input = input.replace("<DIFF_ID>", id);
            }
            let input: Value = serde_json::from_str(&input).unwrap();
            let cwd = step.get("cwd").and_then(Value::as_str).map_or(ws.clone(), |c| ws.join(c));
            let before = script.as_ref().map_or(0, |s| s.requests.lock().unwrap().len());
            let got = text_of(tool.call(&context(&cwd, session, call), input.clone()).await);
            replayed += 1;
            if let Some(m) = diff_id.find(&got) {
                last_diff_id = Some(m.as_str().to_owned());
            }
            let want = step["text"].as_str().unwrap();
            if scrub.text(&got) != want {
                failures.push(format!("{name} step {index} {input}\n  want: {want:?}\n  got:  {:?}", scrub.text(&got)));
            }
            if let (Some(sessions), Some(want)) = (&script, step.get("requests")) {
                let seen: Vec<Value> = sessions.requests.lock().unwrap()[before..].to_vec();
                let got = scrub.value(&Value::Array(seen));
                if &got != want {
                    failures.push(format!("{name} step {index} requests\n  want: {want}\n  got:  {got}"));
                }
            }
        }
    }
    assert!(replayed > 100, "most recorded steps replay ({replayed})");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
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
    let sessions = Arc::new(ScriptSessions { session: "lead".into(), script: json!({}), requests: Mutex::new(Vec::new()) });
    let services = services(sessions, work.join("data"));
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
    assert_eq!(added["state"], "ready");
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
