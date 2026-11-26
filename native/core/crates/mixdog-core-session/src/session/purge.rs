//! `deleteSession`'s outside world over the process's own services: the store purge hooks bound
//! to the owners of the state they drop (`registerSessionPurgeHook`), and the delete seams.
//!
//! File state is dropped in maintenance-lane jobs, best effort as Node's hooks are; each hook
//! returns once its job has run, so the delete completes after every effect has landed.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use futures::future::BoxFuture;
use mixdog_agent::agent_tool::board::CancelAll;
use mixdog_agent::agent_tool::board::CancelNotice;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::flow::worker_turns::WorkerTurns;
use mixdog_ai::warmer::chain::Warmer;
use mixdog_core_api::ids::ThreadId;
use mixdog_mcp::mcp_glue::McpScopes;
use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use mixdog_services::memory::session_search::ingest::SessionSearchIngest;
use mixdog_services::memory::transcript::TranscriptIngest;
use mixdog_tools::fs::ReadState;

use super::agent_registry::AgentRegistry;
use super::delete::DeleteSeams;
use super::delete::PurgeHook;
use super::delete::PurgeHooks;
use super::gateway_routes::GatewaySessionRoutes;
use super::shell_jobs::OwnedShells;
use super::tool_events::ToolEventsLog;
use super::worktree::WorktreeMaintenance;
use mixdog_store::schema::record::Header;

/// The memory service's transcript ingest as the transcript hook sees it: the read positions
/// kept per transcript file (`memoryRuntime.forgetTranscripts`).
#[async_trait]
pub trait IngestOffsets: Send + Sync {
    /// Drops the persisted position of each transcript; the number of entries removed.
    async fn forget_transcripts(&self, paths: &[PathBuf]) -> usize;

    /// Replaces a transcript line for line with `rewrite` of its text, its read position kept on
    /// the same line (`TranscriptIngest::rewrite_transcript`); whether the file changed.
    async fn rewrite_transcript(&self, path: &Path, rewrite: mixdog_services::memory::transcript::LineRewrite) -> std::io::Result<bool>;
}

#[async_trait]
impl IngestOffsets for TranscriptIngest {
    async fn forget_transcripts(&self, paths: &[PathBuf]) -> usize {
        TranscriptIngest::forget_transcripts(self, paths).await
    }

    async fn rewrite_transcript(&self, path: &Path, rewrite: mixdog_services::memory::transcript::LineRewrite) -> std::io::Result<bool> {
        TranscriptIngest::rewrite_transcript(self, path, rewrite).await
    }
}

/// The owners the purge hooks drop a deleted session's state from.
pub struct PurgeOwners {
    /// `resolvePluginData()`.
    pub data_dir: PathBuf,
    /// `mixdogHome()`: the conversation transcripts live under its `projects`.
    pub mixdog_home: PathBuf,
    pub maintenance: MaintenanceIo,
    /// The one read state of the read, edit and apply_patch tools.
    pub read_state: Arc<ReadState>,
    /// The prompt-cache warmer: its chain, turns, touch and idle-gap stores and warm use.
    pub warm: Arc<Warmer>,
    /// The memory service's transcript ingest; `None` when memory is off (Node's
    /// `memoryRuntime?.forgetTranscripts`).
    pub ingest_offsets: Option<Arc<dyn IngestOffsets>>,
    /// The process's transcript writers: a deleted session's writer is stopped, its queued lines
    /// discarded and its later appends refused before its files go (`purgeSessionTranscripts`).
    pub transcripts: Option<Arc<super::transcript_writer::TranscriptFiles>>,
    /// The provider registry: each provider's connections of the session.
    pub providers: Arc<mixdog_ai::registry::providers::ProviderRegistry>,
    /// The agent tool's worker-turn observer.
    pub worker_turns: WorkerTurns,
    /// The worker index (`registry.forgetDeletedSession`).
    pub agents: Arc<AgentRegistry>,
    /// The desktop's auto-retention record (`sessionRetention.forget`).
    pub retention: Arc<dyn super::thread_settings::ArchiveRetention>,
}

