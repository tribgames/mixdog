//! The rig of the thread settings service, shared by this crate's tests and (behind `test-support`) by the tests of
//! crates that run the service over a real session directory: the doubles of what the service reads (the registered
//! Projects, the archive notes, the effort tuning, the agent-only index), [`build`] over any `SessionWorkspaces`, and
//! [`hosted`], the workspaces over the directory's own host as the daemon composes them.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::FeedSource;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::MockConnection;
use mixdog_core_api::mock::MockFeed;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_base::support::testing::scopes;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_scm::engine::Scm;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::worktree::maintenance::SessionActivity;
use mixdog_scm::worktree::maintenance::SessionSource;
use mixdog_scm::worktree::maintenance::ShellJob;
use mixdog_scm::worktree::manager::Worktrees;
use mixdog_scm::worktree::settings::SettingsSource;
use mixdog_scm::worktree::settings::WorktreeSettings;
use mixdog_spawn::LocalProcessManager;
use mixdog_spawn::ProcessConfig;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::sub_agent_retention::AgentOnlyIndex;
use super::thread_settings::ArchiveRetention;
use super::thread_settings::ArchiveStamps;
use super::thread_settings::ArchivedWorktrees;
use super::thread_settings::EffortTuning;
use super::thread_settings::ProjectFolders;
use super::thread_settings::ThreadSettings;
use super::thread_settings::ThreadSettingsParts;
use super::thread_settings::project_identity;
use super::thread_state::SessionThreads;
use super::worktree::AdmissionGate;
use super::worktree::HostRuntime;
use super::worktree::JobCwd;
use super::worktree::LeadActivity;
use super::worktree::LiveSession;
use super::worktree::SessionWorkspaceHost;
use super::worktree::SessionWorkspaces;
use super::worktree::Undo;
use super::worktree::WorkspaceContext;
use super::worktree::WorktreeMaintenance;
use super::worktree::WorktreeSetup;
use super::testing::lock;

/// The registered Projects; what a move asked of them.
pub struct Projects {
    pub registered: Vec<String>,
    pub task: String,
    pub touched: Mutex<Vec<String>>,
}

#[async_trait]
impl ProjectFolders for Projects {
    async fn projects(&self) -> Result<Vec<String>, String> {
        Ok(self.registered.clone())
    }
    async fn registered(&self, path: &str) -> Result<String, String> {
        let key = project_identity(Some(path));
        self.registered.iter().find(|p| project_identity(Some(p)) == key).cloned().ok_or_else(|| "Project is not available.".to_owned())
    }
    async fn canonical_directory(&self, path: &str) -> Result<String, String> {
        Ok(path.to_owned())
    }
    async fn task_workspace(&self) -> Result<String, String> {
        Ok(self.task.clone())
    }
    async fn touch_selected(&self, cwd: &str) -> Result<(), String> {
        lock(&self.touched).push(cwd.to_owned());
        Ok(())
    }
}

#[derive(Default)]
pub struct Notes(pub Mutex<Vec<(String, bool)>>);

#[async_trait]
impl ArchiveRetention for Notes {
    async fn note_archived(&self, session_id: &str, archived: bool) -> Result<(), String> {
        lock(&self.0).push((session_id.to_owned(), archived));
        Ok(())
    }
    async fn forget(&self, _session_id: &str) -> Result<(), String> {
        unreachable!("the thread settings never forget a record: a delete does")
    }
}

#[derive(Default)]
pub struct Effort(pub Mutex<Vec<(String, String, bool)>>);

#[async_trait]
impl EffortTuning for Effort {
    async fn set_effort(&self, thread: &ThreadId, value: &str, session_only: bool) -> Result<Value, String> {
        if value == "huge" {
            return Err("effort must be one of auto, none, minimal, low, medium, high, xhigh, max, ultra".into());
        }
        lock(&self.0).push((thread.as_str().to_owned(), value.to_owned(), session_only));
        Ok(json!({ "provider": "anthropic", "model": "opus", "effort": value, "autoEffort": false }))
    }
    fn route(&self, _: &ThreadId) -> Value {
        json!({})
    }
}

/// The stored agent-only sessions, set by the test.
#[derive(Default)]
pub struct AgentOnly(pub Mutex<Vec<String>>);

#[async_trait]
impl AgentOnlyIndex for AgentOnly {
    async fn agent_only_ids(&self) -> Result<Vec<String>, CoreError> {
        Ok(lock(&self.0).clone())
    }
}

struct NoSessions;

