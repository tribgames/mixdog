//! The folder a task opened in a Project runs in: the one answer of Node's `SessionHost.resolveSessionWorkspace`
//! (`session-host.ts`) and `resolveManagedWorktree` (`managed-worktree-path.ts`), kept in the core. A desktop
//! new-task draft asks for the skill status by `projectPath`; the Node host resolved it before the call
//! (`session-host-lifecycle.ts` `forwardedArgs`), so on a core connection the core must.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_core::run_host::late::Bound;
use mixdog_core_session::session::thread_settings::ProjectFolders;
use mixdog_js::js_trim;
use mixdog_mcp::skills_service::ProjectWorkspaces;
use mixdog_rt::CancellationToken;
use mixdog_scm::locks::path_key;
use mixdog_scm::repo::on_lane;
use mixdog_scm::worktree::manager::Worktrees;

/// `key` is `base` or below it (keys are separator-normalised, case-folded on Windows).
fn within(key: &str, base: &str) -> bool {
    key == base || key.strip_prefix(base).is_some_and(|rest| rest.starts_with('/'))
}

pub struct SessionProjectWorkspaces {
    projects: Arc<dyn ProjectFolders>,
    worktrees: Arc<Worktrees>,
}

impl SessionProjectWorkspaces {
    pub fn new(projects: Arc<dyn ProjectFolders>, worktrees: Arc<Worktrees>) -> Self {
        Self { projects, worktrees }
    }

    /// `resolveManagedWorktree`: the registered Project that owns the ready managed worktree at (or below)
    /// `requested`, and the folder's real path. Anything else, an unreadable registry included, is `None`.
    async fn managed(&self, requested: &str) -> Option<(String, String)> {
        let path = self.projects.canonical_directory(requested).await.ok()?;
        let registry = self.worktrees.registry().clone();
        let records = on_lane(self.worktrees.scm().lane, &CancellationToken::new(), move || registry.read()).await.ok()?.ok()?;
        let key = path_key(Path::new(&path));
        let entry = records.into_values().find(|record| within(&key, &path_key(Path::new(&record.path))))?;
        if entry.state != "ready" {
            return None;
        }
        let entry_path = self.projects.canonical_directory(&entry.path).await.ok()?;
        if !within(&key, &path_key(Path::new(&entry_path))) {
            return None;
        }
        let project = self.projects.registered(&entry.project_path).await.ok()?;
        Some((project, path))
    }
}

/// The states a recovery call may still reach a managed worktree in (`projectRecoveryDirectory`).
const RECOVERY_STATES: [&str; 3] = ["ready", "deleting", "recovery"];