/// `job` on the maintenance lane; resolves once it has run (Node's hooks write synchronously).
fn on_lane(maintenance: MaintenanceIo, job: impl FnOnce(&InLane<MaintenanceIo>) + Send + 'static) -> BoxFuture<'static, ()> {
    let submitted = maintenance.submit(&CancellationToken::new(), job);
    Box::pin(async move {
        match submitted {
            Ok(job) => {
                if job.await.is_err() {
                    tracing::warn!("session delete: a purge job did not run");
                }
            }
            Err(error) => tracing::warn!(?error, "session delete: a purge job was refused"),
        }
    })
}

/// A hook whose effect is already done when it returns.
fn done() -> BoxFuture<'static, ()> {
    Box::pin(std::future::ready(()))
}

fn hook(f: impl Fn(&str, &[String]) -> BoxFuture<'static, ()> + Send + Sync + 'static) -> Arc<dyn PurgeHook> {
    Arc::new(f)
}

/// `[A-Za-z0-9_-]+` (`SESSION_ID`).
fn stored_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `cwdToProjectSlug(resolve(cwd))`.
pub fn project_slug(cwd: &str) -> String {
    let resolved = super::user_cwd::node_resolve(cwd).replace('\\', "/");
    let bytes = resolved.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    let resolved = if drive { format!("{}-{}", &resolved[..1], &resolved[2..]) } else { resolved };
    resolved.replace('/', "-")
}

/// `clearOffloadSessionSync`: the session's offloaded tool results (`*.txt`), then its folder.
fn clear_offloaded(lane: &InLane<MaintenanceIo>, dir: &Path) {
    let Ok(names) = mixdog_statefile::list_dir(lane, dir) else { return };
    for name in names.iter().filter(|name| name.ends_with(".txt")) {
        mixdog_rt::job_progress();
        let _ = mixdog_statefile::remove_file(lane, &dir.join(name));
    }
    // `rmdirSync`: only an empty folder goes.
    if mixdog_statefile::list_dir(lane, dir).is_ok_and(|left| left.is_empty()) {
        let _ = mixdog_statefile::remove_dir_all(lane, dir);
    }
}

/// `purgeSessionTranscripts`: `<id>.jsonl` and its rotated `.1` under each known cwd's project.
fn remove_transcripts(_lane: &InLane<MaintenanceIo>, paths: &[PathBuf]) {
    for path in paths {
        let mut rotated = path.clone().into_os_string();
        rotated.push(".1");
        for target in [path.clone(), PathBuf::from(rotated)] {
            if let Err(failure) = mixdog_core_base::support::remove_file_forced(&target) {
                tracing::warn!(path = %target.display(), ?failure, "session delete: could not remove the transcript");
            }
        }
    }
}

/// `rmSync(dir, { recursive: true, force: true })` / `unlinkSync` that ignores what is gone.
fn remove_all(lane: &InLane<MaintenanceIo>, targets: &[PathBuf]) {
    for target in targets {
        mixdog_rt::job_progress();
        let _ = match mixdog_statefile::metadata(lane, target) {
            Ok(meta) if meta.is_dir() => mixdog_statefile::remove_dir_all(lane, target),
            Ok(_) => mixdog_statefile::remove_file(lane, target),
            Err(error) => Err(error),
        };
    }
}

/// The owners of what a deleted session leaves in files outside its stored record.
pub struct FileOwners {
    /// `resolvePluginData()`.
    pub data_dir: PathBuf,
    /// `mixdogHome()`: the conversation transcripts live under its `projects`.
    pub mixdog_home: PathBuf,
    pub maintenance: MaintenanceIo,
    /// The one read state of the read, edit and apply_patch tools.
    pub read_state: Arc<ReadState>,
    pub ingest_offsets: Option<Arc<dyn IngestOffsets>>,
    pub transcripts: Option<Arc<super::transcript_writer::TranscriptFiles>>,
}

/// The purge hooks that remove files ([`PurgeHooks`]' members of the same names).
pub struct FileHooks {
    pub transcript_export: Arc<dyn PurgeHook>,
    pub tool_result_offload: Arc<dyn PurgeHook>,
    pub transcripts: Arc<dyn PurgeHook>,
    pub read_cache: Arc<dyn PurgeHook>,
    pub connector_accounts: Arc<dyn PurgeHook>,
    pub compaction_archive: Arc<dyn PurgeHook>,
    pub scratch_dir: Arc<dyn PurgeHook>,
}

