//! The production [`WorkspaceHost`]: the session record side of a workspace change over the
//! session directory (Node's `applyResolvedCwd` + `persistProjectSelection`, `stageWorkspaceReroot`
//! of `refreshSessionWorkspaceContext`, `persistSession`), and the live-runtime reads and effects
//! the session crate does not own (agent registry, shell jobs, prompt blocks, the Lead pool row)
//! behind [`HostRuntime`], which the composition implements over them.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_rt::CancellationToken;
use mixdog_scm::error::ScmFailure;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::session::SessionDirectory;
use super::worktree_host::JobCwd;
use super::worktree_host::LeadActivity;
use super::worktree_host::LiveSession;
use super::worktree_host::SessionView;
use super::worktree_host::Undo;
use super::worktree_host::WorkspaceChange;
use super::worktree_host::WorkspaceHost;
use super::worktree_reroot::pending_workspace_reroot;
use super::worktree_setup::WorktreeSetup;
use super::worktree_state::plain;
use super::worktree_state::same_path;

/// The slices of the prompt a new workspace brings (`buildWorkspacePromptContext` and the Lead's
/// core memory); `None` keeps what the prompt has.
#[derive(Clone, Debug, Default)]
pub struct WorkspaceContext {
    pub environment_context: Option<String>,
    pub core_memory_context: Option<String>,
    pub instruction_files_context: Option<String>,
}

/// What the live runtime owns.
#[async_trait]
pub trait HostRuntime: Send + Sync + 'static {
    /// A Lead session this runtime hosts.
    async fn is_lead(&self, session_id: &str) -> bool;
    /// A conversation session (a Lead or a bot chat).
    async fn attended(&self, session_id: &str) -> bool;
    /// The cwd the session's tools run in.
    fn runtime_cwd(&self, session_id: &str) -> String;
    /// The session has a user conversation message (`hasUserConversationMessage`).
    fn has_messages(&self, session_id: &str) -> bool;
    /// Retarget the runtime cwd, the cwd override, the last-session cwd and the Lead's pool row.
    async fn set_runtime_cwd(&self, session_id: &str, cwd: &str) -> Result<(), ScmFailure>;
    /// The prompt's `presentedWorkspace`: `{cwd, environmentContext, coreMemoryContext,
    /// instructionFilesContext}`.
    async fn presented_workspace(&self, session_id: &str) -> Value;
    /// The slices the prompt gets at `cwd`; resets the read state and observed-file snapshots. Reading them runs lane jobs; one that is dropped is a typed
    /// failure, never an empty context.
    async fn workspace_context(&self, session_id: &str, cwd: &str) -> Result<WorkspaceContext, ScmFailure>;
    /// Re-root the prompt of a session without a conversation in place; the undo puts it back.
    async fn reroot_prompt(&self, session_id: &str, cwd: &str, context: &WorkspaceContext) -> Result<Undo, ScmFailure>;
    async fn activity(&self, session_id: &str) -> LeadActivity;
    fn live_sessions(&self) -> Vec<LiveSession>;
    /// [`StoredConsumers::list`](super::worktree_consumers::StoredConsumers::list).
    async fn stored_consumers(&self) -> Result<Vec<LiveSession>, ScmFailure>;
    async fn running_jobs(&self) -> Vec<JobCwd>;
    async fn shell_job_count(&self, session_ids: &[String]) -> u64;
    /// `copyProjectIdentity`: writes `<worktree>/.mixdog/project.id` unless it holds data.
    async fn copy_project_identity(&self, project_path: &str, worktree_path: &str) -> Result<bool, ScmFailure>;
}

/// `stageWorkspaceReroot`: the state kept on a session that already has a conversation, so its
/// system prompt stays byte-identical. `prior` is the state staged before.
pub fn staged_reroot(prior: Option<&Value>, presented: &Value, cwd: &str, context: &WorkspaceContext, from: Option<(&str, Option<&str>)>) -> Value {
    let truthy = |v: &Value| !matches!(v, Value::Null | Value::Bool(false)) && v.as_str().is_none_or(|s| !s.is_empty());
    let prior = prior.filter(|p| truthy(p));
    let seen = prior.and_then(|p| p.get("seen")).cloned().unwrap_or_else(|| presented.clone());
    let mut target = prior.and_then(|p| p.get("target")).and_then(Value::as_object).cloned().unwrap_or_default();
    target.insert("cwd".into(), Value::String(mixdog_js::js_trim(cwd).to_owned()));
    for (key, slice) in [
        ("environmentContext", &context.environment_context),
        ("coreMemoryContext", &context.core_memory_context),
        ("instructionFilesContext", &context.instruction_files_context),
    ] {
        if let Some(slice) = slice {
            target.insert(key.into(), Value::String(mixdog_js::js_trim(slice).to_owned()));
        }
    }
    // The move into a worktree belongs to this change only; a later one drops it.
    target.shift_remove("move");
    if let Some((from, changes)) = from.filter(|(from, _)| !mixdog_js::js_trim(from).is_empty()) {
        target.insert("move".into(), json!({ "from": mixdog_js::js_trim(from), "changes": changes }));
    }
    let revision = prior.and_then(|p| p.get("revision")).and_then(Value::as_f64).filter(|n| *n != 0.0).unwrap_or(0.0) + 1.0;
    let root_cwd = match prior {
        Some(p) => p.get("rootCwd").cloned().unwrap_or(Value::Null),
        None => seen.get("cwd").cloned().unwrap_or(Value::Null),
    };
    json!({ "version": 1, "revision": revision as u64, "rootCwd": root_cwd, "seen": seen, "target": target })
}