/// The folder `requested` names inside the checkout `entry_path` (Node's `projectRecoveryDirectory` worktree branch, after the
/// registry lookup): spelled from the checkout's real parent (the checkout itself is not resolved, it may be a replacement link),
/// then its real path if that stays in the checkout. A lane job.
fn recovery_folder(entry_path: &Path, requested: &Path) -> Option<PathBuf> {
    use mixdog_workspace::pathguard::{canonical, canonical_path, is_within, resolve};
    let stable = canonical_path(entry_path.parent()?).join(entry_path.file_name()?);
    let lexical_within = |base: &Path| is_within(&resolve(base), requested);
    let spelling = [resolve(entry_path), stable.clone()].into_iter().find(|base| lexical_within(base))?;
    // `relative(spelling, requested)`: the components of `requested` past the checkout (compared case-folded on Windows).
    let target = stable.join(requested.components().skip(spelling.components().count()).collect::<PathBuf>());
    match canonical(&target) {
        Ok(real) => Some(if is_within(&stable, &real) { real } else { target }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(target),
        Err(_) => None,
    }
}

#[async_trait]
impl mixdog_workspace::service::ManagedProjects for SessionProjectWorkspaces {
    async fn owner(&self, path: &str) -> Option<(String, String)> {
        self.managed(path).await
    }

    async fn recovery_root(&self, path: &str) -> Option<PathBuf> {
        if !Path::new(path).is_absolute() {
            return None;
        }
        let requested = mixdog_workspace::pathguard::resolve(Path::new(path));
        let registry = self.worktrees.registry().clone();
        let probe = requested.clone();
        let entry = on_lane(self.worktrees.scm().lane, &CancellationToken::new(), move || {
            use mixdog_workspace::pathguard::{canonical_path, is_within};
            let wanted = canonical_path(&probe);
            registry.read().ok().and_then(|records| records.into_values().find(|record| is_within(&canonical_path(Path::new(&record.path)), &wanted)))
        })
        .await
        .ok()??;
        if !RECOVERY_STATES.contains(&entry.state.as_str()) {
            return None;
        }
        self.projects.registered(&entry.project_path).await.ok()?;
        let entry_path = PathBuf::from(&entry.path);
        on_lane(self.worktrees.scm().lane, &CancellationToken::new(), move || recovery_folder(&entry_path, &requested)).await.ok()?
    }

    async fn recovery_store(
        &self,
        root: &Path,
        directory: &Path,
        action: mixdog_workspace::service::RecoveryUse,
        run: std::pin::Pin<Box<dyn std::future::Future<Output = mixdog_workspace::error::WsResult<serde_json::Value>> + Send>>,
    ) -> mixdog_workspace::error::WsResult<serde_json::Value> {
        use mixdog_scm::worktree::housekeeping::RecoveryAction;
        use mixdog_workspace::service::RecoveryUse;
        let action = match action {
            RecoveryUse::Inspect => RecoveryAction::Inspect,
            RecoveryUse::Restore => RecoveryAction::Restore,
            RecoveryUse::Discard => RecoveryAction::Discard,
        };
        // The run's own refusal passes through the worktree manager untouched.
        let mut refused = None;
        let outcome = self
            .worktrees
            .with_recovery_store(
                root,
                directory,
                action,
                || async {
                    run.await.map_err(|error| {
                        refused = Some(error);
                        mixdog_scm::error::ScmFailure::Cancelled
                    })
                },
                &CancellationToken::new(),
            )
            .await;
        match outcome {
            Ok(value) => Ok(value),
            Err(_) if refused.is_some() => Err(refused.expect("checked")),
            Err(failure) => Err(worktree_refusal(&failure)),
        }
    }
}

/// A worktree manager refusal as Node's `WorktreeError` reached the caller: its code with its text.
fn worktree_refusal(failure: &mixdog_scm::error::ScmFailure) -> mixdog_workspace::error::WsError {
    match failure.code() {
        Some(code) => {
            let text = failure.message().or_else(|| mixdog_scm::worktree::texts::contract_message(code, failure.detail())).map_or_else(|| failure.to_string(), str::to_owned);
            mixdog_workspace::error::WsError::coded(code, text)
        }
        None => mixdog_workspace::error::WsError::plain(failure.to_string()),
    }
}

#[async_trait]
impl ProjectWorkspaces for SessionProjectWorkspaces {
    async fn workspace_cwd(&self, project_path: &str) -> Result<PathBuf, String> {
        let requested = js_trim(project_path);
        if requested.is_empty() {
            return self.projects.task_workspace().await.map(PathBuf::from);
        }
        // A managed worktree executes in its own folder while the project identity stays the registered main Project.
        let (registered, worktree) = match self.projects.registered(requested).await {
            Ok(path) => (path, None),
            Err(refusal) => match self.managed(requested).await {
                Some((project, path)) => (project, Some(path)),
                None => return Err(refusal),
            },
        };
        let project = self.projects.canonical_directory(&registered).await?;
        Ok(PathBuf::from(worktree.unwrap_or(project)))
    }
}

/// The resolver the skills service holds, bound once the workspace and the worktree manager exist (the skills are
/// composed before them).
#[derive(Default)]
pub struct LateProjectWorkspaces(OnceLock<Arc<dyn ProjectWorkspaces>>);

impl LateProjectWorkspaces {
    pub fn bind(&self, resolver: Arc<dyn ProjectWorkspaces>) -> Result<(), Arc<dyn ProjectWorkspaces>> {
        self.0.set(resolver)
    }
}

#[async_trait]
impl ProjectWorkspaces for LateProjectWorkspaces {
    async fn workspace_cwd(&self, project_path: &str) -> Result<PathBuf, String> {
        self.0.get().expect("the project workspaces are bound before the first request is served").workspace_cwd(project_path).await
    }
}

impl Bound for LateProjectWorkspaces {
    fn cell(&self) -> &'static str {
        "project workspaces"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}