impl FileHooks {
    pub fn new(owners: FileOwners) -> Self {
        let FileOwners { data_dir, mixdog_home, maintenance, read_state, ingest_offsets, transcripts: writers } = owners;
        let lane = maintenance;
        let data = data_dir.clone();
        let transcript_export = hook(move |id, _| {
            if !stored_id(id) {
                return done();
            }
            let path = super::transcript_export::export_path(&data, id);
            on_lane(lane, move |_| {
                if let Err(failure) = mixdog_core_base::support::remove_file_forced(&path) {
                    tracing::warn!(?failure, path = %path.display(), "session delete: could not remove the transcript export");
                }
            })
        });
        let data = data_dir.clone();
        let tool_result_offload = hook(move |id, _| {
            if id.is_empty() {
                return done();
            }
            let dir = data.join("tool-results").join(mixdog_core_run::run_host::artifact::safe_segment(id));
            on_lane(lane, move |lane| clear_offloaded(lane, &dir))
        });
        let transcripts = hook(move |id, cwds| {
            if id.is_empty() {
                return done();
            }
            let projects = mixdog_home.join("projects");
            let mut cwd_paths: Vec<PathBuf> = Vec::new();
            for cwd in cwds.iter().filter(|cwd| !cwd.is_empty()) {
                cwd_paths.push(projects.join(project_slug(cwd)).join(format!("{id}.jsonl")));
            }
            let (writers, offsets, id) = (writers.clone(), ingest_offsets.clone(), id.to_owned());
            Box::pin(async move {
                // The writers' own paths first, then the known cwds' (`knownPaths` and `cwds`): the
                // writer is stopped and refused from here on, so nothing recreates a file below.
                let mut paths = match &writers {
                    Some(writers) => writers.purge(&id).await,
                    None => Vec::new(),
                };
                for path in cwd_paths {
                    if !paths.contains(&path) {
                        paths.push(path);
                    }
                }
                let offsets = offsets.filter(|_| !paths.is_empty());
                on_lane(lane, {
                    let paths = paths.clone();
                    move |lane| remove_transcripts(lane, &paths)
                })
                .await;
                // Not awaited: the position blob is a best-effort request to the memory service.
                if let Some(offsets) = offsets {
                    drop(mixdog_rt::spawn("session-delete-offsets", mixdog_rt::TaskClass::Work, async move {
                        offsets.forget_transcripts(&paths).await;
                    }));
                }
            })
        });
        let read_cache = hook(move |id, _| {
            read_state.forget_session(id);
            let state = read_state.clone();
            Box::pin(async move { state.settle().await })
        });
        let data = data_dir.clone();
        let connector_accounts = hook(move |id, _| {
            let (data, id) = (data.clone(), id.to_owned());
            on_lane(lane, move |lane| {
                if let Err(error) = mixdog_mcp::connector_accounts::forget_conversation(lane, &data, &id) {
                    tracing::warn!(%error, "session delete: connector accounts not forgotten");
                }
            })
        });
        let data = data_dir.clone();
        let compaction_archive = hook(move |id, _| {
            if !stored_id(id) {
                return done();
            }
            // The archive (`deleteCompactionArchive`) and the pending sidecar a 1.4.5 daemon left
            // for jobs it never published (`removePendingSidecar`, `compaction-archive-capture.mjs:738`).
            let sessions = data.join("sessions");
            let paths = [format!("{id}.compaction-archive.jsonl"), format!("{id}.compaction-archive.pending")].map(|name| sessions.join(name));
            on_lane(lane, move |lane| remove_all(lane, &paths))
        });
        let scratch_dir = hook(move |id, _| {
            let Some(dir) = mixdog_tools::exec::session_scratch_dir(&data_dir, id) else { return done() };
            // Earlier versions named the folder after the full id.
            let legacy = data_dir.join("scratch").join(id);
            on_lane(lane, move |lane| remove_all(lane, &[dir, legacy]))
        });
        Self { transcript_export, tool_result_offload, transcripts, read_cache, connector_accounts, compaction_archive, scratch_dir }
    }
}

