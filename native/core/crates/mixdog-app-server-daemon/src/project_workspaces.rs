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
