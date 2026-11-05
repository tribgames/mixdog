//! The Lead session's workspace transitions (Node `session-runtime/workspace`): entering the
//! retained or a new worktree, running in a branch's checkout, returning to the project
//! folder, merging and removing the worktree. Every transition is one serialized, revisioned
//! commit: admitted against turns and other workspace changes, checked for an idle Lead,
//! journaled so a failure puts back exactly what already moved, and awaited to a durable save
//! through the [`WorkspaceHost`]. Git and registry work is `mixdog-scm`'s [`Worktrees`].
//!
//! [`SessionWorkspaces`] implements the `git` tool's [`SessionWorktrees`] and the project-branch
//! [`FolderAdmission`].

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_protocol::DomainErrorDetail;
use mixdog_protocol::JsonValue;
use mixdog_rt::CancellationToken;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::worktree::branches::Admitted;
use mixdog_scm::worktree::branches::FolderAdmission;
use mixdog_scm::worktree::errors;
use mixdog_scm::worktree::errors::RefusalReason;
use mixdog_scm::worktree::manager::RepoFacts;
use mixdog_scm::worktree::manager::Retention;
use mixdog_scm::worktree::manager::Worktrees;
use mixdog_scm::worktree::names;
use mixdog_scm::worktree::registry::WorktreeRecord;
use mixdog_scm::worktree::settings::SettingsSource;
use mixdog_scm::worktree::texts::failure_text;
use mixdog_tools::git::SessionOp;
use mixdog_tools::git::SessionWorktrees;
use serde_json::json;

#[path = "worktree_gate.rs"]
mod worktree_gate;
#[path = "worktree_host.rs"]
mod worktree_host;
#[path = "worktree_ops.rs"]
mod worktree_ops;
#[path = "worktree_state.rs"]
mod worktree_state;
#[path = "worktree_intents.rs"]
mod worktree_intents;
#[path = "worktree_merge.rs"]
mod worktree_merge;
#[path = "worktree_session.rs"]
mod worktree_session;
#[path = "worktree_steps.rs"]
mod worktree_steps;
#[path = "worktree_texts.rs"]
mod worktree_texts;
#[cfg(test)]
#[path = "worktree_tests.rs"]
mod worktree_tests;
#[cfg(test)]
#[path = "worktree_goldens.rs"]
mod worktree_goldens;

pub use self::worktree_gate::AdmissionGate;
pub use self::worktree_gate::Checkout;
pub use self::worktree_gate::Checkouts;
pub use self::worktree_gate::Cwd;
pub use self::worktree_gate::SpawnGuard;
pub use self::worktree_gate::TurnGuard;
pub use self::worktree_host::JobCwd;
pub use self::worktree_host::LeadActivity;
pub use self::worktree_host::LiveSession;
pub use self::worktree_host::Move;
pub use self::worktree_host::SessionView;
pub use self::worktree_host::Undo;
pub use self::worktree_host::WorkspaceChange;
pub use self::worktree_host::WorkspaceHost;
pub use self::worktree_state::Resumed;
pub use self::worktree_texts::RECOVERY_TURN_REFUSAL;
pub use self::worktree_texts::thrown_message;
pub use self::worktree_state::TransitionState;
pub use self::worktree_state::Workspace;
pub use self::worktree_state::bound_workspace_cwd;
pub use self::worktree_state::read_session_workspace;
pub use self::worktree_state::replacement_session_cwd;
pub use self::worktree_state::restore_workspace_after_resume;
pub use self::worktree_state::workspace_for_project_selection;

use self::worktree_gate::folder_in_use;
use self::worktree_merge::Admission;
use self::worktree_ops::Ops;
use self::worktree_state::checkout_folder;
use self::worktree_state::is_bound;
use self::worktree_state::is_within;
use self::worktree_state::plain;
use self::worktree_state::project_subdir_of;
use self::worktree_state::same_path;

const CARRY_CHOICES: [&str; 2] = ["leave", "carry"];

// ---- inputs -----------------------------------------------------------------------------------

/// `requestWorktree`: re-enter the retained worktree now, or arm the lazy creation for the
/// next message; `provision` creates and enters right away.
#[derive(Clone, Debug, Default)]
pub struct RequestWorktree {
    pub name: Option<String>,
    pub confirm_large: bool,
    pub provision: bool,
    /// `ask`, `leave` or `carry`.
    pub carry_changes: Option<String>,
    pub prompt: String,
    pub tx_id: String,
    pub expected_revision: Option<u64>,
}

/// `selectBranch`: run in `branch`'s checkout.
#[derive(Clone, Debug, Default)]
pub struct SelectBranch {
    pub branch: String,
    pub create: bool,
    pub expected_revision: Option<u64>,
    pub confirm_large: bool,
    pub tx_id: String,
}