impl PurgeHooks {
    /// The hooks bound to `owners`, in a booted 1.4.5 daemon's order.
    pub fn new(owners: PurgeOwners) -> Self {
        let PurgeOwners { data_dir, mixdog_home, maintenance, read_state, warm, ingest_offsets, transcripts, providers, worker_turns, agents, retention } =
            owners;
        let files = FileHooks::new(FileOwners { data_dir, mixdog_home, maintenance, read_state, ingest_offsets, transcripts });
        let cache_warm = hook(move |id, _| {
            warm.purge_session(id);
            done()
        });
        let provider_connections = hook(move |id, _| {
            providers.release_session(id);
            done()
        });
        let worker_turns = hook(move |id, _| {
            worker_turns.forget(id);
            done()
        });
        let agent_status = hook(move |id, _| {
            let (agents, id) = (agents.clone(), id.to_owned());
            Box::pin(async move {
                agents.forget_deleted_session(&id).await;
            })
        });
        let retention = hook(move |id, _| {
            let (retention, id) = (retention.clone(), id.to_owned());
            Box::pin(async move {
                // A record that cannot be written never fails the delete (Node's `.catch` warns).
                if let Err(error) = retention.forget(&id).await {
                    tracing::warn!(%error, session = %id, "[mixdog-session] Could not forget the retention record");
                }
            })
        });
        Self::with_files(files, cache_warm, provider_connections, worker_turns, agent_status, retention)
    }

    /// The hooks over `files` and the hooks of the owners that keep a session's state in memory or in their own stores.
    pub fn with_files(
        files: FileHooks,
        cache_warm: Arc<dyn PurgeHook>,
        provider_connections: Arc<dyn PurgeHook>,
        worker_turns: Arc<dyn PurgeHook>,
        agent_status: Arc<dyn PurgeHook>,
        retention: Arc<dyn PurgeHook>,
    ) -> Self {
        let FileHooks { transcript_export, tool_result_offload, transcripts, read_cache, connector_accounts, compaction_archive, scratch_dir } = files;
        Self {
            transcript_export,
            tool_result_offload,
            transcripts,
            cache_warm,
            read_cache,
            provider_connections,
            connector_accounts,
            worker_turns,
            agent_status,
            compaction_archive,
            scratch_dir,
            retention,
        }
    }
}

/// [`DeleteSeams`] over the process's services.
pub struct SessionDeletion {
    /// `thread/deleted` on the app feed, with what ends when a conversation leaves the catalog.
    pub deleted: Arc<super::thread_edges::ThreadDeletions>,
    /// The memory service's session-search writer; `None` when memory is off.
    pub search: Option<Arc<SessionSearchIngest>>,
    pub worktrees: Arc<WorktreeMaintenance>,
    /// The background tasks (`cancelBackgroundTasks`).
    pub board: JobBoard,
    /// `statusRoutes` (`clearGatewaySessionRoute`).
    pub gateway_routes: GatewaySessionRoutes,
    /// The shells a closing session owns (`cancelOwnedShellTrees`).
    pub shells: Arc<dyn OwnedShells>,
    /// `<data>/tool-events.log`, the close metric.
    pub tool_events: Arc<ToolEventsLog>,
    /// The sessions' MCP scopes (`disconnectAll({ scopeId })` of the runtime's close).
    pub mcp_scopes: Arc<dyn McpScopes>,
    pub read_state: Arc<ReadState>,
    /// The agent definitions (`purgeAgentDefinition`); `None` where the process has none.
    pub agents: Option<Arc<dyn RetiredAgents>>,
    /// The external agents of the sessions an ACP agent runs: a session's agent process ends where its MCP scope is
    /// released (close, delete, unload). `None` where the process has none.
    pub agent_processes: Option<Arc<dyn SessionAgentProcesses>>,
    /// What other owners keep per session, let go of where the session's runtime unloads or the session ends.
    pub releases: SessionReleases,
}

/// A holder's release of one session's state.
pub type SessionRelease = Arc<dyn Fn(&str) + Send + Sync>;

