//! DRAFT (harness only, never filed): `HostRuntime` for `SessionWorkspaceHost`. The rows of flip-ce-misc (compose-seams.md) are written in; what is
//! left is named `compile_error!`s (`workspace_context`'s prewarm inputs).
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::worktree::worktree_host::{JobCwd, LeadActivity, LiveSession, Undo};
use mixdog_core_session::session::worktree::worktree_host_impl::{HostRuntime, WorkspaceContext};
use mixdog_scm::error::ScmFailure;
use mixdog_tools::exec::shell_control::ShellControl;
use mixdog_core_session::session::agent_registry::{AgentRegistry, LiveSessions};
use mixdog_rt::{CancellationToken, DurabilityIo};
use mixdog_core_ports::ports::setup_actions::{CallerScope, SetupCallers};
use serde_json::{Map, Value};

fn port(error: impl std::fmt::Debug) -> ScmFailure {
    ScmFailure::git(format!("{error:?}"))
}

pub struct LiveHostRuntime {
    pub directory: Arc<SessionDirectory>,
    pub shells: Arc<ShellControl>,
    pub registry: Arc<AgentRegistry>,
    /// `SessionSetupCallers`: provenance (`scheduleCallerScope`), whose unattended-run lookup is
    /// `HeldHome::run_of` -> `UnattendedRunRegistry::named_run_of` -> `run_stamp_of`.
    pub callers: Arc<dyn SetupCallers>,
    /// `TurnPath::reuses` (run-host-22) and the observed-file store (`ReadState`, wp-tools-fs-1).
    pub reuses: Arc<mixdog_core::run_host::result_reuse::LiveReuses>,
    pub read_state: Arc<mixdog_tools::fs::read_state::ReadState>,
    /// `resolve_project_id` and the `.mixdog/project.id` write run on this lane.
    pub durability: DurabilityIo,
    /// wp-session-23: `PromptReroot::new(directory.clone(), threads.clone())` with the `SessionThreads` the `SessionWorkspaceHost` is given.
    pub prompt_reroot: mixdog_core_session::session::worktree::PromptReroot,
    /// The one `UserCwd` of `SessionDeps.user_cwd` (`write_last_cwd`).
    pub user_cwd: mixdog_core_session::session::UserCwd,
    /// The AGENT job table of `mixdog_agent::agent_tool::assemble(AgentParts{..})` (`assembled.board`), not the exec/shell board `SessionDeletion` takes.
    pub board: mixdog_agent::agent_tool::board::JobBoard,
    /// wu-scm-10: the stored sessions that still hold a workspace, over the `StoreThreads` of `SessionDeps.store`.
    pub stored: mixdog_core_session::session::worktree::worktree_consumers::StoredConsumers,
    /// `CoreMemoryContext::new(durability_io, data_dir, MIXDOG_BOOT_CORE_MEMORY off-switch)`, loaded for a Lead only.
    pub core_memory: mixdog_services::memory::core::context::CoreMemoryContext,
    pub config: mixdog_core_config::config::Config,
    /// The prompt composition of ComposedPrompt (surface_host): the SAME lane tokens, probes, observations and host facts.
    pub prompt_io: mixdog_core_api::domain::tool::ToolIo,
    pub probes: Arc<mixdog_core::run_host::prewarm::StartupProbes>,
    pub observed: Arc<mixdog_core_prompt::prompt::probes::StartupObservations>,
    pub facts: Arc<mixdog_core::run_host::prewarm::PromptFacts>,
    /// promptConfigSlice(getConfig()).instructionFiles: the in-memory setting (null when unset).
    pub instruction_files: Arc<dyn Fn() -> Value + Send + Sync>,
}

/// `activity-guards.mjs:14-17`.
const ACTIVE_STAGES: [&str; 6] = ["connecting", "requesting", "streaming", "tool_running", "running", "cancelling"];