/// `mergeWorkspace`: merge the retained worktree into the project folder's checked-out branch.
#[derive(Clone, Debug, Default)]
pub struct MergeWorkspace {
    pub confirmed: bool,
    pub target: Option<String>,
    pub cleanup: bool,
    pub expected_revision: Option<u64>,
}

/// The first message of a turn: its submission id, text and large-repository confirmation.
#[derive(Clone, Debug, Default)]
pub struct TurnStart {
    pub submission_id: String,
    pub prompt: String,
    pub confirm_large: bool,
}

// ---- journal ---------------------------------------------------------------------------------

fn undo(step: impl Future<Output = Result<(), ScmFailure>> + Send + 'static) -> Undo {
    Box::new(move || Box::pin(step))
}

/// The undo of every step a transition took; run newest first, every step runs.
#[derive(Default)]
struct Journal(Vec<Undo>);

impl Journal {
    fn push(&mut self, step: Undo) {
        self.0.push(step);
    }

    fn clear(&mut self) {
        self.0.clear();
    }

    async fn undo_all(&mut self) {
        while let Some(step) = self.0.pop() {
            // A rollback step that fails must not stop the others; the original failure is
            // the one reported.
            let _ = step().await;
        }
    }
}

enum Target {
    Worktree { name: Option<String> },
    Branch { branch: String, create: bool },
    Remove { force: bool },
}

#[derive(Default)]
struct Options {
    expected_revision: Option<u64>,
    confirm_large: bool,
    own_turn: bool,
    tx_id: String,
    name_hint: Option<String>,
    changes: Option<String>,
}

struct Fields {
    project_path: String,
    repo_common_dir: Option<String>,
    cwd: String,
    worktree_id: Option<String>,
    branch: Option<String>,
    base_commit: Option<String>,
    merge_target: Option<String>,
}

#[derive(Clone)]
struct Intent {
    name: Option<String>,
    confirm_large: bool,
    explicit: bool,
    /// Armed for this very session (`requestWorktree`); otherwise a creation-time intent that
    /// belongs to a new task only.
    armed: bool,
    tx_id: Option<String>,
}

// ---- helpers ---------------------------------------------------------------------------------

fn new_tx_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn valid_name(name: Option<&str>) -> Result<Option<String>, ScmFailure> {
    match name {
        None => Ok(None),
        Some(name) => match names::name_error(name) {
            Some(problem) => Err(plain(format!("worktree name is invalid: {problem}"))),
            None => Ok(Some(name.to_owned())),
        },
    }
}

/// `WORKTREE_REVISION_CONFLICT` when the caller expected another workspace revision.
fn assert_revision(revision: u64, expected: Option<u64>) -> Result<(), ScmFailure> {
    match expected {
        Some(expected) if expected != revision => Err(ScmFailure::coded(
            errors::WORKTREE_REVISION_CONFLICT,
            DomainErrorDetail::WorktreeRevisionConflict {
                entry_id: None,
                remaining: None,
                branch: None,
                tx_id: None,
                expected_revision: Some(expected),
                revision: Some(revision),
            },
        )),
        _ => Ok(()),
    }
}

fn busy(reason: &str, fill: impl FnOnce(&mut DomainErrorDetail)) -> ScmFailure {
    let mut detail = DomainErrorDetail::WorktreeBusyJobs {
        reason: reason.to_owned(),
        outcome: None,
        admission: None,
        sessions: None,
        entry_id: None,
        kept: None,
        workers: None,
        jobs: None,
        shell_jobs: None,
        starting: None,
        session_id: None,
    };
    fill(&mut detail);
    ScmFailure::coded(errors::WORKTREE_BUSY_JOBS, detail)
}

/// The text of a failure as the cleanup notice and the menu show it.
fn failure_message(failure: &ScmFailure) -> String {
    match failure {
        ScmFailure::Coded { code, detail, .. } => failure_text(code, detail.as_deref()),
        other => other.to_string(),
    }
}

fn with_fields(mut base: JsonValue, fields: Vec<(&str, JsonValue)>) -> JsonValue {
    if let Some(map) = base.as_object_mut() {
        for (key, value) in fields {
            map.insert(key.to_owned(), value);
        }
    }
    base
}