/// The per-session state the core's registries keep, by the moment it is let go of. A release runs again for a session that
/// loads again, so each is safe to run any number of times.
#[derive(Default)]
pub struct SessionReleases {
    /// The session's runtime rested, still loaded: what it kept only for its next turn.
    pub rested: Vec<SessionRelease>,
    /// The session's runtime unloaded: what only that runtime used.
    pub unloaded: Vec<SessionRelease>,
    /// The session ended (closed for good or deleted): what the session itself owned. An end is an unload too.
    pub ended: Vec<SessionRelease>,
    /// The session was deleted: what must outlive a close (a closed session can still be asked of) goes. A delete is an end too.
    pub deleted: Vec<SessionRelease>,
}

impl SessionReleases {
    fn rested(&self, session_id: &str) {
        for release in &self.rested {
            release(session_id);
        }
    }

    fn unloaded(&self, session_id: &str) {
        for release in &self.unloaded {
            release(session_id);
        }
    }

    fn ended(&self, session_id: &str) {
        self.unloaded(session_id);
        for release in &self.ended {
            release(session_id);
        }
    }

    fn deleted(&self, session_id: &str) {
        for release in &self.deleted {
            release(session_id);
        }
    }
}

/// The process an external agent runs in for one session.
pub trait SessionAgentProcesses: Send + Sync {
    /// Ends the session's agent with its whole process tree; a session with none has nothing to end.
    fn release(&self, session_id: &str);
}

/// `purgeAgentDefinition(agentId)` over the process's agent definitions.
#[async_trait]
pub trait RetiredAgents: Send + Sync {
    async fn purge(&self, agent_id: &str) -> Result<(), String>;
}

#[async_trait]
impl DeleteSeams for SessionDeletion {
    async fn purge_retired_agent(&self, agent_id: &str) -> Result<(), String> {
        match &self.agents {
            Some(agents) => agents.purge(agent_id).await,
            None => Ok(()),
        }
    }

    fn session_closed(&self, session_id: &str, reason: &str, header: &Header, closed_at_ms: i64) {
        self.tool_events.session_closed(session_id, header, reason, closed_at_ms);
    }

    fn tombstoned(&self, thread: &ThreadId) {
        self.deleted.tell(thread);
    }

    fn release_mcp_scope(&self, session_id: &str) {
        self.mcp_scopes.release(session_id);
        if let Some(agents) = &self.agent_processes {
            agents.release(session_id);
        }
    }

    fn release_unloaded_runtime(&self, session_id: &str) {
        if let Some(agents) = &self.agent_processes {
            agents.release(session_id);
        }
        self.mcp_scopes.release_unloaded(session_id);
        self.read_state.release_session(session_id);
        self.releases.unloaded(session_id);
    }

    fn release_rested(&self, session_id: &str) {
        self.releases.rested(session_id);
    }

    fn session_ended(&self, session_id: &str) {
        self.releases.ended(session_id);
    }

    fn session_deleted(&self, session_id: &str) {
        self.releases.deleted(session_id);
    }

    async fn release_session_work(&self, session_id: &str, reason: &str) {
        self.shells.cancel_owned(&ThreadId::from(session_id));
        let cancel =
            CancelAll { reason: reason.to_owned(), execution_session_id: Some(session_id.to_owned()), notice: CancelNotice::Never, ..CancelAll::default() };
        self.board.cancel_all(&cancel);
        self.board.forget_session(session_id);
        self.gateway_routes.clear(session_id).await;
    }

    fn forget_session_search(&self, session_id: &str) {
        let Some(search) = self.search.as_ref() else { return };
        // The memory runtime owns the removal (its stop drains or revokes it, and refuses it once stopping).
        search.forget_session_owned(session_id);
    }

    async fn release_deleted_worktree(&self, session_id: &str) {
        if let Err(error) = self.worktrees.cleanup_deleted_session(session_id, &CancellationToken::new()).await {
            tracing::warn!(?error, "session delete: worktree not released");
        }
    }

    fn thread_deleted(&self, thread: &ThreadId) {
        self.deleted.publish(thread);
    }
}
