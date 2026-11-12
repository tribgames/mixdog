//! What the agent tool borrows from the rest of the runtime. Each trait is one Node
//! collaborator of `createAgentExecute` (`agent-tool/execute.mjs`): the tag registry, the send
//! and spawn flows, the session manager, the background-task table, the views and the machine.
//! The decision logic in this module is the port; these are its edges.

use async_trait::async_trait;
use mixdog_tools::orch::agent::JobRow;
use mixdog_tools::orch::agent::TaskView;
use mixdog_tools::orch::agent::WorkerRow;
use serde_json::Value;

use super::scope::Caller;
use super::scope::Scope;
use super::scope::SessionFacts;
use super::scope::TagRecord;

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct ResolveOptions {
    pub scan_sessions: bool,
    pub exclude_terminal_traces: bool,
}

/// `resumableTagSession`: the saved session that can continue a tag, or the working directory
/// that is gone.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct Resumable {
    pub session: Option<SessionFacts>,
    pub missing_cwd: Option<String>,
}

/// A send ready to dispatch: the arguments, the live session that gets them and the prompt.
#[derive(Clone, PartialEq, Debug)]
pub struct Prepared {
    pub args: Value,
    pub session: SessionFacts,
    pub session_id: String,
    pub prompt: Option<String>,
    /// A route change the send asks the session to make.
    pub route: Option<Value>,
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct DispatchOptions {
    pub reused: bool,
    pub resumed: bool,
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct SpawnOptions {
    pub respawned: bool,
}

/// A background task or a worker as `getJobOrWorker`/`startDeferredSpawnJob` return it.
#[derive(Clone, PartialEq, Debug)]
pub struct Job {
    /// Absent for a worker that has no task.
    pub task_id: Option<String>,
    pub session_id: Option<String>,
    pub view: TaskView,
}

/// A background task, as the close flow sees it.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct TaskFacts {
    pub task_id: String,
    pub session_id: Option<String>,
    pub tag: Option<String>,
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct CloseOptions {
    pub tombstone: bool,
    /// An owner's close (not a process exit's), recorded on the session itself.
    pub owner_close: bool,
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct ListOptions {
    pub scan_sessions: bool,
    pub include_idle: bool,
    pub include_closed: bool,
    pub include_terminal: bool,
}

pub struct Cleaned {
    pub removed: u64,
}

#[async_trait]
pub trait Registry: Send + Sync {
    fn resolve_tombstone_owners(&self);
    async fn refresh_tags_from_sessions(&self, scan_sessions: bool, scope: &Scope);
    /// `Err` when a tag is ambiguous across terminals.
    fn resolve_tag(&self, tag: &str, scope: &Scope, options: ResolveOptions) -> Result<Option<String>, String>;
    fn live_session(&self, session_id: &str) -> Option<SessionFacts>;
    /// The session id a tag is bound to.
    fn tag_session(&self, tag: &str) -> Option<String>;
    fn has_tag_agent(&self, tag: &str) -> bool;
    fn tag_count(&self) -> usize;
    fn tag_for_session(&self, session_id: &str) -> Option<String>;
    fn unbind_tag(&self, tag: &str);
    fn bind_tag(&self, tag: &str, session: &SessionFacts, turn_started_at: &str);
    fn forget_terminal_session(&self, tag: Option<&str>, session_id: &str);
    fn remove_worker_row(&self, session_id: &str);
    fn mark_released(&self, session_ids: &[String]);
    fn read_worker_rows(&self, scope: &Scope) -> Result<Vec<TagRecord>, String>;
    fn read_all_tag_tombstones(&self) -> Vec<TagRecord>;
    fn tag_tombstone_for_tag(&self, tag: &str, scope: &Scope) -> Option<TagRecord>;
    fn consume_tag_tombstone(&self, tombstone: &TagRecord);
    fn last_tag_session(&self, tag: &str, scope: &Scope) -> Option<TagRecord>;
    async fn resumable_tag_session(&self, tag: &str, session_id: &str, scope: &Scope) -> Option<Resumable>;
}

#[async_trait]
pub trait SendFlow: Send + Sync {
    async fn prepare_send(&self, args: &Value, scope: &Scope) -> Result<Prepared, String>;
    async fn adopt_caller(&self, prepared: &Prepared, notify: &Caller) -> Result<(), String>;
    async fn dispatch_to_existing_session(
        &self,
        prepared: &Prepared,
        notify: &Caller,
        options: DispatchOptions,
    ) -> Result<mixdog_tools::orch::agent::AgentReply, String>;
}

#[async_trait]
pub trait SpawnFlow: Send + Sync {
    async fn start_deferred_spawn_job(
        &self,
        args: &Value,
        caller_cwd: &str,
        caller: &Caller,
        notify: &Caller,
        options: SpawnOptions,
    ) -> Result<Job, String>;
}

pub trait TerminalTrace: Send + Sync {
    /// `Err` when the tag is ambiguous across terminals (`resolveTag` throws).
    fn has_terminal_trace(&self, tag: &str, scope: &Scope) -> Result<bool, String>;
    fn reap_terminal_trace_for_tag(&self, tag: &str, scope: &Scope);
}

#[async_trait]
pub trait Sessions: Send + Sync {
    /// Reloads the stored agent sessions; `false` when this surface has none to reload.
    async fn rehydrate_agent_sessions(&self) -> bool;
    async fn read_session_handoff(&self, session_id: &str) -> Option<String>;
    /// `redactSensitiveText(sessionId, text)`: the session's sensitive values in `text` as the marker.
    fn redact_text(&self, _session_id: &str, text: String) -> String {
        text
    }
    async fn close_session(&self, session_id: &str, reason: &str, options: CloseOptions) -> bool;
    fn descendant_session_ids(&self, session_id: &str) -> Vec<String>;
    /// `registry.childrenOf(id)`: the agent sessions linked directly below `session_id`.
    fn child_session_ids(&self, session_id: &str) -> Vec<String>;
    /// `registry.beginCancellation(ids)`: while the returned guard lives, these sessions refuse
    /// admission (a spawn or send under them). A surface with no admission has nothing to hold.
    fn begin_cancellation(&self, _ids: &[String]) -> Box<dyn Send> {
        Box::new(())
    }
    /// The agent's statusline route, dropped when its session closes.
    fn clear_statusline_route(&self, session_id: &str);
}

/// The process-wide background-task table, `surface: 'agent'` only.
pub trait Tasks: Send + Sync {
    fn list(&self, scope: &Scope) -> Vec<TaskFacts>;
    fn get(&self, task_id: &str, scope: &Scope) -> Option<TaskFacts>;
    fn cancel(&self, task_id: &str, reason: &str);
    /// `cancelBackgroundTasks({ surface: 'agent', callerSessionId, reason })`: every running job
    /// this session started (a job with no owner is never claimed).
    fn cancel_owned(&self, session_id: &str, reason: &str);
    fn cleanup(&self, scope: &Scope, force: bool) -> Cleaned;
}

/// The readers over the job board and the tag registry. Listing and lookup refresh the
/// registry from the stored sessions first, as Node does, so they are async.
#[async_trait]
pub trait Views: Send + Sync {
    /// A job by `task_id`, else the newest for `tag`/`sessionId`, else a synthetic job built
    /// from the worker session. `include_result`: `read` shows the result, `status` does not.
    async fn get_job_or_worker(&self, args: &Value, scope: &Scope, include_result: bool) -> Result<Job, String>;
    async fn list(&self, scope: &Scope, options: ListOptions) -> Vec<WorkerRow>;
    async fn list_jobs(&self, scope: &Scope) -> Vec<JobRow>;
}

/// Who a call's thread is: the owner session id and the host process it runs under.
pub trait CallerScopes: Send + Sync {
    fn scope_of(&self, thread: &mixdog_protocol::ThreadId) -> Scope;
}

/// The machine: files, the working directory and the clock.
#[async_trait]
pub trait Environment: Send + Sync {
    async fn is_directory(&self, path: &str) -> bool;
    async fn read_text(&self, path: &str) -> Result<String, String>;
    fn current_dir(&self) -> String;
    /// `new Date().toISOString()`.
    fn now_iso(&self) -> String;
}
