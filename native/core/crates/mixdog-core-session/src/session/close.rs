//! `closeSession(id, reason)` with its tombstone (1.4.5 `session-close.mjs`,
//! `store/lifecycle-barriers.mjs` `markSessionClosedAttempt`): the durable tombstone first, and
//! only once it landed the running turn is aborted, the queued input dropped, the provider
//! connections closed and the runtime cleared. A tombstone that did not land changes nothing
//! else.

use std::sync::Arc;

use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::admin_route::truthy;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_tools::fs::ReadState;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::control::Ctl;
use super::delete::DELETE_REASON;
use super::shell_jobs::OwnedShells;
use super::thread_state::SessionThreads;

/// `_CANCEL_CLOSE_REASON`: a close that is an agent cancel records its cancel status.
fn cancel_close_reason(reason: &str) -> bool {
    let reason = mixdog_js::js_trim(reason).to_ascii_lowercase();
    matches!(reason.as_str(), "cli-agent-close" | "cli-agent-close-all" | "agent-task-cancel")
}

/// `_CANCEL_UNCONFIRMED_STATUS`: `cancel`, an optional `-`, `_` or blank, then `unconfirmed`
/// or `pending`, in any case.
fn unconfirmed_status(status: &str) -> bool {
    let lower = status.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("cancel") else { return false };
    let rest = rest.strip_prefix(|c: char| c == '-' || c == '_' || mixdog_js::is_js_space(c)).unwrap_or(rest);
    rest == "unconfirmed" || rest == "pending"
}

/// `_cancelStatusFields(base, reason, undefined, closeTime)`: an unconfirmed stop outranks
/// a confirmed one; the first cancel time stays.
fn cancel_status_fields(base: &Map<String, Value>, reason: &str, close_time: &Value, fields: &mut Map<String, Value>) {
    if !cancel_close_reason(reason) {
        return;
    }
    let recorded = base.get("cancelStatus").filter(|v| truthy(Some(v))).map(mixdog_js::value_to_string).unwrap_or_default();
    let recorded = mixdog_js::js_trim(&recorded);
    let status = if unconfirmed_status(recorded) {
        "cancel-unconfirmed"
    } else if recorded.is_empty() {
        "cancelled"
    } else {
        recorded
    };
    fields.insert("cancelStatus".into(), json!(status));
    let at = base.get("cancelledAt").filter(|v| truthy(Some(v))).cloned().unwrap_or_else(|| close_time.clone());
    fields.insert("cancelledAt".into(), at);
}

/// The header fields `markSessionClosedAttempt` records over `recorded`, at `now`.
fn tombstone(recorded: &Map<String, Value>, reason: &str, now: i64) -> Map<String, Value> {
    let mut fields = Map::new();
    fields.insert("closed".into(), json!(true));
    let already = recorded.get("closed") == Some(&json!(true)) || recorded.get("status") == Some(&json!("closed"));
    if already {
        // Re-close: the tombstone keeps its original close time and generation.
        let close_time = recorded.get("updatedAt").filter(|at| at.as_f64().is_some_and(|at| at > 0.0)).cloned();
        fields.insert("status".into(), json!("closed"));
        if reason == DELETE_REASON {
            fields.insert("closedReason".into(), json!(reason));
        }
        cancel_status_fields(recorded, reason, &close_time.unwrap_or_else(|| json!(now)), &mut fields);
        return fields;
    }
    let generation = recorded.get("generation").and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
    fields.insert("closedReason".into(), json!(reason));
    fields.insert("status".into(), json!("closed"));
    fields.insert("generation".into(), mixdog_js::json_number(generation));
    fields.insert("updatedAt".into(), json!(now));
    cancel_status_fields(recorded, reason, &json!(now), &mut fields);
    fields
}

/// The reason the idle sweep closes with (`markSessionClosed(id, 'idle-sweep', ..)`,
/// `sweep-row.mjs:136`).
pub const IDLE_SWEEP_REASON: &str = "idle-sweep";