/// The header keys a workspace change writes.
const KEYS: [&str; 5] = ["cwd", "workspace", "desktopSession", "workspaceReroot", "pendingSetupNotice"];

pub struct SessionWorkspaceHost {
    directory: Arc<SessionDirectory>,
    threads: Arc<dyn ThreadState>,
    runtime: Arc<dyn HostRuntime>,
    setup: Arc<WorktreeSetup>,
    /// `set_workspace`: the in-memory record until `apply` lands the stored one.
    marker: Arc<Mutex<HashMap<String, Option<Value>>>>,
}

pub(super) fn port(error: impl std::fmt::Debug) -> ScmFailure {
    plain(format!("{error:?}"))
}

fn undo_with(run: impl std::future::Future<Output = Result<(), ScmFailure>> + Send + 'static) -> Undo {
    Box::new(move || Box::pin(run))
}

impl SessionWorkspaceHost {
    pub fn new(directory: Arc<SessionDirectory>, threads: Arc<dyn ThreadState>, runtime: Arc<dyn HostRuntime>, setup: Arc<WorktreeSetup>) -> Self {
        Self { directory, threads, runtime, setup, marker: Arc::default() }
    }

    fn header(&self, session_id: &str) -> Option<Arc<mixdog_store::schema::record::Header>> {
        self.directory.handle(&ThreadId::from(session_id)).map(|handle| handle.cell.header.load_full())
    }

