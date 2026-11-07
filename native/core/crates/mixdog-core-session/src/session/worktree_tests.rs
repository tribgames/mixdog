//! The workspace transitions against real temporary git repositories: the registry, git and
//! the managed store are the real ones; only the session runtime is a scripted host.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "tests drive git and the disk directly")]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use mixdog_scm::engine::Scm;
use mixdog_scm::worktree::maintenance::SessionActivity;
use mixdog_scm::worktree::maintenance::ShellJob;
use mixdog_scm::worktree::manager::Retention;
use mixdog_scm::worktree::registry::WorktreeRecord;
use mixdog_scm::worktree::settings::WorktreeSettings;
use mixdog_spawn::LocalProcessManager;
use mixdog_spawn::ProcessConfig;
use serde_json::Value;

use super::*;

pub(crate) fn git(cwd: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .current_dir(cwd)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

#[derive(Default)]
pub(crate) struct HostState {
    pub(crate) workspace: Option<Value>,
    pub(crate) cwd: String,
    pub(crate) turn_running: bool,
    pub(crate) fail_apply: bool,
    pub(crate) live: Vec<LiveSession>,
    pub(crate) shell_jobs: u64,
    /// A schedule, webhook, routine or room run: it may only list worktrees.
    pub(crate) unattended: bool,
    /// The desktop classification a Project switch stored.
    pub(crate) desktop: Option<Value>,
}

struct FakeHost {
    state: Arc<Mutex<HostState>>,
}

#[async_trait]
impl WorkspaceHost for FakeHost {
    async fn is_lead(&self, session_id: &str) -> bool {
        session_id == "lead"
    }

    async fn attended(&self, session_id: &str) -> bool {
        session_id == "lead" && !self.state.lock().unwrap().unattended
    }

    fn session(&self, session_id: &str) -> Option<SessionView> {
        let state = self.state.lock().unwrap();
        (session_id == "lead").then(|| SessionView {
            cwd: Some(state.cwd.clone()),
            runtime_cwd: state.cwd.clone(),
            workspace: state.workspace.clone(),
            desktop_project: None,
            has_messages: false,
        })
    }

    fn set_workspace(&self, _session_id: &str, workspace: Option<Value>) {
        self.state.lock().unwrap().workspace = workspace;
    }

    async fn activity(&self, _session_id: &str) -> LeadActivity {
        let state = self.state.lock().unwrap();
        LeadActivity { turn_running: state.turn_running, shell_jobs: state.shell_jobs, ..LeadActivity::default() }
    }

    fn live_sessions(&self) -> Vec<LiveSession> {
        self.state.lock().unwrap().live.clone()
    }

    async fn stored_consumers(&self) -> Result<Vec<LiveSession>, ScmFailure> {
        Ok(Vec::new())
    }

    async fn running_jobs(&self) -> Vec<JobCwd> {
        Vec::new()
    }

    async fn shell_job_count(&self, _session_ids: &[String]) -> u64 {
        0
    }

    async fn apply(&self, _session_id: &str, change: WorkspaceChange) -> Result<Undo, ScmFailure> {
        let mut state = self.state.lock().unwrap();
        if state.fail_apply {
            return Err(plain("save failed"));
        }
        let prior = (state.cwd.clone(), state.workspace.clone(), state.desktop.clone());
        state.cwd = change.cwd;
        state.workspace = Some(change.workspace);
        if change.desktop_session.is_some() {
            state.desktop = change.desktop_session;
        }
        let shared = self.state.clone();
        Ok(undo(async move {
            let mut state = shared.lock().unwrap();
            (state.cwd, state.workspace, state.desktop) = prior;
            Ok(())
        }))
    }

    async fn copy_project_identity(&self, _project: &str, _worktree: &str) -> Result<bool, ScmFailure> {
        Ok(false)
    }

    async fn run_pending_setup(&self, _session_id: &str, _cancel: &CancellationToken) -> Result<(), ScmFailure> {
        Ok(())
    }
}

struct KeepAll;

impl Retention for KeepAll {
    fn owner_live(&self, _record: &WorktreeRecord) -> bool {
        false
    }

    fn retained(&self, _record: &WorktreeRecord) -> bool {
        true
    }
}

/// The store keeps the Lead, so its worktrees are retained (never removable as orphans);
/// nothing else is stored, a favorite, archived or running a job.
struct StoresLead;

#[async_trait]
impl SessionSource for StoresLead {
    async fn stored_session_ids(&self) -> Result<std::collections::HashSet<String>, ScmFailure> {
        Ok(["lead".to_owned()].into())
    }
    async fn favorites(&self) -> Option<std::collections::HashSet<String>> {
        None
    }
    async fn archived(&self) -> Option<std::collections::HashSet<String>> {
        None
    }
    async fn activity(&self, _: &[String]) -> HashMap<String, SessionActivity> {
        HashMap::new()
    }
    async fn running_jobs(&self) -> Result<Vec<ShellJob>, ScmFailure> {
        Ok(Vec::new())
    }
}

/// The default settings, with `autoCleanup` switchable by the test.
struct Defaults(Arc<AtomicBool>);

#[async_trait]
impl SettingsSource for Defaults {
    async fn worktree_settings(&self) -> WorktreeSettings {
        WorktreeSettings { auto_cleanup: self.0.load(Ordering::SeqCst), ..WorktreeSettings::default() }
    }
}

pub(crate) struct Rig {
    pub(crate) _dir: tempfile::TempDir,
    pub(crate) repo: PathBuf,
    pub(crate) data: PathBuf,
    pub(crate) state: Arc<Mutex<HostState>>,
    pub(crate) auto_cleanup: Arc<AtomicBool>,
    pub(crate) ws: SessionWorkspaces,
    pub(crate) worktrees: Arc<Worktrees>,
}

pub(crate) fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "core.autocrlf", "false"]);
    std::fs::write(repo.join("f.txt"), "a\nb\nc\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    let tokens = mixdog_rt::testing::tokens();
    let processes = Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default()));
    let data = dir.path().join("data");
    let data_dir = data.clone();
    let scm = Scm::new(processes, tokens.maintenance_io, data.join("scratch"));
    let worktrees = Arc::new(Worktrees::new(scm, data));
    let state = Arc::new(Mutex::new(HostState { cwd: repo.to_string_lossy().into_owned(), ..HostState::default() }));
    let auto_cleanup = Arc::new(AtomicBool::new(true));
    let ws = SessionWorkspaces::new(
        worktrees.clone(),
        Arc::new(StoresLead),
        Arc::new(std::collections::HashSet::new),
        Arc::new(Defaults(auto_cleanup.clone())),
        Arc::new(FakeHost { state: state.clone() }),
        AdmissionGate::new(),
    );
    Rig { _dir: dir, repo, data: data_dir, state, auto_cleanup, ws, worktrees }
}