/// The idle sweep's close (`closeIdleRecord`, `sweep-row.mjs:134-163`): `markSessionClosed` with
/// `isSessionLive` and `singleAttempt`, which tombstones the record and lands nothing (`null`)
/// when a runtime holds the session or a commit of it is still landing. Here the thread's own
/// admission is the one the retention delete uses (`close_for_delete` with its `guard`): in the
/// one step that closes the thread it re-asks that nothing is running or queued, that nobody is
/// or ever was attached, that the activity the pass read has not moved and that the sweep is not
/// shut down; any refusal is `Ok(false)` and nothing changes. The tombstone is then appended as
/// the thread's last record (the tombstone the close path writes, [`tombstone`]) and the thread
/// leaves the directory. `Ok(false)` too for a session the catalog does not list.
pub(crate) async fn close_idle(directory: &super::directory::DirInner, id: &str, guard: super::control::DeleteGuard) -> Result<bool, mixdog_core_api::CoreError> {
    let id = mixdog_js::js_trim(id);
    if !super::delete::is_session_id(id) {
        return Ok(false);
    }
    let thread = ThreadId::from(id);
    let deps = directory.deps().clone();
    if deps.store.session_meta(&thread).await?.is_none() {
        return Ok(false);
    }
    let abort = mixdog_agent::cancel::Abort::close_session(id, IDLE_SWEEP_REASON);
    let Ok(hold) = directory.close_for_delete(&thread, &abort, true, Some(guard)).await? else {
        return Ok(false);
    };
    let header = hold.header();
    let at = deps.clock.now_ms();
    if !hold.append(directory, tombstone(&header, IDLE_SWEEP_REASON, at)).await {
        return Ok(false);
    }
    // `_logSessionCloseMetric`, once the tombstone is acknowledged.
    deps.deletion.session_closed(id, IDLE_SWEEP_REASON, &header, at);
    Ok(true)
}

/// What a close does to a thread's work: the shells it owns are cancelled
/// (`cancelOwnedShellProcesses`, before the runtime entry is cleared so a close cannot orphan a
/// tree; the kills are not awaited), the running turn ends with `closeSession`'s abort text, the
/// queued input goes (`_dropPendingMessageState`) and its read caches are released
/// (`releaseSessionReadCaches`: pure caches a resumed turn rebuilds; the stored snapshots stay).
/// The queue goes before the abort: an aborted turn that settled before the drop would start the
/// next queued entry.
pub(crate) async fn stop_session_work(
    directory: &SessionDirectory,
    shells: &dyn OwnedShells,
    read_state: &ReadState,
    thread: &ThreadId,
    reason: &str,
    caller: &'static str,
) {
    shells.cancel_owned(thread);
    abort_and_drop(directory, thread, reason, caller).await;
    read_state.release_session(thread.as_str());
}

async fn abort_and_drop(directory: &SessionDirectory, thread: &ThreadId, reason: &str, caller: &'static str) {
    let Some(handle) = directory.handle(thread) else { return };
    let queued: Vec<String> = handle.cell.queued.load().iter().cloned().collect();
    for queued_id in queued {
        let op = format!("{caller}:{queued_id}:drop");
        let request = CoreRequest {
            method: Method("thread/queue/delete"),
            params: json!({ "threadId": thread, "opId": op, "queuedId": queued_id, "restore": false }),
            op: Some(OpId::from(op)),
            ctx: CallContext::internal(caller),
        };
        if let Err(error) = handle.request(request).await {
            tracing::warn!(thread = %thread, "a queued entry was not dropped at close: {error:?}");
        }
    }
    if let Some(run) = handle.cell.run.load_full() {
        let _ = handle.cell.abort(&run.turn, &mixdog_agent::cancel::Abort::close_session(thread.as_str(), reason));
    }
}

/// The tombstoning close of the session runtime.
pub struct SessionClose {
    directory: Arc<SessionDirectory>,
    threads: SessionThreads,
    providers: Arc<ProviderRegistry>,
    shells: Arc<dyn OwnedShells>,
    read_state: Arc<ReadState>,
}

