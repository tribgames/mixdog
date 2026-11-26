//! The workspace transitions against real temporary git repositories: the registry, git and
//! the managed store are the real ones; only the session runtime is a scripted host.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "tests drive git and the disk directly")]
// Compiled into a test-support build too (its helpers serve mixdog-core-session-replays); its tests run only in the library's own test build.
#![cfg_attr(not(test), allow(dead_code, unused_imports))]

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

pub fn git(cwd: &Path, args: &[&str]) -> String {
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

/// A directory link: a junction on Windows (it needs no privilege), a symlink elsewhere.
pub fn link_dir(target: &Path, link: &Path) {
    #[cfg(windows)]
    assert!(std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().unwrap().status.success());
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(target, link).unwrap();
}

/// `dir/repo`: a repository on `main` whose one commit holds `f.txt`.
pub fn repo_with_one_commit(dir: &Path) -> PathBuf {
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "core.autocrlf", "false"]);
    std::fs::write(repo.join("f.txt"), "a\nb\nc\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    repo
}

pub fn enter(name: &str, call: &str) -> SessionOp {
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

fn code(result: &Result<Value, ScmFailure>) -> Option<&'static str> {
    result.as_ref().err().and_then(ScmFailure::code)
}

/// Another process (or the user) touching the project folder between the carry and its restore:
/// the first `rev-parse <ref>^1` of the restore finds an untracked file there.
struct DirtiesBeforeRestore {
    inner: Arc<dyn mixdog_core_api::domain::process::ProcessManager>,
    armed: AtomicBool,
}

#[async_trait::async_trait]
impl mixdog_core_api::domain::process::ProcessManager for DirtiesBeforeRestore {
    async fn spawn(
        &self,
        request: mixdog_core_api::domain::process::SpawnRequest,
    ) -> Result<mixdog_core_api::domain::process::SpawnedProcess, mixdog_core_api::domain::process::ProcessError> {
        if let mixdog_core_api::domain::process::CommandSpec::Argv { args, .. } = &request.command
            && args.iter().any(|a| a == "rev-parse")
            && args.last().is_some_and(|a| a.starts_with("refs/mixdog/") && a.ends_with("^1"))
            && self.armed.swap(false, Ordering::SeqCst)
        {
            std::fs::write(request.cwd.as_path().join("changed-meanwhile.txt"), "x").unwrap();
        }
        self.inner.spawn(request).await
    }
    fn subscribe_holding(
        &self,
        handle: &mixdog_protocol::ProcessHandle,
        from_seq: Option<u64>,
    ) -> Result<
        Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>,
        mixdog_core_api::domain::process::ProcessError,
    > {
        self.inner.subscribe_holding(handle, from_seq)
    }
    fn subscribe(
        &self,
        handle: &mixdog_protocol::ProcessHandle,
        from_seq: Option<u64>,
    ) -> Result<
        Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>,
        mixdog_core_api::domain::process::ProcessError,
    > {
        self.inner.subscribe(handle, from_seq)
    }
    async fn write_stdin(&self, handle: &mixdog_protocol::ProcessHandle, bytes: Vec<u8>) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        self.inner.write_stdin(handle, bytes).await
    }
    fn close_stdin(&self, handle: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        self.inner.close_stdin(handle)
    }
    fn resize_pty(
        &self,
        handle: &mixdog_protocol::ProcessHandle,
        size: mixdog_core_api::domain::process::PtySize,
    ) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        self.inner.resize_pty(handle, size)
    }
    fn kill(&self, handle: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
        self.inner.kill(handle)
    }
    fn list(&self) -> Vec<mixdog_core_api::domain::process::ProcessInfo> {
        self.inner.list()
    }
}

fn busy_reason(result: &Result<Value, ScmFailure>) -> String {
    match result.as_ref().err().and_then(ScmFailure::detail) {
        Some(mixdog_protocol::DomainErrorDetail::WorktreeBusyJobs { reason, .. }) => reason.clone(),
        other => panic!("not a busy refusal: {other:?}"),
    }
}

struct Stuck;

/// Settings whose size threshold every checkout is over.
struct OverThreshold;

#[async_trait]
impl SettingsSource for OverThreshold {
    async fn worktree_settings(&self) -> WorktreeSettings {
        WorktreeSettings { size_warn_bytes: 1, ..WorktreeSettings::default() }
    }
}