pub(crate) fn enter(name: &str, call: &str) -> SessionOp {
    SessionOp::Enter {
        session_id: None,
        name: Some(name.into()),
        branch: None,
        create: false,
        carry: None,
        confirm_large: false,
        tx_id: format!("{call}:enter"),
    }
}

pub(crate) async fn run(rig: &Rig, op: SessionOp) -> Result<Value, ScmFailure> {
    rig.ws.run(op, "lead", &CancellationToken::new()).await
}

fn code(result: &Result<Value, ScmFailure>) -> Option<&'static str> {
    result.as_ref().err().and_then(ScmFailure::code)
}

#[tokio::test]
async fn a_session_enters_returns_merges_and_removes_its_worktree() {
    let rig = rig();
    let entered = run(&rig, enter("feat", "c1")).await.unwrap();
    assert_eq!(entered["revision"], 1);
    assert_eq!(entered["warnings"], json!([]));
    let workspace = &entered["workspace"];
    assert_eq!(workspace["branch"], "feat");
    assert_eq!(workspace["mergeTarget"], "main");
    assert_eq!(workspace["transition"], json!({"state": "idle", "txId": null}));
    let cwd = PathBuf::from(workspace["cwd"].as_str().unwrap());
    assert!(cwd.join("f.txt").exists());
    assert_eq!(rig.state.lock().unwrap().cwd, cwd.to_string_lossy());
    assert_eq!(rig.ws.gate().workspace_cwd_lock(&["lead"]).as_deref(), cwd.to_str());
    // Entering again is a no-op at the same revision.
    assert_eq!(run(&rig, enter("feat", "c1b")).await.unwrap()["revision"], 1);

    std::fs::write(cwd.join("g.txt"), "x\n").unwrap();
    git(&cwd, &["add", "."]);
    git(&cwd, &["commit", "-q", "-m", "work"]);

    // The auto-cleanup after a merge never moves the session: it stays bound, so the cleanup is
    // reported refused and the merge stands.
    let merged = run(&rig, SessionOp::Merge { session_id: None, tx_id: "c2:merge".into() }).await.unwrap();
    assert_eq!(merged["merged"], true);
    assert_eq!(merged["cleanup"]["removed"], false);
    assert_eq!(merged["cleanup"]["code"], "WORKTREE_BUSY_JOBS");
    assert!(rig.repo.join("g.txt").exists());

    let returned = run(&rig, SessionOp::Return { session_id: None, tx_id: "c3:return".into() }).await.unwrap();
    assert_eq!(returned["revision"], 2);
    assert_eq!(returned["workspace"]["worktreeId"], Value::Null);
    assert_eq!(returned["workspace"]["branch"], "main");
    assert_eq!(
        rig.state.lock().unwrap().cwd.replace('\\', "/"),
        rig.repo.to_string_lossy().replace('\\', "/")
    );
    assert_eq!(rig.ws.gate().workspace_cwd_lock(&["lead"]), None);
    let again = run(&rig, SessionOp::Return { session_id: None, tx_id: "c3b:return".into() }).await.unwrap();
    assert_eq!(again["unchanged"], true);

    let removed = run(&rig, SessionOp::Remove { session_id: None, branch: None, force: false, tx_id: "c4:remove".into() })
        .await
        .unwrap();
    assert_eq!(removed["removed"]["removed"], true);
    assert!(!cwd.exists());
    let rows = rig.worktrees.list(None, &KeepAll, &CancellationToken::new()).await.unwrap();
    assert!(rows.is_empty());
}

