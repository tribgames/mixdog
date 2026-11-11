//! A session as the task-report watchers see it (`materializeSession` / `runtime.getState()` /
//! `runtime.subscribe` / `loadSession(id).messages`, `agent-task-sessions.mjs`): whether a turn
//! runs, the submissions queued behind it, a signal on every turn start and end, and the stored
//! model messages.

use std::sync::Arc;

use mixdog_agent::agent_tool::flow::seams::{TurnListener, TurnOutcome, TurnSource, TurnStart};
use mixdog_core_api::CoreError;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::ThreadId;
use mixdog_services::task_reports::follow::RuntimeView;
use serde_json::Value;
use tokio::sync::mpsc;

use super::SessionDirectory;
use super::SessionHandle;

/// The runtime view of a loaded session.
struct HandleRuntime {
    handle: Arc<SessionHandle>,
    directory: Arc<SessionDirectory>,
}

/// Forwards each turn start and end of the session to the subscriber.
struct Changes(mpsc::UnboundedSender<()>);

impl TurnListener for Changes {
    fn turn_started(&self, _: TurnStart) {
        let _ = self.0.send(());
    }

    fn turn_settled(&self, _: TurnOutcome) {
        let _ = self.0.send(());
    }
}

impl RuntimeView for HandleRuntime {
    /// `state.busy`: a turn runs.
    fn busy(&self) -> bool {
        self.handle.cell.run.load().is_some()
    }

    /// `state.queued[].id`: the client submission ids of the entries queued behind the turn.
    fn queued_ids(&self) -> Vec<String> {
        self.handle
            .cell
            .queue
            .load()
            .iter()
            .filter_map(|queued| queued.entry.pointer("/options/clientSubmissionId").and_then(Value::as_str).map(str::to_owned))
            .collect()
    }

    /// `state.toolApproval.id` ([`super::room_approval::tool_approval`]'s id).
    fn tool_approval_id(&self) -> Option<String> {
        let shown = self.handle.cell.shown_approval.load_full()?;
        Some(mixdog_js::value_to_string(&super::room_approval::tool_approval(&shown)["id"]))
    }

    /// `runtime.subscribe`: a message when a turn starts or ends and when the approval the session
    /// shows changes; the observation ends once the receiver is dropped.
    fn subscribe(&self) -> mpsc::UnboundedReceiver<()> {
        let (tx, rx) = mpsc::unbounded_channel();
        let (watched, approvals) = (tx.clone(), tx.clone());
        let mut shown = self.handle.cell.shown_changed.subscribe();
        let unobserve = self.directory.observe_session_turns(self.handle.id.as_str(), Arc::new(Changes(tx)));
        drop(mixdog_rt::spawn("task-report-subscription", mixdog_rt::TaskClass::Work, async move {
            loop {
                tokio::select! {
                    () = watched.closed() => break,
                    changed = shown.changed() => {
                        if changed.is_err() || approvals.send(()).is_err() {
                            break;
                        }
                    }
                }
            }
            if let Some(unobserve) = unobserve {
                unobserve();
            }
        }));
        rx
    }
}

impl SessionDirectory {
    /// `service.materializeSession(id)` as a runtime view: the session opened here; `Err` when it
    /// cannot be opened.
    pub async fn report_runtime(self: &Arc<Self>, id: &ThreadId) -> Result<Arc<dyn RuntimeView>, CoreError> {
        let handle = self.open_handle(id, &CallContext::internal("task-report")).await?;
        Ok(Arc::new(HandleRuntime { handle, directory: self.clone() }))
    }

    /// `loadSession(id)?.messages`: the session's stored model messages; `None` when it does not
    /// exist.
    pub async fn session_messages(&self, id: &ThreadId) -> Result<Option<Vec<Value>>, CoreError> {
        if self.try_stored_header(id).await?.is_none() {
            return Ok(None);
        }
        let mut rows = self.rows_of(id.as_str()).await?;
        // Node names a turn's first row by its submission id (`checkpointId: options.id`,
        // snapshot-tracker.mjs), which the core keeps as `clientSubmissionId` beside the item's own.
        for row in &mut rows {
            if let Some(meta) = row.pointer_mut("/meta/transcript").and_then(Value::as_object_mut)
                && meta.contains_key("checkpointId")
                && let Some(submission) = meta.get("clientSubmissionId").filter(|id| id.as_str().is_some_and(|id| !id.is_empty())).cloned()
            {
                meta.insert("checkpointId".into(), submission);
            }
        }
        Ok(Some(rows))
    }
}
