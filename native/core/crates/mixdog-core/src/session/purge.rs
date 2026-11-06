//! `deleteSession`'s outside world over the process's own services: the store purge hooks bound
//! to the owners of the state they drop (`registerSessionPurgeHook`), and the delete seams.
//!
//! File state is dropped in maintenance-lane jobs, best effort as Node's hooks are; the delete
//! never waits on them.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::CancelAll;
use mixdog_agent::agent_tool::board::CancelNotice;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::flow::worker_turns::WorkerTurns;
use mixdog_ai::registry::warm::WarmLedger;
use mixdog_core_api::ids::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use mixdog_services::memory::session_search::ingest::SessionSearchIngest;
use mixdog_tools::fs::ReadState;

use super::agent_registry::AgentRegistry;
use super::delete::DeleteSeams;
use super::delete::PurgeHook;
use super::delete::PurgeHooks;
use super::delete::SidebarState;
use super::worktree::WorktreeMaintenance;
use crate::state::SectionFeedState;

/// The owners the purge hooks drop a deleted session's state from.
pub struct PurgeOwners {
    /// `resolvePluginData()`.
    pub data_dir: PathBuf,
    /// `mixdogHome()`: the conversation transcripts live under its `projects`.
    pub mixdog_home: PathBuf,
    pub maintenance: MaintenanceIo,
    /// The one read state of the read, edit and apply_patch tools.
    pub read_state: Arc<ReadState>,
    /// The provider registry's cache-warm ledger.
    pub warm: WarmLedger,
    /// The agent tool's worker-turn observer.
    pub worker_turns: WorkerTurns,
    /// The worker index (`registry.forgetDeletedSession`).
    pub agents: Arc<AgentRegistry>,
}

/// `job` on the maintenance lane, not awaited.
fn on_lane(maintenance: MaintenanceIo, job: impl FnOnce(&InLane<MaintenanceIo>) + Send + 'static) {
    drop(maintenance.submit(&CancellationToken::new(), job));
}

fn hook(f: impl Fn(&str, &[String]) + Send + Sync + 'static) -> Arc<dyn PurgeHook> {
    Arc::new(f)
}

/// `[A-Za-z0-9_-]+` (`SESSION_ID`).
fn stored_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `cwdToProjectSlug(resolve(cwd))`.
pub(crate) fn project_slug(cwd: &str) -> String {
    let resolved = super::user_cwd::node_resolve(cwd).replace('\\', "/");
    let bytes = resolved.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    let resolved = if drive { format!("{}-{}", &resolved[..1], &resolved[2..]) } else { resolved };
    resolved.replace('/', "-")
}

/// `clearOffloadSessionSync`: the session's offloaded tool results (`*.txt`), then its folder.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "a maintenance-lane job body (lane proof argument)")]
fn clear_offloaded(_lane: &InLane<MaintenanceIo>, dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().ends_with(".txt") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    let _ = std::fs::remove_dir(dir);
}

/// `purgeSessionTranscripts`: `<id>.jsonl` and its rotated `.1` under each known cwd's project.
#[allow(clippy::disallowed_methods, reason = "a maintenance-lane job body (lane proof argument)")]
fn remove_transcripts(_lane: &InLane<MaintenanceIo>, paths: &[PathBuf]) {
    for path in paths {
        let mut rotated = path.clone().into_os_string();
        rotated.push(".1");
        for target in [path.clone(), PathBuf::from(rotated)] {
            if let Err(error) = std::fs::remove_file(&target)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!(path = %target.display(), %error, "session delete: could not remove the transcript");
            }
        }
    }
}

/// `rmSync(dir, { recursive: true, force: true })` / `unlinkSync` that ignores what is gone.
#[allow(clippy::disallowed_methods, reason = "a maintenance-lane job body (lane proof argument)")]
fn remove_all(_lane: &InLane<MaintenanceIo>, targets: &[PathBuf]) {
    for target in targets {
        let _ = if target.is_dir() { std::fs::remove_dir_all(target) } else { std::fs::remove_file(target) };
    }
}