#[tokio::test]
async fn a_stale_revision_and_a_running_turn_refuse_and_leave_the_session_alone() {
    let rig = rig();
    let cancel = CancellationToken::new();
    let stale = rig
        .ws
        .select_branch("lead", SelectBranch { branch: "x".into(), expected_revision: Some(5), ..SelectBranch::default() }, true, &cancel)
        .await;
    assert_eq!(stale.err().and_then(|e| e.code()), Some("WORKTREE_REVISION_CONFLICT"));

    rig.state.lock().unwrap().turn_running = true;
    let busy = rig
        .ws
        .select_branch("lead", SelectBranch { branch: "x".into(), create: true, ..SelectBranch::default() }, false, &cancel)
        .await;
    assert_eq!(busy.err().and_then(|e| e.code()), Some("WORKTREE_BUSY_JOBS"));
    // The in-flight marker is gone and nothing was created.
    assert!(rig.state.lock().unwrap().workspace.is_none());
    assert!(git(&rig.repo, &["branch", "--list", "x"]).is_empty());
    // The Lead's own tool call tolerates its calling turn.
    let own = rig
        .ws
        .select_branch("lead", SelectBranch { branch: "x".into(), create: true, ..SelectBranch::default() }, true, &cancel)
        .await
        .unwrap();
    assert_eq!(own["workspace"]["branch"], "x");
    assert!(own["workspace"]["worktreeId"].is_string());
}

#[tokio::test]
async fn uncommitted_changes_must_be_decided_before_a_worktree_is_made() {
    let rig = rig();
    std::fs::write(rig.repo.join("f.txt"), "changed\n").unwrap();
    let asked = run(&rig, enter("feat", "c1")).await;
    assert_eq!(code(&asked), Some("WORKTREE_DIRTY_CHOICE"));
    assert!(rig.worktrees.list(None, &KeepAll, &CancellationToken::new()).await.unwrap().is_empty());
    let SessionOp::Enter { session_id, name, branch, create, confirm_large, tx_id, .. } = enter("feat", "c2") else { unreachable!() };
    let left = run(
        &rig,
        SessionOp::Enter { session_id, name, branch, create, carry: Some("leave".into()), confirm_large, tx_id },
    )
    .await
    .unwrap();
    assert_eq!(left["changes"], json!({"mode": "left", "count": 1}));
    assert_eq!(std::fs::read_to_string(rig.repo.join("f.txt")).unwrap(), "changed\n");
    let carry = run(&rig, SessionOp::Enter {
        session_id: None,
        name: Some("other".into()),
        branch: None,
        create: false,
        carry: Some("carry".into()),
        confirm_large: false,
        tx_id: "c3:enter".into(),
    })
    .await;
    // Already bound: the request returns the current workspace without examining changes.
    assert_eq!(carry.unwrap()["pending"], false);
}