#[derive(Default)]
pub struct HostState {
    pub workspace: Option<Value>,
    pub cwd: String,
    pub turn_running: bool,
    pub fail_apply: bool,
    pub live: Vec<LiveSession>,
    pub shell_jobs: u64,
    /// A schedule, webhook, routine or room run: it may only list worktrees.
    pub unattended: bool,
    /// The desktop classification a Project switch stored.
    pub desktop: Option<Value>,
    /// The sessions `ensure_session` was asked to create, in order.
    pub ensured: Vec<String>,
    /// The running background shells owned by the sessions a folder check names.
    pub sharing_shell_jobs: u64,
    /// The workers moved with the Lead, as `(worker, cwd)`.
    pub retargeted: Vec<(String, String)>,
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
        })
    }

    async fn has_conversation(&self, _session_id: &str) -> Result<bool, ScmFailure> {
        Ok(false)
    }

    async fn ensure_session(&self, session_id: &str) -> Result<(), ScmFailure> {
        self.state.lock().unwrap().ensured.push(session_id.to_owned());
        Ok(())
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
        self.state.lock().unwrap().sharing_shell_jobs
    }

    async fn retarget_worker(&self, worker_id: &str, cwd: &str, _moved: Option<Move>) -> Result<Undo, ScmFailure> {
        self.state.lock().unwrap().retargeted.push((worker_id.to_owned(), cwd.to_owned()));
        Ok(undo(async { Ok(()) }))
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
pub struct Rig {
    pub _dir: tempfile::TempDir,
    pub repo: PathBuf,
    pub data: PathBuf,
    pub state: Arc<Mutex<HostState>>,
    pub auto_cleanup: Arc<AtomicBool>,
    pub ws: SessionWorkspaces,
    pub worktrees: Arc<Worktrees>,
}
/// The processes the daemon spawns.
fn local_processes() -> Arc<LocalProcessManager> {
    Arc::new(LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default()))
}
/// The managed store kept in `data`, whose git runs through `processes`.
fn store(processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager>, data: &Path) -> Worktrees {
    Worktrees::new(Scm::new(processes, mixdog_rt::testing::tokens().maintenance_io, data.join("scratch")), data.to_path_buf())
}
/// A temporary folder at its real path: the store keeps the real path of a checkout, and a test names it through its own.
pub fn real_tempdir() -> tempfile::TempDir {
    tempfile::Builder::new().tempdir_in(mixdog_workspace::pathguard::canonical(&std::env::temp_dir()).unwrap()).unwrap()
}
pub fn rig() -> Rig {
    rig_over(|worktrees| worktrees)
}
/// [`rig`] over a managed store that `shape` has changed (a host cleanup added).
fn rig_over(shape: impl FnOnce(Worktrees) -> Worktrees) -> Rig {
    let dir = real_tempdir();
    let repo = repo_with_one_commit(dir.path());
    let data = dir.path().join("data");
    let worktrees = Arc::new(shape(store(local_processes(), &data)));
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
    Rig { _dir: dir, repo, data, state, auto_cleanup, ws, worktrees }
}
pub async fn run(rig: &Rig, op: SessionOp) -> Result<Value, ScmFailure> {
    rig.ws.run(op, "lead", &CancellationToken::new()).await
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
    assert_eq!(rig.state.lock().unwrap().cwd.replace('\\', "/"), rig.repo.to_string_lossy().replace('\\', "/"));
    assert_eq!(rig.ws.gate().workspace_cwd_lock(&["lead"]), None);
    let again = run(&rig, SessionOp::Return { session_id: None, tx_id: "c3b:return".into() }).await.unwrap();
    assert_eq!(again["unchanged"], true);

    let removed = run(&rig, SessionOp::Remove { session_id: None, branch: None, force: false, tx_id: "c4:remove".into() }).await.unwrap();
    assert_eq!(removed["removed"]["removed"], true);
    assert!(!cwd.exists());
    let rows = rig.worktrees.list(None, &KeepAll, &CancellationToken::new()).await.unwrap();
    assert!(rows.is_empty());
}
/// A list read while the favorite and archive marks are unavailable does not decide what they would say: the row carries no
/// `ownerArchived` (not `false`) and no `cleanupReason` (not `null`), both optional in `DesktopManagedWorktreeRow`.
#[tokio::test]
async fn a_row_listed_while_the_marks_are_unavailable_carries_no_archive_state_or_cleanup_reason() {
    let rig = rig();
    run(&rig, enter("feat", "u1")).await.unwrap();
    rig.auto_cleanup.store(true, Ordering::SeqCst);
    let sessions: Arc<dyn SessionSource> = Arc::new(StoresLead);
    let rows = rig.worktrees.list_with_retention(&sessions, &Default::default(), true, 0, &CancellationToken::new()).await.unwrap();
    assert_eq!(rows.len(), 1);
    for key in ["ownerArchived", "cleanupReason"] {
        assert!(rows[0].get(key).is_none(), "{key} is absent when the marks could not be read: {}", rows[0]);
    }
    assert!(rows[0].get("ownerTitle").is_some(), "what could be read is still there");
}
#[tokio::test]
async fn a_stale_revision_and_a_running_turn_refuse_and_leave_the_session_alone() {
    let rig = rig();
    let cancel = CancellationToken::new();
    let stale = rig.ws.select_branch("lead", SelectBranch { branch: "x".into(), expected_revision: Some(5), ..SelectBranch::default() }, true, &cancel).await;
    assert_eq!(stale.err().and_then(|e| e.code()), Some("WORKTREE_REVISION_CONFLICT"));

    rig.state.lock().unwrap().turn_running = true;
    let busy = rig.ws.select_branch("lead", SelectBranch { branch: "x".into(), create: true, ..SelectBranch::default() }, false, &cancel).await;
    assert_eq!(busy.err().and_then(|e| e.code()), Some("WORKTREE_BUSY_JOBS"));
    // The in-flight marker is gone and nothing was created.
    assert!(rig.state.lock().unwrap().workspace.is_none());
    assert!(git(&rig.repo, &["branch", "--list", "x"]).is_empty());
    // The Lead's own tool call tolerates its calling turn.
    let own = rig.ws.select_branch("lead", SelectBranch { branch: "x".into(), create: true, ..SelectBranch::default() }, true, &cancel).await.unwrap();
    assert_eq!(own["workspace"]["branch"], "x");
    assert!(own["workspace"]["worktreeId"].is_string());
}
/// `ensureSession` (`session-view.mjs`): `selectBranch` and a `requestWorktree` that provisions create the runtime's session
/// before acting on it; a `requestWorktree` that only arms the intent for the next message does not.
#[tokio::test]
async fn only_select_branch_and_a_provisioning_request_create_the_session() {
    let rig = rig();
    let cancel = CancellationToken::new();
    let ensured = || rig.state.lock().unwrap().ensured.clone();
    rig.ws.request_worktree("lead", RequestWorktree::default(), false, &cancel).await.unwrap();
    assert!(ensured().is_empty(), "arming the intent creates no session");
    let select = SelectBranch { branch: "x".into(), create: true, tx_id: "t1".into(), ..SelectBranch::default() };
    rig.ws.select_branch("lead", select, false, &cancel).await.unwrap();
    assert_eq!(ensured(), ["lead"]);
    rig.ws.request_worktree("lead", RequestWorktree { provision: true, ..RequestWorktree::default() }, false, &cancel).await.unwrap();
    assert_eq!(ensured(), ["lead", "lead"]);
}
#[tokio::test]
async fn uncommitted_changes_must_be_decided_before_a_worktree_is_made() {
    let rig = rig();
    // The untracked identity marker a registered project carries is not a change (counted below).
    std::fs::create_dir_all(rig.repo.join(".mixdog")).unwrap();
    std::fs::write(rig.repo.join(".mixdog").join("project.id"), "repo\n").unwrap();
    std::fs::write(rig.repo.join("f.txt"), "changed\n").unwrap();
    let asked = run(&rig, enter("feat", "c1")).await;
    assert_eq!(code(&asked), Some("WORKTREE_DIRTY_CHOICE"));
    assert!(rig.worktrees.list(None, &KeepAll, &CancellationToken::new()).await.unwrap().is_empty());
    let SessionOp::Enter { session_id, name, branch, create, confirm_large, tx_id, .. } = enter("feat", "c2") else { unreachable!() };
    let left = run(&rig, SessionOp::Enter { session_id, name, branch, create, carry: Some("leave".into()), confirm_large, tx_id }).await.unwrap();
    assert_eq!(left["changes"], json!({"mode": "left", "count": 1}));
    assert_eq!(std::fs::read_to_string(rig.repo.join("f.txt")).unwrap(), "changed\n");
    let carry = run(
        &rig,
        SessionOp::Enter {
            session_id: None,
            name: Some("other".into()),
            branch: None,
            create: false,
            carry: Some("carry".into()),
            confirm_large: false,
            tx_id: "c3:enter".into(),
        },
    )
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
    rig.state.lock().unwrap().live =
        vec![LiveSession { id: "other".into(), cwd: Some(rig.repo.join("sub").to_string_lossy().into_owned()), active: true, ..LiveSession::default() }];
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
/// A worktree made with the project's changes carried, whose claim then fails (the lease directory is a
/// file): returns what the undo left, with the folder that holds it (dropped, it is gone).
/// `dirty`: the project folder changes before the restore.
async fn claim_fails_after_a_carry(dirty: bool) -> (tempfile::TempDir, Result<(), ScmFailure>, Vec<Value>, String, String) {
    use super::worktree_ops::{Ops, TxScope};
    let dir = real_tempdir();
    let repo = repo_with_one_commit(dir.path());
    std::fs::write(repo.join("f.txt"), "changed\n").unwrap();
    let processes = Arc::new(DirtiesBeforeRestore { inner: local_processes(), armed: AtomicBool::new(dirty) });
    let data = dir.path().join("data");
    let worktrees = Arc::new(store(processes, &data));
    let ops = Ops { wt: worktrees.clone(), settings: Arc::new(Defaults(Arc::new(AtomicBool::new(true)))), runtime_token: "rt".into() };
    let cancel = CancellationToken::new();
    let project = ops.inspect(&repo.to_string_lossy(), &cancel).await.unwrap();
    // The lease directory is a file: creation (no runtime token) succeeds, the claim cannot write its lease.
    let root = mixdog_scm::worktree::names::managed_root(&data, &project.common_dir);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(".owners"), "in the way").unwrap();
    let result = ops.create_for_session(&project, TxScope { session: "s1", tx_id: "tx1" }, "feat", Some("carry"), false, &cancel).await.map(drop);
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
/// A carry clears the project folder, so another session working in it (a running turn, or a background shell) refuses it before
/// anything moves (`withProjectFolder` + `assertCheckoutQuiet`); once the folder is quiet the carry goes through.
#[tokio::test]
async fn a_carry_refuses_while_another_session_works_in_the_project_folder() {
    let rig = rig();
    std::fs::write(rig.repo.join("f.txt"), "changed\n").unwrap();
    let carry = |call: &str| SessionOp::Enter {
        session_id: None,
        name: Some("feat".into()),
        branch: None,
        create: false,
        carry: Some("carry".into()),
        confirm_large: false,
        tx_id: format!("{call}:enter"),
    };
    let other = |active: bool| vec![LiveSession { id: "other".into(), cwd: Some(rig.repo.to_string_lossy().into_owned()), active, ..LiveSession::default() }];
    rig.state.lock().unwrap().live = other(true);
    assert_eq!(busy_reason(&run(&rig, carry("c1")).await), "folder-in-use");
    {
        let mut state = rig.state.lock().unwrap();
        state.live = other(false);
        state.sharing_shell_jobs = 1;
    }
    assert_eq!(busy_reason(&run(&rig, carry("c2")).await), "folder-shell-jobs");
    assert!(rig.worktrees.list(None, &KeepAll, &CancellationToken::new()).await.unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(rig.repo.join("f.txt")).unwrap(), "changed\n", "nothing moved");
    rig.state.lock().unwrap().sharing_shell_jobs = 0;
    let carried = run(&rig, carry("c3")).await.unwrap();
    assert_eq!(carried["changes"]["mode"], "carried");
    assert_eq!(std::fs::read_to_string(rig.repo.join("f.txt")).unwrap(), "a\nb\nc\n");
}
/// `retargetWorkers`: the Lead's open workers move into the worktree with it (not a closed one, nor another session's).
#[tokio::test]
async fn the_leads_workers_move_with_it_into_the_worktree() {
    let rig = rig();
    let repo = rig.repo.to_string_lossy().into_owned();
    let session = |id: &str| LiveSession { id: id.into(), cwd: Some(repo.clone()), ..LiveSession::default() };
    let agent = Some("agent".to_owned());
    rig.state.lock().unwrap().live = vec![
        LiveSession { owner_session_id: Some("lead".into()), owner: agent.clone(), ..session("w1") },
        LiveSession { parent_session_id: Some("lead".into()), closed: true, owner: agent, ..session("w2") },
        LiveSession { owner_session_id: Some("lead".into()), ..session("not-a-worker") },
        session("elsewhere"),
    ];
    let entered = run(&rig, enter("feat", "c1")).await.unwrap();
    let cwd = entered["workspace"]["cwd"].as_str().unwrap().to_owned();
    assert_eq!(rig.state.lock().unwrap().retargeted, [("w1".to_owned(), cwd)]);
}
/// Removing another session's orphan worktree reads its retention again (`removeOrphanedWorktree`): a session the store
/// still keeps protects it.
#[tokio::test]
async fn removing_an_orphan_worktree_still_honours_the_sessions_the_store_keeps() {
    let rig = rig();
    let cancel = CancellationToken::new();
    let entered = run(&rig, enter("feat", "c1")).await.unwrap();
    let cwd = PathBuf::from(entered["workspace"]["cwd"].as_str().unwrap());
    run(&rig, SessionOp::Return { session_id: None, tx_id: "c2:return".into() }).await.unwrap();
    let row = rig.ws.inner.list_rows(&cancel).await.unwrap().remove(0);
    let refused = rig.ws.inner.remove_orphan(&row, false, &cancel).await;
    assert_eq!(busy_reason(&refused), "workspace-retained");
    assert!(cwd.exists());
}
#[async_trait]
impl mixdog_scm::worktree::removal::RootCleanup for Stuck {
    fn name(&self) -> &str {
        "terminal"
    }

    async fn run(&self, _root: &Path, _entry_id: &str) -> Result<(), String> {
        Err("still open".into())
    }
}
/// A removal that ends partly removed reports what is left and whether to retry (`remaining`, `retryable`).
#[tokio::test]
async fn a_partly_removed_worktree_reports_what_is_left() {
    let rig = rig_over(|worktrees| worktrees.with_root_cleanup(Arc::new(Stuck)));
    run(&rig, enter("feat", "c1")).await.unwrap();
    run(&rig, SessionOp::Return { session_id: None, tx_id: "c2:return".into() }).await.unwrap();
    let failure = run(&rig, SessionOp::Remove { session_id: None, branch: None, force: false, tx_id: "c3:remove".into() }).await.unwrap_err();
    assert_eq!(failure.code(), Some("WORKTREE_REMOVAL_INCOMPLETE"));
    let Some(mixdog_protocol::DomainErrorDetail::WorktreeRemovalIncomplete { remaining, retryable, .. }) = failure.detail() else { panic!("{failure:?}") };
    assert!(*retryable);
    assert_eq!(remaining.len(), 1);
    assert_eq!((remaining[0].kind.as_str(), remaining[0].name.as_deref(), remaining[0].error.as_deref()), ("cleanup", Some("terminal"), Some("still open")));
}
/// A repository with one commit, and the session layer's worktree operations over a fresh managed store whose settings (the
/// store's own and the session layer's) are `settings`: returns the folder that holds both, the repository and the operations.
fn ops_over_a_fresh_store(settings: Arc<dyn SettingsSource>) -> (tempfile::TempDir, PathBuf, super::worktree_ops::Ops) {
    let dir = real_tempdir();
    let repo = repo_with_one_commit(dir.path());
    let worktrees = store(local_processes(), &dir.path().join("data")).with_settings(settings.clone());
    let ops = super::worktree_ops::Ops { wt: Arc::new(worktrees), settings, runtime_token: "rt".into() };
    (dir, repo, ops)
}
/// A managed worktree is found by its checkout spelled through a link (a junction on Windows), at it or inside it: Node's
/// `getWorktreeByPath` and `findWorktreeContaining` compare canonical paths (`pathKey`), and the records hold real ones.
#[tokio::test]
async fn a_worktree_is_found_by_its_checkout_spelled_through_a_link() {
    use super::worktree_ops::TxScope;
    let (dir, repo, ops) = ops_over_a_fresh_store(Arc::new(Defaults(Arc::new(AtomicBool::new(true)))));
    let cancel = CancellationToken::new();
    let project = ops.inspect(&repo.to_string_lossy(), &cancel).await.unwrap();
    let made = ops.create_for_session(&project, TxScope { session: "s1", tx_id: "tx1" }, "feat", None, false, &cancel).await.unwrap().record;
    let linked = dir.path().join("linked");
    link_dir(Path::new(&made.path), &linked);
    let at = linked.to_string_lossy().into_owned();
    let inside = linked.join("sub").to_string_lossy().into_owned();
    assert_eq!(ops.worktree_by_path(&at, &cancel).await.unwrap().map(|r| r.id), Some(made.id.clone()), "the checkout through the link");
    assert_eq!(ops.worktree_containing(&inside, &cancel).await.unwrap().map(|r| r.id), Some(made.id.clone()), "a folder in it through the link");
    assert!(ops.worktree_containing(&repo.to_string_lossy(), &cancel).await.unwrap().is_none(), "the project folder is no managed worktree");
    assert!(ops.worktree_by_path(" ", &cancel).await.unwrap().is_none(), "a blank path names no worktree (`getWorktreeByPath('')`)");
}
/// A checkout over the size threshold is refused until the user confirmed it, and made once they did, whether the session asks
/// for a new worktree or for a branch's (`createManagedWorktree`'s `confirmLarge`): the store's own check hears the confirmation
/// too.
#[tokio::test]
async fn a_confirmed_large_checkout_is_made() {
    use super::worktree_ops::TxScope;
    let (_dir, repo, ops) = ops_over_a_fresh_store(Arc::new(OverThreshold));
    let cancel = CancellationToken::new();
    let project = ops.inspect(&repo.to_string_lossy(), &cancel).await.unwrap();
    let scope = TxScope { session: "s1", tx_id: "tx1" };
    let refused = ops.create_for_session(&project, scope, "feat", None, false, &cancel).await.err().expect("refused unconfirmed");
    assert_eq!(refused.code(), Some(mixdog_scm::worktree::errors::WORKTREE_LARGE_REPO_CONFIRM));
    assert!(ops.create_for_session(&project, scope, "feat", None, true, &cancel).await.is_ok(), "made once confirmed");
    let branch = TxScope { session: "s1", tx_id: "tx2" };
    let resolved = ops.resolve_branch(&repo.to_string_lossy(), "side", true, None, branch, true, &cancel).await;
    assert!(resolved.is_ok_and(|resolved| resolved.entry.is_some()), "a new branch's worktree made once confirmed");
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

#[cfg(test)]
mod raw_git_worktree_guards {
    use std::collections::HashSet;

    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_core_api::domain::mock::MockApprovalGate;
    use mixdog_core_api::domain::mock::MockFileService;
    use mixdog_core_api::domain::mock::MockProgress;
    use mixdog_core_api::domain::tool::SurfaceKind;
    use mixdog_core_api::domain::tool::Tool;
    use mixdog_core_api::domain::tool::ToolContext;
    use mixdog_core_api::domain::tool::ToolIo;
    use mixdog_core_api::domain::tool::ToolPart;
    use mixdog_protocol::ThreadId;
    use mixdog_protocol::ToolCallId;
    use mixdog_protocol::TurnId;
    use mixdog_tools::git::GitTool;
    use mixdog_tools::git::WorktreeServices;

    use super::*;

    struct MultiSessionState {
        sessions: HashMap<String, HostState>,
    }

    struct MultiSessionHost {
        state: Arc<Mutex<MultiSessionState>>,
    }

    #[async_trait]
    impl WorkspaceHost for MultiSessionHost {
        async fn is_lead(&self, session_id: &str) -> bool {
            self.state.lock().unwrap().sessions.contains_key(session_id)
        }

        async fn attended(&self, session_id: &str) -> bool {
            self.state.lock().unwrap().sessions.get(session_id).is_some_and(|s| !s.unattended)
        }

        fn session(&self, session_id: &str) -> Option<SessionView> {
            let state = self.state.lock().unwrap();
            state.sessions.get(session_id).map(|s| SessionView {
                cwd: Some(s.cwd.clone()),
                runtime_cwd: s.cwd.clone(),
                workspace: s.workspace.clone(),
                desktop_project: None,
            })
        }

        async fn has_conversation(&self, _session_id: &str) -> Result<bool, ScmFailure> {
            Ok(false)
        }

        async fn ensure_session(&self, _session_id: &str) -> Result<(), ScmFailure> {
            Ok(())
        }

        fn set_workspace(&self, session_id: &str, workspace: Option<Value>) {
            if let Some(s) = self.state.lock().unwrap().sessions.get_mut(session_id) {
                s.workspace = workspace;
            }
        }

        async fn activity(&self, session_id: &str) -> LeadActivity {
            self.state
                .lock()
                .unwrap()
                .sessions
                .get(session_id)
                .map(|s| LeadActivity { turn_running: s.turn_running, shell_jobs: s.shell_jobs, ..LeadActivity::default() })
                .unwrap_or_default()
        }

        fn live_sessions(&self) -> Vec<LiveSession> {
            self.state
                .lock()
                .unwrap()
                .sessions
                .iter()
                .map(|(id, s)| LiveSession { id: id.clone(), cwd: Some(s.cwd.clone()), active: s.turn_running, ..LiveSession::default() })
                .collect()
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

        async fn retarget_worker(&self, _worker_id: &str, _cwd: &str, _moved: Option<Move>) -> Result<Undo, ScmFailure> {
            Ok(undo(async { Ok(()) }))
        }

        async fn apply(&self, session_id: &str, change: WorkspaceChange) -> Result<Undo, ScmFailure> {
            let mut state = self.state.lock().unwrap();
            let s = state.sessions.get_mut(session_id).ok_or_else(|| plain(format!("missing session {session_id}")))?;
            let prior = (s.cwd.clone(), s.workspace.clone());
            s.cwd = change.cwd;
            s.workspace = Some(change.workspace);
            let shared = self.state.clone();
            let id = session_id.to_owned();
            Ok(undo(async move {
                if let Some(s) = shared.lock().unwrap().sessions.get_mut(&id) {
                    (s.cwd, s.workspace) = prior;
                }
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

    struct MultiStores(Vec<String>);

    #[async_trait]
    impl SessionSource for MultiStores {
        async fn stored_session_ids(&self) -> Result<HashSet<String>, ScmFailure> {
            Ok(self.0.iter().cloned().collect())
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

    struct MultiRig {
        _dir: tempfile::TempDir,
        repo: PathBuf,
        state: Arc<Mutex<MultiSessionState>>,
        worktrees: Arc<Worktrees>,
        tool: GitTool,
        processes: Arc<LocalProcessManager>,
    }

    fn multi_rig(names: &[&str]) -> MultiRig {
        let dir = real_tempdir();
        let repo = repo_with_one_commit(dir.path());
        let data = dir.path().join("data");
        let processes = local_processes();
        let worktrees = Arc::new(store(processes.clone(), &data));
        let mut sessions = HashMap::new();
        for name in names {
            sessions.insert((*name).to_owned(), HostState { cwd: repo.to_string_lossy().into_owned(), ..HostState::default() });
        }
        let state = Arc::new(Mutex::new(MultiSessionState { sessions }));
        let stored: Arc<dyn SessionSource> = Arc::new(MultiStores(names.iter().map(|s| (*s).to_owned()).collect()));
        let live_names: HashSet<String> = names.iter().map(|s| (*s).to_owned()).collect();
        let live: LiveSessions = Arc::new(move || live_names.clone());
        let ws = SessionWorkspaces::new(
            worktrees.clone(),
            stored.clone(),
            live.clone(),
            Arc::new(Defaults(Arc::new(AtomicBool::new(true)))),
            Arc::new(MultiSessionHost { state: state.clone() }),
            AdmissionGate::new(),
        );
        let services = Arc::new(WorktreeServices { worktrees: worktrees.clone(), stored, live, sessions: Arc::new(ws) });
        MultiRig { _dir: dir, repo, state, worktrees, tool: GitTool::new().with_worktrees(services), processes }
    }

    async fn call_git(rig: &MultiRig, session: &str, cwd: &Path, call: &str, input: Value) -> String {
        let tokens = mixdog_rt::testing::tokens();
        let ctx = ToolContext {
            call_id: ToolCallId::from(call),
            thread_id: ThreadId::from(session),
            turn_id: TurnId::from("turn-1"),
            tool: "git".into(),
            cwd: AbsPath::new(cwd).unwrap(),
            surface: SurfaceKind::Lead,
            cancel: CancellationToken::new(),
            deadline: None,
            progress: Arc::new(MockProgress::default()),
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            approvals: Arc::new(MockApprovalGate::default()),
            files: Arc::new(MockFileService::default()),
            processes: rig.processes.clone(),
            options: Default::default(),
            review: None,
        };
        match rig.tool.call(&ctx, input).await.expect("git tool returns text").parts.first() {
            Some(ToolPart::Text(text)) => text.clone(),
            other => panic!("not text: {other:?}"),
        }
    }

    fn parse(text: &str) -> Value {
        serde_json::from_str(text).unwrap_or_else(|e| panic!("not JSON ({e}): {text}"))
    }

    #[tokio::test]
    async fn raw_worktree_remove_returns_bound_session_to_project_first() {
        let rig = multi_rig(&["lead"]);
        let entered = parse(&call_git(&rig, "lead", &rig.repo, "c1", json!({"action": "worktree", "worktree_action": "enter", "name": "feat"})).await);
        assert_eq!(entered["ok"], true, "{entered}");
        let wt = PathBuf::from(entered["workspace"]["cwd"].as_str().unwrap());
        assert!(wt.exists());

        // Dirty without -f refuses and keeps the session inside its worktree.
        std::fs::write(wt.join("dirty.txt"), "wip\n").unwrap();
        let refused = parse(&call_git(&rig, "lead", &wt, "c2", json!({"command": format!("git worktree remove {}", wt.display())})).await);
        assert_eq!((&refused["ok"], &refused["code"]), (&json!(false), &json!("WORKTREE_DIRTY")));
        assert!(same_path(&rig.state.lock().unwrap().sessions["lead"].cwd, &wt.to_string_lossy()));
        assert!(wt.exists());

        // With -f, the session returns to its project folder first and the worktree is removed.
        let removed = parse(&call_git(&rig, "lead", &wt, "c3", json!({"command": format!("git worktree remove -f {}", wt.display())})).await);
        assert_eq!(removed["ok"], true, "{removed}");
        assert_eq!(removed["removed"]["removed"], true, "{removed}");
        assert!(same_path(removed["workspace"]["cwd"].as_str().unwrap(), &rig.repo.to_string_lossy()));
        assert_eq!(removed["workspace"]["worktreeId"], Value::Null);
        assert!(same_path(&rig.state.lock().unwrap().sessions["lead"].cwd, &rig.repo.to_string_lossy()));
        assert!(!wt.exists());
    }

    #[tokio::test]
    async fn raw_worktree_remove_guards_other_sessions_busy_and_non_current_worktrees() {
        let rig = multi_rig(&["lead", "other"]);
        let entered = parse(&call_git(&rig, "other", &rig.repo, "c1", json!({"action": "worktree", "worktree_action": "enter", "name": "active"})).await);
        assert_eq!(entered["ok"], true, "{entered}");
        let wt_active = PathBuf::from(entered["workspace"]["cwd"].as_str().unwrap());

        let extra = parse(&call_git(&rig, "other", &rig.repo, "c2", json!({"command": "git worktree add -b extra ../extra"})).await);
        assert_eq!(extra["ok"], true, "{extra}");
        let wt_extra = PathBuf::from(extra["path"].as_str().unwrap());

        // While "other" is busy, "lead" cannot remove its current worktree.
        rig.state.lock().unwrap().sessions.get_mut("other").unwrap().turn_running = true;
        let busy = parse(&call_git(&rig, "lead", &rig.repo, "c3", json!({"command": format!("git worktree remove {}", wt_active.display())})).await);
        assert_eq!((&busy["ok"], &busy["code"]), (&json!(false), &json!("WORKTREE_BUSY_JOBS")));
        assert_eq!(busy["details"]["reason"], "turn");
        assert!(wt_active.exists());

        // Removing a retained worktree that is not "other"'s current one is refused ("enter it first").
        let non_current = call_git(&rig, "lead", &rig.repo, "c4", json!({"command": format!("git worktree remove {}", wt_extra.display())})).await;
        assert!(
            non_current.contains("is not the current worktree of session other; enter it (worktree_action enter, branch extra) first, then remove it"),
            "{non_current}"
        );
        assert!(wt_extra.exists());

        // Once "other" is idle, removing its current worktree returns "other" to its project folder first.
        rig.state.lock().unwrap().sessions.get_mut("other").unwrap().turn_running = false;
        let removed = parse(&call_git(&rig, "lead", &rig.repo, "c5", json!({"command": format!("git worktree remove {}", wt_active.display())})).await);
        assert_eq!(removed["ok"], true, "{removed}");
        assert!(same_path(&rig.state.lock().unwrap().sessions["other"].cwd, &rig.repo.to_string_lossy()));
        assert!(!wt_active.exists());
    }

    #[tokio::test]
    async fn raw_worktree_add_and_lead_snapshot_resolve_session_project_and_branch_occupancy() {
        let rig = multi_rig(&["lead", "other"]);
        let other_dir = real_tempdir();
        let other_repo = repo_with_one_commit(other_dir.path());

        // Another repository is refused as a project mismatch for both branch add and Lead --detach snapshot.
        let mismatch_add = parse(&call_git(&rig, "lead", &other_repo, "c1", json!({"command": "git worktree add -b foreign ../w"})).await);
        assert_eq!((&mismatch_add["ok"], &mismatch_add["code"]), (&json!(false), &json!("WORKTREE_PROJECT_MISMATCH")));
        let mismatch_snap = parse(&call_git(&rig, "lead", &other_repo, "c2", json!({"command": "git worktree add --detach ../s"})).await);
        assert_eq!((&mismatch_snap["ok"], &mismatch_snap["code"]), (&json!(false), &json!("WORKTREE_PROJECT_MISMATCH")));

        // Branch checked out in the project folder is refused as occupied.
        let main_occupied = parse(&call_git(&rig, "lead", &rig.repo, "c3", json!({"command": "git worktree add ../w main"})).await);
        assert_eq!((&main_occupied["ok"], &main_occupied["code"]), (&json!(false), &json!("WORKTREE_BRANCH_OCCUPIED")));
        assert_eq!(main_occupied["details"]["kind"], "current");

        // Branch checked out in another session's worktree is refused as occupied.
        let other_added = parse(&call_git(&rig, "other", &rig.repo, "c4", json!({"command": "git worktree add -b theirs ../t"})).await);
        assert_eq!(other_added["ok"], true, "{other_added}");
        let theirs_occupied = parse(&call_git(&rig, "lead", &rig.repo, "c5", json!({"command": "git worktree add ../w theirs"})).await);
        assert_eq!((&theirs_occupied["ok"], &theirs_occupied["code"]), (&json!(false), &json!("WORKTREE_BRANCH_OCCUPIED")));
        assert_eq!(theirs_occupied["details"]["kind"], "session");
        assert_eq!(theirs_occupied["details"]["sessionId"], "other");

        // Running from a subdirectory resolves the session's Project and reuses the session's own existing worktree.
        let sub = rig.repo.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let created = parse(&call_git(&rig, "lead", &sub, "c6", json!({"command": "git worktree add -b mine ../m1"})).await);
        assert_eq!((&created["ok"], &created["created"]), (&json!(true), &json!(true)), "{created}");
        let reused = parse(&call_git(&rig, "lead", &sub, "c7", json!({"command": "git worktree add ../m2 mine"})).await);
        assert_eq!((&reused["ok"], &reused["created"]), (&json!(true), &json!(false)), "{reused}");
        assert_eq!(reused["path"], created["path"]);
        assert_eq!(reused["worktreeId"], created["worktreeId"]);
        let record = rig.worktrees.record(&CancellationToken::new(), created["worktreeId"].as_str().unwrap()).await.unwrap().unwrap();
        assert!(same_path(&record.project_path, &rig.repo.to_string_lossy()), "resolved session project, not subdir: {}", record.project_path);

        // Lead's snapshot resolves the session's Project and is cleaned up when the turn settles.
        let snap = parse(&call_git(&rig, "lead", &sub, "c8", json!({"command": "git worktree add --detach ../snap"})).await);
        assert_eq!((&snap["ok"], &snap["snapshot"]), (&json!(true), &json!(true)), "{snap}");
        let snap_record = rig.worktrees.record(&CancellationToken::new(), snap["worktreeId"].as_str().unwrap()).await.unwrap().unwrap();
        assert!(same_path(&snap_record.project_path, &rig.repo.to_string_lossy()));
        let released = rig.worktrees.release_turn_snapshots("lead", Some(1), &CancellationToken::new()).await.unwrap();
        assert_eq!(released["removed"].as_array().unwrap().len(), 1, "{released}");
        assert!(!Path::new(snap["path"].as_str().unwrap()).exists());
    }

    #[tokio::test]
    async fn raw_worktree_remove_refuses_another_sessions_snapshot_without_live_lease() {
        let rig = multi_rig(&["lead", "other"]);
        // Worker creates a snapshot (no command lease is held).
        let worker_snap = parse(&call_git(&rig, "worker", &rig.repo, "c1", json!({"command": "git worktree add --detach ../wsnap"})).await);
        assert_eq!((&worker_snap["ok"], &worker_snap["snapshot"]), (&json!(true), &json!(true)), "{worker_snap}");
        let worker_snap_path = PathBuf::from(worker_snap["path"].as_str().unwrap());

        // Lead cannot remove the worker's snapshot even though no command lease is live.
        let refused =
            parse(&call_git(&rig, "lead", &rig.repo, "c2", json!({"command": format!("git worktree remove -f {}", worker_snap_path.display())})).await);
        assert_eq!((&refused["ok"], &refused["code"]), (&json!(false), &json!("WORKTREE_BUSY_JOBS")), "{refused}");
        assert_eq!(refused["details"]["reason"], "snapshot-held");
        assert_eq!(refused["details"]["sessionId"], "worker");
        assert_eq!(refused["error"], "This snapshot belongs to another session's turn; it is removed when that turn ends, or by a prune.");
        assert!(worker_snap_path.exists());

        // Lead CAN remove its own snapshot when no command lease is live.
        let lead_snap = parse(&call_git(&rig, "lead", &rig.repo, "c3", json!({"command": "git worktree add --detach ../lsnap"})).await);
        assert_eq!((&lead_snap["ok"], &lead_snap["snapshot"]), (&json!(true), &json!(true)), "{lead_snap}");
        let lead_snap_path = PathBuf::from(lead_snap["path"].as_str().unwrap());
        let removed = parse(&call_git(&rig, "lead", &rig.repo, "c4", json!({"command": format!("git worktree remove -f {}", lead_snap_path.display())})).await);
        assert_eq!((&removed["ok"], &removed["removed"]), (&json!(true), &json!(true)), "{removed}");
        assert!(!lead_snap_path.exists());
    }
}