    /// Set `set`, unset `unset`: one durable header patch. Rejects when the save fails.
    async fn save(&self, session_id: &str, set: Map<String, Value>, unset: Vec<String>) -> Result<(), ScmFailure> {
        self.threads.patch_header(&ThreadId::from(session_id), set, unset).await.map_err(port)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Option<Value>>> {
        self.marker.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[async_trait]
impl WorkspaceHost for SessionWorkspaceHost {
    async fn is_lead(&self, session_id: &str) -> bool {
        self.runtime.is_lead(session_id).await
    }

    async fn attended(&self, session_id: &str) -> bool {
        self.runtime.attended(session_id).await
    }

    fn session(&self, session_id: &str) -> Option<SessionView> {
        let header = self.header(session_id)?;
        let text = |key: &str| header.get(key).and_then(Value::as_str).map(str::to_owned);
        let desktop_project = header
            .get("desktopSession")
            .filter(|d| d.get("classification").and_then(Value::as_str) == Some("project"))
            .and_then(|d| d.get("projectPath"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let workspace = match self.lock().get(session_id) {
            Some(marker) => marker.clone(),
            None => header.get("workspace").cloned(),
        };
        Some(SessionView {
            cwd: text("cwd"),
            runtime_cwd: self.runtime.runtime_cwd(session_id),
            workspace,
            desktop_project,
            has_messages: self.runtime.has_messages(session_id),
        })
    }

    fn set_workspace(&self, session_id: &str, workspace: Option<Value>) {
        self.lock().insert(session_id.to_owned(), workspace);
    }

    async fn activity(&self, session_id: &str) -> LeadActivity {
        self.runtime.activity(session_id).await
    }

    fn live_sessions(&self) -> Vec<LiveSession> {
        self.runtime.live_sessions()
    }

    async fn stored_consumers(&self) -> Result<Vec<LiveSession>, ScmFailure> {
        self.runtime.stored_consumers().await
    }

    async fn running_jobs(&self) -> Vec<JobCwd> {
        self.runtime.running_jobs().await
    }

    async fn shell_job_count(&self, session_ids: &[String]) -> u64 {
        self.runtime.shell_job_count(session_ids).await
    }

    async fn apply(&self, session_id: &str, change: WorkspaceChange) -> Result<Undo, ScmFailure> {
        let header = self.header(session_id).ok_or_else(|| plain("session: the session is not loaded"))?;
        let prior_cwd = self.runtime.runtime_cwd(session_id);
        let prior_keys: Vec<(&'static str, Option<Value>)> = KEYS.iter().map(|key| (*key, header.get(*key).cloned())).collect();
        // A Project switch to the folder the session already runs in stores only the record and
        // the classification.
        let moves = !same_path(&prior_cwd, &change.cwd);
        let mut set = Map::new();
        let mut unset = Vec::new();
        set.insert("cwd".into(), Value::String(change.cwd.clone()));
        if change.workspace.is_null() {
            unset.push("workspace".to_owned());
        } else {
            set.insert("workspace".into(), change.workspace.clone());
        }
        if let Some(desktop) = change.desktop_session.clone() {
            set.insert("desktopSession".into(), desktop);
        }
        let mut undos: Vec<Undo> = Vec::new();
        if moves {
            self.runtime.set_runtime_cwd(session_id, &change.cwd).await?;
            let (runtime, id, back) = (self.runtime.clone(), session_id.to_owned(), prior_cwd.clone());
            undos.push(undo_with(async move { runtime.set_runtime_cwd(&id, &back).await }));
            let context = match self.runtime.workspace_context(session_id, &change.cwd).await {
                Ok(context) => context,
                Err(error) => {
                    run_undos(undos).await;
                    return Err(error);
                }
            };
            if self.runtime.has_messages(session_id) {
                let presented = self.runtime.presented_workspace(session_id).await;
                let from = change.moved.as_ref().map(|m| (m.from.as_str(), m.changes.as_deref()));
                let staged = staged_reroot(header.get("workspaceReroot"), &presented, &change.cwd, &context, from);
                set.insert("workspaceReroot".into(), staged);
            } else {
                match self.runtime.reroot_prompt(session_id, &change.cwd, &context).await {
                    Ok(undo) => undos.push(undo),
                    Err(error) => {
                        run_undos(undos).await;
                        return Err(error);
                    }
                }
                if pending_workspace_reroot(&header).is_some() {
                    unset.push("workspaceReroot".to_owned());
                }
            }
        }
        if let Err(error) = self.save(session_id, set, unset).await {
            run_undos(undos).await;
            return Err(error);
        }
        self.lock().remove(session_id);
        let (threads, id) = (self.threads.clone(), ThreadId::from(session_id));
        let marker = self.marker.clone();
        let session = session_id.to_owned();
        Ok(Box::new(move || {
            Box::pin(async move {
                run_undos(undos).await;
                let mut set = Map::new();
                let mut unset = Vec::new();
                for (key, value) in prior_keys {
                    match value {
                        Some(value) => {
                            set.insert(key.to_owned(), value);
                        }
                        None => unset.push(key.to_owned()),
                    }
                }
                threads.patch_header(&id, set, unset).await.map_err(port)?;
                marker.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&session);
                Ok(())
            })
        }))
    }

    async fn copy_project_identity(&self, project_path: &str, worktree_path: &str) -> Result<bool, ScmFailure> {
        self.runtime.copy_project_identity(project_path, worktree_path).await
    }

    async fn run_pending_setup(&self, session_id: &str, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        let workspace = self.session(session_id).and_then(|view| view.workspace);
        let run = self.setup.run_pending(session_id, workspace.as_ref(), cancel).await?;
        if let Some(notice) = run.notice {
            let mut set = Map::new();
            set.insert("pendingSetupNotice".into(), json!({ "revision": notice.revision, "content": notice.content }));
            self.save(session_id, set, Vec::new()).await?;
        }
        if run.cancelled {
            return Err(ScmFailure::Cancelled);
        }
        Ok(())
    }
}

/// Newest first, each one's failure left to the caller's own error.
async fn run_undos(mut undos: Vec<Undo>) {
    while let Some(undo) = undos.pop() {
        if let Err(error) = undo().await {
            tracing::warn!("[mixdog-session] a workspace undo failed: {error:?}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The values `refreshSessionWorkspaceContext` of the Node prompt-utils staged for the same
    /// two changes of a session with a conversation (recorded by running Node 1.4.5).
    #[test]
    fn staging_twice_keeps_what_was_seen_and_drops_the_earlier_move() {
        let presented = json!({ "cwd": null, "environmentContext": "", "coreMemoryContext": "", "instructionFilesContext": "" });
        let first_context = WorkspaceContext {
            environment_context: Some(" env ".into()),
            core_memory_context: Some(String::new()),
            instruction_files_context: None,
        };
        let first = staged_reroot(None, &presented, " C:/wt ", &first_context, Some(("C:/repo", Some("carried"))));
        assert_eq!(
            first,
            json!({
                "version": 1, "revision": 1, "rootCwd": null, "seen": presented,
                "target": { "cwd": "C:/wt", "environmentContext": "env", "coreMemoryContext": "", "move": { "from": "C:/repo", "changes": "carried" } }
            })
        );
        let second_context = WorkspaceContext { instruction_files_context: Some(" ins ".into()), ..WorkspaceContext::default() };
        let second = staged_reroot(Some(&first), &json!({ "cwd": "elsewhere" }), "C:/wt2", &second_context, None);
        assert_eq!(
            second,
            json!({
                "version": 1, "revision": 2, "rootCwd": null, "seen": presented,
                "target": { "cwd": "C:/wt2", "environmentContext": "env", "coreMemoryContext": "", "instructionFilesContext": "ins" }
            })
        );
    }
}