#[tokio::test]
async fn a_failed_save_rolls_the_move_back_and_keeps_the_created_worktree_retained() {
    let rig = rig();
    rig.state.lock().unwrap().fail_apply = true;
    let failed = run(&rig, enter("feat", "c1")).await;
    assert!(failed.is_err());
    {
        let state = rig.state.lock().unwrap();
        assert!(state.workspace.is_none());
        assert_eq!(state.cwd, rig.repo.to_string_lossy());
    }
    assert_eq!(rig.ws.gate().workspace_cwd_lock(&["lead"]), None);
    // The worktree stays retained under the same transaction; the retry enters it.
    rig.state.lock().unwrap().fail_apply = false;
    let entered = run(&rig, enter("feat", "c1")).await.unwrap();
    assert_eq!(entered["revision"], 1);
    let rows = rig.worktrees.list(None, &KeepAll, &CancellationToken::new()).await.unwrap();
    assert_eq!(rows.len(), 1);
}

#[tokio::test]
async fn a_dirty_worktree_refuses_removal_and_the_session_stays_in_it() {
    let rig = rig();
    let entered = run(&rig, enter("feat", "c1")).await.unwrap();
    let cwd = PathBuf::from(entered["workspace"]["cwd"].as_str().unwrap());
    std::fs::write(cwd.join("new.txt"), "wip\n").unwrap();
    let refused = run(&rig, SessionOp::Remove { session_id: None, branch: None, force: false, tx_id: "c2:remove".into() }).await;
    assert_eq!(code(&refused), Some("WORKTREE_DIRTY"));
    assert!(cwd.exists());
    let state = rig.state.lock().unwrap();
    assert_eq!(state.workspace.as_ref().unwrap()["revision"], 1);
    assert_eq!(state.workspace.as_ref().unwrap()["transition"]["state"], "idle");
}

#[tokio::test]
async fn a_cancel_after_the_folder_was_deleted_records_the_removal_instead_of_restoring_it() {
    let rig = rig();
    let entered = run(&rig, enter("feat", "c1")).await.unwrap();
    let cwd = PathBuf::from(entered["workspace"]["cwd"].as_str().unwrap());
    // At the step boundary just before the removal, the folder is deleted and the operation is
    // cancelled: the removal then fails on the cancelled token with the folder already gone.
    let cancel = CancellationToken::new();
    let (folder, token) = (cwd.clone(), cancel.clone());
    *rig.ws.inner.before_remove.lock().unwrap() = Some(Box::new(move || {
        std::fs::remove_dir_all(&folder).unwrap();
        token.cancel();
    }));
    let op = SessionOp::Remove { session_id: None, branch: None, force: false, tx_id: "c2:remove".into() };
    let result = rig.ws.run(op, "lead", &cancel).await;
    assert_eq!(code(&result), Some("WORKTREE_REMOVAL_INCOMPLETE"), "{result:?}");
    // The deletion is recorded as done: the session stays in the project folder, unbound.
    let state = rig.state.lock().unwrap();
    assert_eq!(state.cwd, rig.repo.to_string_lossy());
    assert!(!cwd.exists());
    assert_ne!(state.workspace.as_ref().unwrap()["cwd"], json!(cwd.to_string_lossy()));
}

#[tokio::test]
async fn a_byte_order_mark_is_not_a_session_id() {
    let rig = rig();
    let refused = rig.ws.gate().begin_transition("\u{feff}", "tx").err().unwrap();
    assert_eq!(thrown_message(&refused), "workspace transition requires a session id.");
}