/// WORKTREE_PROJECT_MISMATCH unless the retained `entry` was created for the same repository
/// and the same Project folder inside it.
fn assert_retained_fits(entry: &WorktreeRecord, project: &RepoFacts, project_path: &str) -> Result<(), ScmFailure> {
    let top = project.top_level.to_string_lossy();
    let subdir = project_subdir_of(&top, &project.project_path.to_string_lossy());
    let entry_subdir = entry.extra.get("projectSubdir").and_then(JsonValue::as_str).unwrap_or("");
    if same_path(&entry.repo_common_dir, &project.common_dir.to_string_lossy()) && entry_subdir == subdir {
        return Ok(());
    }
    Err(errors::project_mismatch(entry.id.clone(), entry.project_path.clone(), project_path.to_owned()))
}

fn text(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

// ---- the runtime ------------------------------------------------------------------------------

struct Inner {
    ops: Ops,
    retention: Arc<dyn Retention>,
    host: Arc<dyn WorkspaceHost>,
    gate: Arc<AdmissionGate>,
    intents: Mutex<HashMap<String, Intent>>,
}

/// The session workspaces of this runtime. Build one with [`SessionWorkspaces::new`], share the
/// returned [`AdmissionGate`] with turn admission and worker spawning, and hand the value to
/// the `git` tool as its [`SessionWorktrees`].
#[derive(Clone)]
pub struct SessionWorkspaces {
    inner: Arc<Inner>,
}

impl SessionWorkspaces {
    pub fn new(
        worktrees: Arc<Worktrees>,
        retention: Arc<dyn Retention>,
        settings: Arc<dyn SettingsSource>,
        host: Arc<dyn WorkspaceHost>,
        gate: Arc<AdmissionGate>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                ops: Ops { wt: worktrees, settings, runtime_token: new_tx_id() },
                retention,
                host,
                gate,
                intents: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn gate(&self) -> &Arc<AdmissionGate> {
        &self.inner.gate
    }

    /// Admit one turn of `session` (see [`AdmissionGate::admit_turn`]).
    pub async fn admit_turn(&self, session: &str, cwd: Cwd, cancel: &CancellationToken) -> Result<TurnGuard, ScmFailure> {
        self.inner.gate.admit_turn(session, cwd, &*self.inner, cancel).await
    }

    /// The admission of project-branch merges and folder cleanups; `actor` is the session
    /// acting on its own checkout, whose own turn and workers its caller already checked.
    pub fn folder_admission(&self, actor: Option<&str>) -> Arc<dyn FolderAdmission> {
        Arc::new(Admission { inner: self.inner.clone(), actor: actor.map(str::to_owned) })
    }

    /// The workspace `session` has now: the stored record, or the project folder (revision 0).
    pub fn workspace(&self, session: &str) -> Result<Workspace, ScmFailure> {
        self.inner.workspace(session)
    }

    /// Arm the creation-time intent of a new task (`mode` `worktree`, `default` or `branch`).
    pub async fn register_creation_intent(&self, session: &str, mode: Option<&str>, name: Option<String>) {
        let intent = match mode {
            Some("worktree") => Some(Intent { name, confirm_large: false, explicit: true, armed: false, tx_id: None }),
            Some("default") if self.inner.ops.settings.worktree_settings().await.new_task_default == "worktree" => {
                Some(Intent { name: None, confirm_large: false, explicit: false, armed: false, tx_id: None })
            }
            _ => None,
        };
        if let Some(intent) = intent {
            self.inner.set_intent(session, Some(intent));
        }
    }

    /// What the branch menu shows of the armed intent.
    pub fn pending_worktree(&self, session: &str) -> Option<JsonValue> {
        self.inner.intent(session).map(|i| json!({ "name": i.name }))
    }

    /// Turn-start gate, before the user row, the provider and any worker spawn: a session in
    /// recovery refuses; a pending worktree intent is provisioned now.
    pub async fn prepare_turn_workspace(
        &self,
        session: &str,
        start: TurnStart,
        cancel: &CancellationToken,
    ) -> Result<Option<JsonValue>, ScmFailure> {
        self.inner.prepare_turn_workspace(session, start, cancel).await
    }

    pub async fn request_worktree(
        &self,
        session: &str,
        input: RequestWorktree,
        own_turn: bool,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        self.inner.request_worktree(session, input, own_turn, cancel).await
    }

    pub async fn select_branch(
        &self,
        session: &str,
        input: SelectBranch,
        own_turn: bool,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        self.inner.select_branch(session, input, own_turn, cancel).await
    }

    pub async fn merge_workspace(
        &self,
        session: &str,
        input: MergeWorkspace,
        own_turn: bool,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        self.inner.merge_workspace(session, input, own_turn, cancel).await
    }

    pub async fn remove_worktree(
        &self,
        session: &str,
        force: bool,
        expected_revision: Option<u64>,
        own_turn: bool,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        self.inner.remove_worktree(session, force, expected_revision, own_turn, cancel).await
    }
}

#[async_trait]
impl Checkouts for Inner {
    async fn of(&self, folder: &str, cancel: &CancellationToken) -> Result<Option<Checkout>, ScmFailure> {
        let registry = self.ops.wt.registry().clone();
        let folder = PathBuf::from(folder);
        self.ops
            .on_disk(cancel, move || {
                let Ok(identity) = mixdog_scm::repo::discover(&folder) else { return Ok(None) };
                let Some(top) = identity.work_tree else { return Ok(None) };
                let key = |p: &std::path::Path| mixdog_scm::locks::path_key(p);
                if key(&identity.git_dir) == key(&identity.common_dir) {
                    return Ok(Some(Checkout { top_level: text(&top), external: false }));
                }
                let entries = registry.read().map_err(|_| errors::busy(RefusalReason::WorkspaceAdmissionUnreadable))?;
                let managed = entries.values().any(|r| key(std::path::Path::new(&r.path)) == key(&top));
                Ok(Some(Checkout { top_level: text(&top), external: !managed }))
            })
            .await?
    }
}

impl Inner {
    fn intent(&self, session: &str) -> Option<Intent> {
        self.intents.lock().unwrap_or_else(|p| p.into_inner()).get(session).cloned()
    }

    fn set_intent(&self, session: &str, intent: Option<Intent>) {
        let mut intents = self.intents.lock().unwrap_or_else(|p| p.into_inner());
        match intent {
            Some(intent) => intents.insert(session.to_owned(), intent),
            None => intents.remove(session),
        };
    }

    fn hosted(&self, session: &str) -> Result<SessionView, ScmFailure> {
        self.host.session(session).ok_or_else(|| {
            let shown = if session.trim().is_empty() { "(none)" } else { session };
            plain(format!("workspace: session {shown} is not hosted by this runtime."))
        })
    }

    fn workspace(&self, session: &str) -> Result<Workspace, ScmFailure> {
        let view = self.hosted(session)?;
        if let Some(stored) = read_session_workspace(view.workspace.as_ref()) {
            return Ok(stored);
        }
        let project = view.desktop_project.clone().or(view.cwd.clone()).unwrap_or_else(|| view.runtime_cwd.clone());
        let cwd = if view.runtime_cwd.is_empty() { project.clone() } else { view.runtime_cwd.clone() };
        Workspace::from_value(&Workspace::project(&project, &cwd).to_value())
    }

    /// `WORKTREE_BUSY_JOBS` while this Lead has a turn, workers or background shells running.
    async fn assert_lead_idle(&self, session: &str, own_turn: bool) -> Result<(), ScmFailure> {
        let activity = self.host.activity(session).await;
        if !own_turn && activity.turn_running {
            return Err(busy("turn", |_| {}));
        }
        if activity.busy_workers > 0 || activity.busy_jobs > 0 {
            return Err(busy("workers", |d| {
                if let DomainErrorDetail::WorktreeBusyJobs { workers, jobs, .. } = d {
                    *workers = Some(activity.busy_workers);
                    *jobs = Some(activity.busy_jobs);
                }
            }));
        }
        if activity.shell_jobs > 0 {
            return Err(busy("shell-jobs", |d| {
                if let DomainErrorDetail::WorktreeBusyJobs { shell_jobs, .. } = d {
                    *shell_jobs = Some(activity.shell_jobs);
                }
            }));
        }
        Ok(())
    }

    /// The workspace the branch menu shows: a bound record with its checkout's branch, a
    /// project-folder session with the folder's checked-out branch.
    async fn workspace_view(&self, session: &str, cancel: &CancellationToken) -> Result<Workspace, ScmFailure> {
        let mut view = self.workspace(session)?;
        if view.is_bound() {
            let head = self
                .ops
                .wt
                .scm()
                .git
                .outcome(cancel, std::path::Path::new(&view.cwd), &["symbolic-ref", "--quiet", "--short", "HEAD"], &Default::default())
                .await?;
            let branch = head.stdout_text().lines().next().unwrap_or("").trim().to_owned();
            if head.success() && !branch.is_empty() {
                view.branch = Some(branch);
            }
            return Ok(view);
        }
        match self.ops.inspect(&view.cwd, cancel).await {
            Ok(project) => {
                view.repo_common_dir = Some(text(&project.common_dir));
                // A detached checkout shows branch null with the commit in baseCommit.
                if project.current_branch.is_none() {
                    view.base_commit = Some(project.head.clone());
                }
                view.branch = project.current_branch;
            }
            Err(failure) if failure.code() == Some(errors::WORKTREE_UNSUPPORTED_REPO) => {
                view.repo_common_dir = None;
                view.branch = None;
            }
            Err(other) => return Err(other),
        }
        Ok(view)
    }
}