#[async_trait]
impl SessionSource for NoSessions {
    async fn stored_session_ids(&self) -> Result<HashSet<String>, ScmFailure> {
        Ok(HashSet::new())
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

/// The service and what it reads.
pub struct Built {
    pub settings: ThreadSettings,
    pub projects: Arc<Projects>,
    pub notes: Arc<Notes>,
    pub effort: Arc<Effort>,
    pub agent_only: Arc<AgentOnly>,
    pub app: MockConnection,
    pub surface: mixdog_core_base::surface::SurfaceGeneration,
    /// The core's one archive stamp counter, which the settings and the retention cycle share.
    pub stamps: Arc<ArchiveStamps>,
    pub ops: tempfile::TempDir,
}

/// The service over `directory` and `workspaces`, with `registered` as the Projects and `task` as the task workspace.
pub async fn build(directory: Arc<SessionDirectory>, workspaces: SessionWorkspaces, worktrees: Arc<Worktrees>, registered: Vec<String>, task: String) -> Built {
    build_with(directory, workspaces, worktrees, None, registered, task).await
}

/// [`build`] with the archive hand-off going to `hand_off` instead of the real worktree maintenance over `worktrees`.
pub async fn build_with(
    directory: Arc<SessionDirectory>,
    workspaces: SessionWorkspaces,
    worktrees: Arc<Worktrees>,
    hand_off: Option<Arc<dyn ArchivedWorktrees>>,
    registered: Vec<String>,
    task: String,
) -> Built {
    let projects = Arc::new(Projects { registered, task, touched: Mutex::default() });
    let (notes, effort, agent_only) = (Arc::new(Notes::default()), Arc::new(Effort::default()), Arc::new(AgentOnly::default()));
    let live: super::worktree::LiveSessions = Arc::new(HashSet::new);
    let worktrees = WorktreeMaintenance::new(worktrees, Arc::new(NoSessions), live, Arc::new(|_: Option<&str>| {}));
    let limits = MockLimits::default();
    let feed = Arc::new(MockFeed::new("app".into(), mixdog_core_api::mock::epoch(1), Arc::new(mixdog_core_api::mock::EchoView), limits));
    let app = MockConnection::new(ConnectionId(1), limits);
    let source: Arc<dyn FeedSource> = feed.clone();
    let attached = mixdog_core_api::feed::subscribe(&source, "app".into(), mixdog_core_api::feed::Window::Fixed, None, &app).unwrap();
    mixdog_core_api::sink::ConnectionSink::send_control_release(&app, bytes::Bytes::from_static(b"{}"), attached.release).unwrap();
    let ops = tempfile::tempdir().unwrap();
    let surface = mixdog_core_base::surface::SurfaceGeneration::default();
    let stamps: Arc<ArchiveStamps> = Arc::default();
    let settings = ThreadSettings::new(ThreadSettingsParts {
        directory,
        workspaces,
        effort: effort.clone(),
        projects: projects.clone(),
        agent_only: agent_only.clone(),
        worktrees: hand_off.unwrap_or_else(|| Arc::new(worktrees)),
        retention: notes.clone(),
        app: Arc::new(mixdog_core_base::state::SectionFeedState::new(feed)),
        ops: scopes(ops.path(), "thread").await,
        surface: surface.clone(),
        archive_stamps: stamps.clone(),
    });
    Built { settings, projects, notes, effort, agent_only, app, surface, stamps, ops }
}

/// The live runtime around the sessions, as far as a Project switch reads it: whether a turn runs is the directory's, the
/// folder the session runs in is its header's, and a prompt carries nothing to re-root.
struct Runtime {
    directory: Arc<SessionDirectory>,
}

#[async_trait]
impl HostRuntime for Runtime {
    async fn is_lead(&self, _: &str) -> bool {
        true
    }
    async fn attended(&self, _: &str) -> bool {
        true
    }
    fn runtime_cwd(&self, id: &str) -> String {
        let header = self.directory.handle(&ThreadId::from(id)).map(|handle| handle.header_snapshot());
        header.and_then(|header| header.get("cwd").and_then(Value::as_str).map(str::to_owned)).unwrap_or_default()
    }
    async fn set_runtime_cwd(&self, _: &str, _: &str) -> Result<(), ScmFailure> {
        Ok(())
    }
    async fn presented_workspace(&self, _: &str) -> Value {
        json!({})
    }
    async fn workspace_context(&self, _: &str, _: &str) -> Result<WorkspaceContext, ScmFailure> {
        Ok(WorkspaceContext::default())
    }
    async fn reroot_prompt(&self, _: &str, _: &str, _: &WorkspaceContext) -> Result<Undo, ScmFailure> {
        Ok(Box::new(|| Box::pin(async { Ok(()) })))
    }
    async fn activity(&self, id: &str) -> LeadActivity {
        LeadActivity { turn_running: super::agent_registry::LiveSessions::running(&*self.directory, id), ..LeadActivity::default() }
    }
    fn live_sessions(&self) -> Vec<LiveSession> {
        Vec::new()
    }
    async fn stored_consumers(&self) -> Result<Vec<LiveSession>, ScmFailure> {
        Ok(Vec::new())
    }
    async fn running_jobs(&self) -> Vec<JobCwd> {
        Vec::new()
    }
    async fn shell_job_count(&self, _: &[String]) -> u64 {
        0
    }
    async fn copy_project_identity(&self, _: &str, _: &str) -> Result<bool, ScmFailure> {
        Ok(false)
    }
}

struct Defaults;

#[async_trait]
impl SettingsSource for Defaults {
    async fn worktree_settings(&self) -> WorktreeSettings {
        WorktreeSettings::default()
    }
}

/// The session workspaces over `directory`'s own host (`SessionWorkspaceHost`), as the daemon builds them: a switch stores the
/// session's header through `threads`.
pub struct Hosted {
    pub workspaces: SessionWorkspaces,
    pub worktrees: Arc<Worktrees>,
    pub dir: tempfile::TempDir,
}

pub fn hosted(directory: &Arc<SessionDirectory>, threads: Arc<SessionThreads>) -> Hosted {
    let dir = tempfile::tempdir().expect("a folder");
    let tokens = mixdog_rt::testing::tokens();
    let processes = Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default()));
    let data = dir.path().join("data");
    let scm = Scm::new(processes.clone(), tokens.maintenance_io, data.join("scratch"));
    let worktrees = Arc::new(Worktrees::new(scm, data));
    let setup = Arc::new(WorktreeSetup::new(worktrees.clone(), processes));
    let host = SessionWorkspaceHost::new(directory.clone(), threads as Arc<dyn ThreadState>, Arc::new(Runtime { directory: directory.clone() }), setup);
    let workspaces = SessionWorkspaces::new(worktrees.clone(), Arc::new(NoSessions), Arc::new(HashSet::new), Arc::new(Defaults), Arc::new(host), AdmissionGate::new());
    Hosted { workspaces, worktrees, dir }
}