#[tokio::test]
async fn project_branch_admission_refuses_folders_other_sessions_use() {
    let rig = rig();
    let admission = rig.ws.folder_admission(Some("lead"));
    let folders = [rig.repo.clone()];
    let admitted = admission.admit(&folders, false).await.unwrap();
    // While held, a turn in the folder waits and another holder is refused.
    assert!(rig.ws.gate().hold_checkout_folder("x", &rig.repo.to_string_lossy(), true).is_err());
    drop(admitted);
    rig.state.lock().unwrap().live = vec![LiveSession {
        id: "other".into(),
        cwd: Some(rig.repo.join("sub").to_string_lossy().into_owned()),
        active: true,
        ..LiveSession::default()
    }];
    let refused = admission.admit(&folders, false).await.err().unwrap();
    assert_eq!(refused.code(), Some("WORKTREE_BUSY_JOBS"));
    // An idle session only blocks a removal.
    rig.state.lock().unwrap().live[0].active = false;
    assert!(admission.admit(&folders, false).await.is_ok());
    assert!(admission.admit(&folders, true).await.is_err());
}

#[tokio::test]
async fn a_recovery_session_refuses_its_turn_and_a_creation_intent_provisions_at_the_first_turn() {
    let rig = rig();
    let cancel = CancellationToken::new();
    rig.ws.register_creation_intent("lead", Some("worktree"), Some("task".into())).await;
    assert_eq!(rig.ws.pending_worktree("lead"), Some(json!({"name": "task"})));
    let provisioned = rig
        .ws
        .prepare_turn_workspace("lead", TurnStart { submission_id: "sub1".into(), prompt: "fix it".into(), confirm_large: false }, &cancel)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(provisioned["workspace"]["branch"], "task");
    assert_eq!(rig.ws.pending_worktree("lead"), None);

    let recovery = restore_workspace_after_resume(rig.state.lock().unwrap().workspace.as_ref(), false);
    rig.state.lock().unwrap().workspace = recovery.workspace;
    let refused = rig.ws.prepare_turn_workspace("lead", TurnStart::default(), &cancel).await;
    assert_eq!(refused.err().and_then(|e| e.code()), Some("WORKTREE_MISSING"));
}

/// Another process (or the user) touching the project folder between the carry and its restore:
/// the first `rev-parse <ref>^1` of the restore finds an untracked file there.
struct DirtiesBeforeRestore {
    inner: Arc<dyn mixdog_core_api::domain::process::ProcessManager>,
    armed: AtomicBool,
}

#[async_trait::async_trait]
impl mixdog_core_api::domain::process::ProcessManager for DirtiesBeforeRestore {
    async fn spawn(&self, request: mixdog_core_api::domain::process::SpawnRequest) -> Result<mixdog_core_api::domain::process::SpawnedProcess, mixdog_core_api::domain::process::ProcessError> {
        if let mixdog_core_api::domain::process::CommandSpec::Argv { args, .. } = &request.command
            && args.iter().any(|a| a == "rev-parse")
            && args.last().is_some_and(|a| a.starts_with("refs/mixdog/") && a.ends_with("^1"))
            && self.armed.swap(false, Ordering::SeqCst)
        {
            std::fs::write(request.cwd.as_path().join("changed-meanwhile.txt"), "x").unwrap();
        }
        self.inner.spawn(request).await
    }
    fn subscribe(
        &self,
        handle: &mixdog_protocol::ProcessHandle,
        from_seq: Option<u64>,
    ) -> Result<Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>, mixdog_core_api::domain::process::ProcessError> {
        self.inner.subscribe(handle, from_seq)
    }
    async fn write_stdin(&self, handle: &mixdog_protocol::ProcessHandle, bytes: Vec<u8>) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        self.inner.write_stdin(handle, bytes).await
    }
    fn close_stdin(&self, handle: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        self.inner.close_stdin(handle)
    }
    fn resize_pty(&self, handle: &mixdog_protocol::ProcessHandle, size: mixdog_core_api::domain::process::PtySize) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        self.inner.resize_pty(handle, size)
    }
    fn kill(&self, handle: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        self.inner.kill(handle)
    }
    fn list(&self) -> Vec<mixdog_core_api::domain::process::ProcessInfo> {
        self.inner.list()
    }
}