fn text(row: &Map<String, Value>, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

impl LiveHostRuntime {
    /// `positiveInt` of the session header's `clientHostPid`.
    fn client_host_pid(&self, id: &str) -> Option<u64> {
        mixdog_agent::agent_tool::scope::positive_int(self.directory.handle(&ThreadId::from(id)).map(|h| h.header_snapshot()).as_deref().and_then(|header| header.get("clientHostPid")))
    }

    /// Node `agentStatusState`: `rt.session?.clientHostPid || process.pid`.
    fn scope_of(&self, id: &str) -> mixdog_agent::agent_tool::scope::Scope {
        mixdog_agent::agent_tool::scope::Scope { caller_session_id: Some(id.to_owned()), host_pid: Some(self.client_host_pid(id).unwrap_or_else(|| u64::from(std::process::id()))) }
    }

    fn header_text(&self, id: &str, key: &str) -> Option<String> {
        let handle = self.directory.handle(&ThreadId::from(id))?;
        handle.header_snapshot().get(key).and_then(Value::as_str).map(str::to_owned)
    }
}

#[async_trait]
impl HostRuntime for LiveHostRuntime {
    /// A loaded Lead session: provenance Human, and no unattended run owns it.
    async fn is_lead(&self, id: &str) -> bool {
        let thread = ThreadId::from(id);
        self.directory.handle(&thread).is_some() && matches!(self.callers.scope(&thread).await, CallerScope::Human)
    }

    /// `worktreeCallerScope(..).attended`: kind human or agent, and not an unattended run.
    async fn attended(&self, id: &str) -> bool {
        matches!(self.callers.scope(&ThreadId::from(id)).await, CallerScope::Human | CallerScope::Agent { unattended: false, .. })
    }

    /// The runtime cwd is the header's `cwd` (`assemble.rs cwd_of`).
    fn runtime_cwd(&self, id: &str) -> String {
        self.header_text(id, "cwd").unwrap_or_default()
    }

    /// Node `applyResolvedCwd`: `writeLastSessionCwd(cwd, session.clientHostPid)`, then `moveLeadRow` (`update_lead_worker_cwd`, which cannot throw; Node swallows its
    /// throws). The header `cwd` is `SessionWorkspaceHost::save`'s. NOT here (no Rust call yet, run-host): the folder-exists check, the `CwdChanged` hook, the code-graph prewarm.
    async fn set_runtime_cwd(&self, id: &str, cwd: &str) -> Result<(), ScmFailure> {
        let pid = self.client_host_pid(id).map(|p| p.to_string());
        self.user_cwd.write_last_cwd(cwd, pid.as_deref()).await;
        self.registry.update_lead_worker_cwd(id, cwd).await;
        Ok(())
    }

    /// Pure read of the loaded session's header (wp-prompt-presented-1); `apply` has already required the header, so the empty default is unreachable there.
    async fn presented_workspace(&self, id: &str) -> Value {
        let header = self.directory.handle(&ThreadId::from(id)).map(|handle| handle.header_snapshot());
        mixdog_core::run_host::prompt_session::presented_workspace_of(&header.unwrap_or_default())
    }

    /// Typed (run-host-30, user decision): a dropped lane job is `Err`, never an empty context.
    async fn workspace_context(&self, id: &str, cwd: &str) -> Result<WorkspaceContext, ScmFailure> {
        // Node `refreshWorkspacePrompt` (transitions.mjs:71-74): a new checkout drops the observed-file snapshots and the read/scoped result caches of the session
        // before the prompt slices are composed.
        self.reuses.clear_session(id);
        self.read_state.forget_session(id);
        let header = self.directory.handle(&ThreadId::from(id)).map(|handle| handle.header_snapshot()).unwrap_or_default();
        let owner_is_agent = header.get("owner").and_then(Value::as_str) == Some("agent");
        let memory_agent_id = text(&header, "agent").unwrap_or_default(); // Node `getMemoryAgentId()`
        // Node `refreshWorkspacePrompt` -> `buildWorkspacePromptContext(session, cwd, { instructionFilesMode })` (workspace/transitions.mjs:78, session-prompt-composition.mjs:95).
        // `prewarmGitStartupProbes([cwd])` is `prewarm::compose`'s probe-and-compose-again step: the composition asks for what it lacks, it is probed, and the job runs once more.
        let tool_free_role = owner_is_agent && header.get("schemaAllowedTools").and_then(Value::as_array).is_some_and(Vec::is_empty);
        let names = |key: &str| header.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_owned)).collect::<Vec<_>>();
        let has_git_tool = names("tools").iter().chain(names("deferredToolCatalog").iter()).any(|name| name == "git");
        let skip_instruction_files = header.get("skipInstructionFiles") == Some(&Value::Bool(true));
        let agent_mode = mixdog_store::agent_mode::session_mode_of(&header) == "agent";
        let (session_id, cwd_owned, mode) = (id.to_owned(), cwd.to_owned(), (self.instruction_files)());
        let job: mixdog_core::run_host::prewarm::ComposeJob<mixdog_core::run_host::prompt_session::WorkspaceContext> = Arc::new(move |lane, host, observed| {
            let sources = mixdog_core_prompt::prompt::real_sources::RealSources::new(lane, host, observed);
            let facts = mixdog_core::run_host::prompt_session::WorkspaceFacts { session_id: &session_id, owner_is_agent, tool_free_role, has_git_tool, skip_instruction_files, agent_mode };
            mixdog_core::run_host::prompt_session::workspace_prompt_context(&facts, &cwd_owned, Some(&mode), &sources)
        });
        let prompt = mixdog_core::run_host::prewarm::compose(&self.prompt_io, &self.probes, &self.observed, self.facts.clone(), job).await.map_err(ScmFailure::git)?;
        // The Lead only (workers never carried project memory): `loadCoreMemoryContext()` is not called for an agent.
        let core_memory_context = if owner_is_agent { None } else { Some(self.core_memory.load(cwd, &memory_agent_id).await) };
        Ok(WorkspaceContext { environment_context: prompt.environment_context, core_memory_context, instruction_files_context: prompt.instruction_files_context })
    }

    /// `PromptReroot` (wp-session-23): the in-place reroot with undo, over the directory and the `SessionThreads` the workspace host takes.
    async fn reroot_prompt(&self, id: &str, cwd: &str, context: &WorkspaceContext) -> Result<Undo, ScmFailure> {
        self.prompt_reroot.reroot(id, cwd, context).await
    }

    /// `assertLeadIdle`'s reads (`activity-guards.mjs:50-82`): the turn, the Lead's busy workers
    /// (owner or parent is the Lead), its running jobs, and the shells owned by the Lead, its indexed
    /// workers and its live agent workers.
    async fn activity(&self, id: &str) -> LeadActivity {
        // `session_entries` rows are session records (id, agent, cwd, ownerSessionId, parentSessionId, closed): they
        // carry no `status`/`stage`, so they give the Lead's worker sessions but not which are busy.
        let workers: Vec<Map<String, Value>> = self
            .registry
            .session_entries(false, &Default::default())
            .into_iter()
            .map(|(_, row)| row)
            .filter(|row| text(row, "ownerSessionId").as_deref() == Some(id) || text(row, "parentSessionId").as_deref() == Some(id))
            .collect();
        let scope = self.scope_of(id);
        let mut owners: Vec<String> = vec![id.to_owned()];
        owners.extend(workers.iter().filter_map(|row| text(row, "id")));
        for live in self.live_sessions() {
            if live.id != id && !live.closed && (live.owner_session_id.as_deref() == Some(id) || live.parent_session_id.as_deref() == Some(id)) {
                owners.push(live.id);
            }
        }
        owners.sort();
        owners.dedup();
        LeadActivity {
            turn_running: LiveSessions::running(&*self.directory, id),
            busy_workers: self.registry.busy_worker_count(&scope).await, // wp-agent-11 (STAGED), 697-case golden
            busy_jobs: self.board.busy_count(&scope, &|worker: &str| self.client_host_pid(worker)), // wp-agent-11, 67-op golden; `running_count(id)` is the same count with no process
            shell_jobs: self.shell_job_count(&owners).await,
        }
    }

    /// Node `listLiveSessions()`; `active` is `isSessionActive`: a running turn, or a runtime stage in
    /// `ACTIVE_STAGES`.
    fn live_sessions(&self) -> Vec<LiveSession> {
        LiveSessions::loaded(&*self.directory)
            .into_iter()
            .filter_map(|id| {
                let header = LiveSessions::header(&*self.directory, &id)?;
                let stage = LiveSessions::runtime_stage(&*self.directory, &id).unwrap_or_default().to_lowercase();
                Some(LiveSession {
                    cwd: text(&header, "cwd"),
                    active: LiveSessions::running(&*self.directory, &id) || ACTIVE_STAGES.contains(&stage.as_str()),
                    closed: header.get("closed") == Some(&Value::Bool(true)),
                    owner_session_id: text(&header, "ownerSessionId"),
                    parent_session_id: text(&header, "parentSessionId"),
                    id,
                })
            })
            .collect()
    }

    /// wu-scm-10 (STAGED): fails closed with Node's "Cannot inspect session <id>; no workspace was removed." (the trait method returns `Result`).
    async fn stored_consumers(&self) -> Result<Vec<LiveSession>, ScmFailure> {
        self.stored.list().await
    }

    async fn running_jobs(&self) -> Vec<JobCwd> {
        self.shells.tasks().host_state().jobs.iter().map(|row| JobCwd { cwd: row.cwd.clone(), terminal: false }).collect()
    }

    async fn shell_job_count(&self, ids: &[String]) -> u64 {
        ids.iter().map(|id| self.shells.tasks().thread_state(id).jobs.len() as u64).sum()
    }

    /// `copyProjectIdentity` (`workspace-state.mjs:105`): nothing when the checkout's marker holds
    /// data or the Project has no id; else the id and a newline, written atomically, mode 0644.
    async fn copy_project_identity(&self, project_path: &str, worktree_path: &str) -> Result<bool, ScmFailure> {
        let target = std::path::Path::new(worktree_path).join(".mixdog").join("project.id");
        let held = target.clone();
        let present = mixdog_core_base::support::on_lane(self.durability, &CancellationToken::new(), move |_| mixdog_statefile::read_content(&held))
            .await
            .map_err(port)?
            .map_err(port)?;
        if present.is_some_and(|bytes| !mixdog_statefile::holds_no_data(&bytes)) {
            return Ok(false);
        }
        let Some(id) = mixdog_services::memory::project::resolve_project_id(self.durability, std::path::Path::new(project_path)).await.map_err(port)? else {
            return Ok(false);
        };
        if mixdog_statefile::holds_no_data(id.as_bytes()) {
            return Ok(false);
        }
        let bytes = format!("{id}\n").into_bytes();
        mixdog_core_base::support::on_lane(self.durability, &CancellationToken::new(), move |lane| {
            mixdog_statefile::write_file(lane, &target, &bytes, &mixdog_statefile::Opts { mode: 0o644, ..Default::default() })
        })
        .await
        .map_err(port)?
        .map_err(port)?;
        Ok(true)
    }
}