impl SessionClose {
    /// `providers`: the process's provider registry (`closeProviderConnections`); `shells`: the
    /// shell runtime; `read_state`: the one read state of the read, edit and apply_patch tools.
    pub fn new(
        directory: Arc<SessionDirectory>,
        providers: Arc<ProviderRegistry>,
        shells: Arc<dyn OwnedShells>,
        read_state: Arc<ReadState>,
    ) -> Self {
        Self { threads: SessionThreads::new(directory.clone()), directory, providers, shells, read_state }
    }

    /// `closeSession(id, reason)`: true once the tombstone landed, or when there is no such
    /// session (nothing is left to close); false when no tombstone was written.
    pub async fn close(&self, session_id: &str, reason: &str) -> bool {
        if session_id.is_empty() {
            return false;
        }
        let thread = ThreadId::from(session_id);
        match self.mark_closed(&thread, reason).await {
            Ok(true) => {}
            Ok(false) => return true,
            Err(error) => {
                tracing::warn!("[agent-close] session={session_id} reason={reason} tombstone=true FAILED durable lifecycle barrier: {error:?}");
                return false;
            }
        }
        stop_session_work(&self.directory, &*self.shells, &self.read_state, &thread, reason, "session-close").await;
        self.directory.deps().side.forget(&thread, true);
        self.providers.release_session(session_id);
        if let Some(handle) = self.directory.handle(&thread) {
            let _ = handle.cell.ctl_tx.send(Ctl::Closed).await;
        }
        true
    }

    /// The tombstone, written against the header it was computed from; `Ok(false)`: absent.
    async fn mark_closed(&self, thread: &ThreadId, reason: &str) -> Result<bool, PortError> {
        loop {
            let recorded = match self.threads.header(thread).await {
                Ok(header) => header,
                Err(PortError::NotFound { .. }) => return Ok(false),
                Err(error) => return Err(error),
            };
            let set = tombstone(&recorded, reason, self.directory.deps().clock.now_ms());
            let expect = ["closed", "status", "generation", "updatedAt", "cancelStatus", "cancelledAt"]
                .into_iter()
                .map(|key| (key.to_owned(), recorded.get(key).cloned().unwrap_or(Value::Null)))
                .collect();
            match self.threads.patch_header_if(thread, expect, set, Vec::new()).await {
                Ok(None) => return Ok(true),
                // Another write moved the header meanwhile: computed again from what it holds now.
                Ok(Some(_)) => continue,
                Err(PortError::NotFound { .. }) => return Ok(false),
                Err(error) => return Err(error),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("an object")
    }

    /// `markSessionClosedAttempt`'s first close, re-close and cancel status rule.
    #[test]
    fn the_tombstone_is_nodes_first_close_and_re_close() {
        let first = tombstone(&obj(json!({ "generation": 2, "updatedAt": 5 })), "heartbeat-finished", 90);
        assert_eq!(
            Value::Object(first),
            json!({ "closed": true, "closedReason": "heartbeat-finished", "status": "closed", "generation": 3, "updatedAt": 90 })
        );
        let again = tombstone(&obj(json!({ "closed": true, "generation": 3, "updatedAt": 90 })), "manual", 120);
        assert_eq!(Value::Object(again), json!({ "closed": true, "status": "closed" }));
        let deleted = tombstone(&obj(json!({ "status": "closed", "updatedAt": 90 })), DELETE_REASON, 120);
        assert_eq!(Value::Object(deleted), json!({ "closed": true, "status": "closed", "closedReason": DELETE_REASON }));
        let cancel = tombstone(&obj(json!({})), " Agent-Task-Cancel ", 7);
        assert_eq!((cancel["cancelStatus"].clone(), cancel["cancelledAt"].clone(), cancel["generation"].clone()), (json!("cancelled"), json!(7), json!(1)));
        let kept = tombstone(&obj(json!({ "closed": true, "updatedAt": 40, "cancelStatus": "Cancel pending" })), "cli-agent-close", 99);
        assert_eq!((kept["cancelStatus"].clone(), kept["cancelledAt"].clone()), (json!("cancel-unconfirmed"), json!(40)));
    }
}