/// A worktree made with the project's changes carried, whose claim then fails (the lease directory is a
/// file): returns what the undo left, with the folder that holds it (dropped, it is gone).
/// `dirty`: the project folder changes before the restore.
async fn claim_fails_after_a_carry(dirty: bool) -> (tempfile::TempDir, Result<(), ScmFailure>, Vec<Value>, String, String) {
    use super::worktree_ops::{Ops, TxScope};
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "core.autocrlf", "false"]);
    std::fs::write(repo.join("f.txt"), "a\nb\nc\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    std::fs::write(repo.join("f.txt"), "changed\n").unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let local = Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default()));
    let processes = Arc::new(DirtiesBeforeRestore { inner: local, armed: AtomicBool::new(dirty) });
    let data = dir.path().join("data");
    let worktrees = Arc::new(Worktrees::new(Scm::new(processes, tokens.maintenance_io, data.join("scratch")), data.clone()));
    let ops = Ops { wt: worktrees.clone(), settings: Arc::new(Defaults(Arc::new(AtomicBool::new(true)))), runtime_token: "rt".into() };
    let cancel = CancellationToken::new();
    let project = ops.inspect(&repo.to_string_lossy(), &cancel).await.unwrap();
    // The lease directory is a file: creation (no runtime token) succeeds, the claim cannot write its lease.
    let root = mixdog_scm::worktree::names::managed_root(&data, &project.common_dir);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(".owners"), "in the way").unwrap();
    let result = ops
        .create_for_session(&project, TxScope { session: "s1", tx_id: "tx1" }, "feat", Some("carry"), false, &cancel)
        .await
        .map(drop);
    let rows = worktrees.list(None, &KeepAll, &cancel).await.unwrap();
    let carry_refs = git(&repo, &["for-each-ref", "refs/mixdog/carry"]);
    let folder = std::fs::read_to_string(repo.join("f.txt")).unwrap();
    (dir, result, rows, carry_refs, folder)
}

/// Node's undo (`transition-steps.mjs:294-300`) restores the carried changes, then removes the worktree,
/// then drops the recovery ref.
#[tokio::test]
async fn a_failed_claim_puts_the_carried_changes_back_then_removes_the_worktree_then_drops_the_ref() {
    let (_dir, result, rows, carry_refs, folder) = claim_fails_after_a_carry(false).await;
    assert!(result.is_err(), "the claim's failure is the one surfaced");
    assert_eq!(folder, "changed\n", "the carried changes are back in the project folder");
    assert!(rows.is_empty(), "the worktree is gone");
    assert_eq!(carry_refs, "", "and the recovery ref is dropped");
}

/// A restore that is refused stops the undo there: the worktree and the recovery ref stay (before this the
/// worktree was removed first, so nothing but the ref held the carried changes).
#[tokio::test]
async fn a_refused_restore_keeps_the_worktree_and_the_recovery_ref() {
    let (_dir, result, rows, carry_refs, _folder) = claim_fails_after_a_carry(true).await;
    assert!(result.is_err());
    assert_eq!(rows.len(), 1, "the worktree that holds the carried changes stays");
    assert!(std::path::Path::new(rows[0]["path"].as_str().unwrap()).exists());
    assert!(carry_refs.contains("refs/mixdog/carry"), "{carry_refs}");
}

/// The agent tool's spawn admission is this runtime's gate: a spawn for a Lead whose workspace is
/// changing is refused with Node's thrown text, one after it settles is held, and a worktree-bound
/// Lead's root is the workers' lock.
#[test]
fn the_spawn_admission_is_the_workspace_gate() {
    use mixdog_agent::agent_tool::flow::world::SpawnAdmission;
    let rig = rig();
    let owners = ["lead".to_owned(), "worker".to_owned()];
    let transition = rig.ws.gate().begin_transition("lead", "tx").unwrap();
    let refused = rig.ws.enter_worker_spawn(&owners).err();
    assert_eq!(refused.as_deref(), Some("The Lead workspace is changing; spawn the worker after it settles."));
    drop(transition);
    let held = rig.ws.enter_worker_spawn(&owners).expect("admitted once the transition left");
    assert!(rig.ws.gate().begin_transition("lead", "tx2").is_err(), "no transition while the spawn is held");
    drop(held);
    assert_eq!(rig.ws.workspace_cwd_lock(&owners), None);
    rig.ws.gate().set_workspace_cwd_lock("lead", Some("/wt"));
    assert_eq!(rig.ws.workspace_cwd_lock(&owners).as_deref(), Some("/wt"));
}