impl PurgeHooks {
    /// The hooks bound to `owners`, in a booted 1.4.5 daemon's order. Usage metrics, browser
    /// turns, compaction-archive capture jobs and provider connections have no per-session
    /// state in this process yet: no hook.
    pub fn new(owners: PurgeOwners) -> Self {
        let PurgeOwners { data_dir, mixdog_home, maintenance, read_state, warm, worker_turns, agents } = owners;
        let lane = maintenance;
        let data = data_dir.clone();
        let tool_result_offload = hook(move |id, _| {
            if id.is_empty() {
                return;
            }
            let dir = data.join("tool-results").join(crate::run_host::artifact::safe_segment(id));
            on_lane(lane, move |lane| clear_offloaded(lane, &dir));
        });
        let transcripts = hook(move |id, cwds| {
            if id.is_empty() {
                return;
            }
            let projects = mixdog_home.join("projects");
            let paths: Vec<PathBuf> =
                cwds.iter().filter(|cwd| !cwd.is_empty()).map(|cwd| projects.join(project_slug(cwd)).join(format!("{id}.jsonl"))).collect();
            on_lane(lane, move |lane| remove_transcripts(lane, &paths));
        });
        let cache_warm = hook(move |id, _| warm.forget(id));
        let read_cache = hook(move |id, _| read_state.forget_session(id));
        let data = data_dir.clone();
        let connector_accounts = hook(move |id, _| {
            let (data, id) = (data.clone(), id.to_owned());
            on_lane(lane, move |lane| {
                if let Err(error) = mixdog_mcp::connector_accounts::forget_conversation(lane, &data, &id) {
                    tracing::warn!(%error, "session delete: connector accounts not forgotten");
                }
            });
        });
        let worker_turns = hook(move |id, _| worker_turns.forget(id));
        let agent_status = hook(move |id, _| {
            let (agents, id) = (agents.clone(), id.to_owned());
            drop(mixdog_rt::spawn("session-delete-worker-row", mixdog_rt::TaskClass::Work, async move {
                agents.forget_deleted_session(&id).await;
            }));
        });
        let data = data_dir.clone();
        let compaction_archive = hook(move |id, _| {
            if !stored_id(id) {
                return;
            }
            let path = data.join("sessions").join(format!("{id}.compaction-archive.jsonl"));
            on_lane(lane, move |lane| remove_all(lane, &[path]));
        });
        let scratch_dir = hook(move |id, _| {
            let Some(dir) = mixdog_tools::exec::session_scratch_dir(&data_dir, id) else { return };
            // Earlier versions named the folder after the full id.
            let legacy = data_dir.join("scratch").join(id);
            on_lane(lane, move |lane| remove_all(lane, &[dir, legacy]));
        });
        Self {
            tool_result_offload,
            usage_metrics: None,
            browser_session: None,
            transcripts,
            cache_warm,
            read_cache,
            compaction_capture: None,
            provider_connections: None,
            connector_accounts,
            worker_turns,
            agent_status,
            compaction_archive,
            scratch_dir,
        }
    }
}

/// [`DeleteSeams`] over the process's services. `lead_pool` (`forgetLeadSession`) and
/// `gateway_routes` (`statusRoutes.clearGatewaySessionRoute`) are the owners' when they exist;
/// `sidebar` is the attached desktop's flags reader (none attached: `readSessionSidebarState`
/// answers null).
pub struct SessionDeletion {
    /// The app feed's notifications.
    pub app: Arc<SectionFeedState>,
    /// The memory service's session-search writer; `None` when memory is off.
    pub search: Option<Arc<SessionSearchIngest>>,
    pub worktrees: Arc<WorktreeMaintenance>,
    /// The background tasks (`cancelBackgroundTasks`).
    pub board: JobBoard,
    pub lead_pool: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    pub gateway_routes: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    pub sidebar: Option<Arc<dyn Fn() -> futures::future::BoxFuture<'static, Option<SidebarState>> + Send + Sync>>,
}

#[async_trait]
impl DeleteSeams for SessionDeletion {
    fn forget_lead_session(&self, session_id: &str) {
        if let Some(forget) = &self.lead_pool {
            forget(session_id);
        }
    }

    fn release_session_work(&self, session_id: &str, reason: &str) {
        let cancel = CancelAll {
            reason: reason.to_owned(),
            execution_session_id: Some(session_id.to_owned()),
            notice: CancelNotice::Never,
            ..CancelAll::default()
        };
        self.board.cancel_all(&cancel);
        if let Some(clear) = &self.gateway_routes {
            clear(session_id);
        }
    }

    fn forget_session_search(&self, session_id: &str) {
        let Some(search) = self.search.clone() else { return };
        let id = session_id.to_owned();
        drop(mixdog_rt::spawn("session-delete-search", mixdog_rt::TaskClass::Work, async move {
            search.forget_session(&id).await;
        }));
    }

    async fn release_deleted_worktree(&self, session_id: &str) {
        if let Err(error) = self.worktrees.cleanup_deleted_session(session_id, &CancellationToken::new()).await {
            tracing::warn!(?error, "session delete: worktree not released");
        }
    }

    fn thread_deleted(&self, thread: &ThreadId) {
        self.app.notify("thread/deleted", &mixdog_app_protocol::v2::thread::ThreadIdParams { thread_id: thread.clone() });
    }

    async fn sidebar_state(&self) -> Option<SidebarState> {
        match &self.sidebar {
            Some(read) => read().await,
            None => None,
        }
    }
}
