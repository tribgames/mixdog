use std::sync::Arc;

use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::admin_route::truthy;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::FencedPatch;
use mixdog_core_ports::ports::threads::RunFence;
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

/// The header fields `bumpSessionGenerationAttempt` records over `recorded`, at `now`
/// (`lifecycle-barriers.mjs:272-283`): the generation moves on without a tombstone, so the record stays
/// resumable; `owner_close` (the agent tool's owner close) also stamps `ownerClosedAt`.
pub(crate) fn detach_fields(recorded: &Map<String, Value>, reason: &str, owner_close: bool, now: i64) -> Map<String, Value> {
    let generation = recorded.get("generation").and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
    let mut fields = Map::new();
    fields.insert("generation".into(), mixdog_js::json_number(generation));
    fields.insert("updatedAt".into(), json!(now));
    fields.insert("detachedReason".into(), json!(reason));
    if owner_close {
        fields.insert("ownerClosedAt".into(), json!(now));
    }
    fields
}

/// The keys a detach computes its fields from (and so expects unchanged when they land).
const DETACH_KEYS: [&str; 5] = ["generation", "updatedAt", "detachedReason", "ownerClosedAt", "closed"];

/// `bumpSessionGenerationAttempt(id, reason, { ownerClose })`: the detach fields written against the header they were
/// computed from. `at`: where the session must stand for the stamp (a close decided for an idle session, a job's cancel
/// for the turn it submitted), which the session's one writer decides ([`Detached::Moved`] otherwise, with nothing
/// written); `None` stamps it wherever it stands.
pub(crate) async fn write_detach(
    threads: &dyn ThreadState,
    thread: &ThreadId,
    reason: &str,
    owner_close: bool,
    now: i64,
    at: Option<&RunFence>,
) -> Result<Detached, PortError> {
    loop {
        let recorded = match threads.header(thread).await {
            Ok(header) => header,
            Err(PortError::NotFound { .. }) => return Ok(Detached::Absent),
            Err(error) => return Err(error),
        };
        let set = detach_fields(&recorded, reason, owner_close, now);
        let expect = DETACH_KEYS.into_iter().map(|key| (key.to_owned(), recorded.get(key).cloned().unwrap_or(Value::Null))).collect();
        let patched = match at {
            Some(at) => threads.patch_header_at(thread, at, expect, set, Vec::new()).await,
            None => threads.patch_header_if(thread, expect, set, Vec::new()).await.map(|conflict| conflict.map_or(FencedPatch::Written, FencedPatch::Conflict)),
        };
        match patched {
            Ok(FencedPatch::Written) => return Ok(Detached::Stamped),
            Ok(FencedPatch::Moved) => return Ok(Detached::Moved),
            // Another write moved the header meanwhile: computed again from what it holds now.
            Ok(FencedPatch::Conflict(_)) => continue,
            Err(PortError::NotFound { .. }) => return Ok(Detached::Absent),
            Err(error) => return Err(error),
        }
    }
}

/// What a [`write_detach`] came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Detached {
    Stamped,
    /// No such session.
    Absent,
    /// The session does not stand where the stamp was decided for: nothing was written.
    Moved,
}

/// `_dropsAgainst(recorder, { expectedGeneration })` (1.4.5 `session/store/write-admission.mjs` `_shouldDrop`, the same rule; a save that finds no file creates it): the record's lifecycle outranks a copy
/// issued for an older ownership. A tombstone at least as new as `expected`, or a generation past it (detached and
/// taken over since), drops the save; a save that names no generation is never dropped.
pub fn drops_against(recorded: &Map<String, Value>, expected: Option<f64>) -> bool {
    let Some(expected) = expected else { return false };
    let generation = recorded.get("generation").and_then(Value::as_f64).unwrap_or(0.0);
    if recorded.get("closed") == Some(&json!(true)) {
        return generation >= expected;
    }
    generation > expected
}

/// What a fenced header write came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Saved {
    Written,
    /// Refused: the record moved past the generation the write was issued for (`SAVE_OUTCOME_DROPPED`).
    Dropped,
}

/// The reason the idle sweep closes with (`markSessionClosed(id, 'idle-sweep', ..)`,
/// `sweep-row.mjs:136`).
pub const IDLE_SWEEP_REASON: &str = "idle-sweep";

/// What a close does to a thread's work: the shells it owns are cancelled
/// (`cancelOwnedShellProcesses`, before the runtime entry is cleared so a close cannot orphan a
/// tree; the kills are not awaited), the running turn ends with `closeSession`'s abort text, the
/// queued input goes (`_dropPendingMessageState`) and its read caches are released
/// (`releaseSessionReadCaches`: pure caches a resumed turn rebuilds; the stored snapshots stay).
/// The queue goes before the abort: an aborted turn that settled before the drop would start the
/// next queued entry. The abort always takes effect (it does not go through the control lane); a
/// turn that ended meanwhile is the only reason it is not delivered.
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

/// [`stop_session_work`] of a thread a close found idle, done only if it still is: decided at the thread's start gate, so a
/// turn either started first (`false`: nothing of the thread is touched) or starts after the close and keeps all of its
/// work. `still` is the caller's own account of the turn the close was decided at. A thread with queued input is about to
/// run it and counts as started. No turn is aborted and no queued input dropped: an idle thread has neither to lose.
pub(crate) fn stop_idle_work(
    directory: &SessionDirectory,
    shells: &dyn OwnedShells,
    read_state: &ReadState,
    thread: &ThreadId,
    reason: &str,
    still: impl FnOnce() -> bool,
) -> bool {
    let handle = directory.handle(thread);
    let stopped = directory.while_idle(thread, || {
        if !still() || handle.as_ref().is_some_and(|handle| !handle.cell.queued.load().is_empty()) {
            return None;
        }
        shells.cancel_owned(thread);
        if let Some(handle) = &handle {
            handle.cell.abort_compaction(&mixdog_agent::cancel::Abort::close_session(thread.as_str(), reason));
        }
        Some(())
    });
    if stopped.is_some() {
        read_state.release_session(thread.as_str());
    }
    stopped.is_some()
}

async fn abort_and_drop(directory: &SessionDirectory, thread: &ThreadId, reason: &str, caller: &'static str) {
    let Some(handle) = directory.handle(thread) else { return };
    handle.cell.abort_compaction(&mixdog_agent::cancel::Abort::close_session(thread.as_str(), reason));
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
        // The only error is a turn that ended since the load above.
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
    pub fn new(directory: Arc<SessionDirectory>, providers: Arc<ProviderRegistry>, shells: Arc<dyn OwnedShells>, read_state: Arc<ReadState>) -> Self {
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
                mixdog_rt::node_stderr!("[agent-close] session={session_id} reason={reason} tombstone=true FAILED durable lifecycle barrier: {error:?}");
                return false;
            }
        }
        self.teardown(&thread, reason, crate::session::turn_ops::SideEnd::Tombstone).await;
        // A closed conversation ends its "Allow for this session" grants.
        self.directory.deps().session_grants.forget(session_id);
        self.directory.deps().deletion.session_ended(session_id);
        true
    }

    /// `closeSession(id, reason, { tombstone: false, ownerClose })`: the generation moves on first
    /// (`bumpSessionGenerationAttempt`), then the work stops as in a tombstoning close. The record stays open and
    /// resumable. True once the bump landed, or when there is no such session; false when it was not written.
    pub async fn detach(&self, session_id: &str, reason: &str, owner_close: bool) -> bool {
        if session_id.is_empty() {
            return false;
        }
        let thread = ThreadId::from(session_id);
        match write_detach(&self.threads, &thread, reason, owner_close, self.directory.deps().clock.now_ms(), None).await {
            Ok(Detached::Stamped) => {}
            Ok(Detached::Absent | Detached::Moved) => return true,
            Err(error) => {
                mixdog_rt::node_stderr!("[agent-close] session={session_id} reason={reason} tombstone=false FAILED durable lifecycle barrier: {error:?}");
                return false;
            }
        }
        self.teardown(&thread, reason, crate::session::turn_ops::SideEnd::Detach).await;
        true
    }

    /// What a landed close (`end`: a tombstone or a detach) does to the runtime: its work stops, its side checkouts and
    /// provider connections go and the actor learns the thread is closed.
    async fn teardown(&self, thread: &ThreadId, reason: &str, end: crate::session::turn_ops::SideEnd) {
        stop_session_work(&self.directory, &*self.shells, &self.read_state, thread, reason, "session-close").await;
        self.directory.deps().side.forget(thread, end);
        self.providers.release_session(thread.as_str());
        self.directory.deps().deletion.release_mcp_scope(thread.as_str());
        if let Some(handle) = self.directory.handle(thread) {
            let (taken, took) = tokio::sync::oneshot::channel();
            if handle.cell.ctl_tx.send(Ctl::Closed(taken)).await.is_ok() {
                // An actor that ends first drops the answer: it is gone either way.
                let _ = took.await;
            }
        }
    }

    async fn mark_closed(&self, thread: &ThreadId, reason: &str) -> Result<bool, PortError> {
        write_close(&self.threads, thread, reason, self.directory.deps().clock.now_ms()).await
    }
}

/// `markSessionClosed(id, reason)`: the tombstone, written against the header it was computed from. `Ok(false)`: no such
/// session.
pub(crate) async fn write_close(threads: &dyn ThreadState, thread: &ThreadId, reason: &str, now: i64) -> Result<bool, PortError> {
    loop {
        let recorded = match threads.header(thread).await {
            Ok(header) => header,
            Err(PortError::NotFound { .. }) => return Ok(false),
            Err(error) => return Err(error),
        };
        let set = tombstone(&recorded, reason, now);
        let expect = ["closed", "status", "generation", "updatedAt", "cancelStatus", "cancelledAt"]
            .into_iter()
            .map(|key| (key.to_owned(), recorded.get(key).cloned().unwrap_or(Value::Null)))
            .collect();
        match threads.patch_header_if(thread, expect, set, Vec::new()).await {
            Ok(None) => return Ok(true),
            // Another write moved the header meanwhile: computed again from what it holds now.
            Ok(Some(_)) => continue,
            Err(PortError::NotFound { .. }) => return Ok(false),
            Err(error) => return Err(error),
        }
    }
}

/// An agent worker's session (`owner: "agent"`, the lead check of `pool-list`: `owner !== 'agent'`). A runtime's own
/// session is never one: the workers are closed by the runtime's `agentTool.closeAll` (`teardown.mjs:231`), which
/// detaches each of them and which `OwnerTeardown` already ran.
pub(super) fn is_worker(header: &Map<String, Value>) -> bool {
    header.get("owner").map(mixdog_js::value_to_string).is_some_and(|owner| mixdog_js::js_trim(&owner).eq_ignore_ascii_case("agent"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An open record drops a save issued for an older generation only; a closed one drops it at an equal generation too; a save
    /// that names no generation is never dropped; a record with no generation stands at 0.
    #[test]
    fn a_save_is_dropped_by_a_record_that_moved_past_its_generation() {
        let record = |generation: Option<f64>, closed: bool| {
            let mut record = Map::new();
            if let Some(generation) = generation {
                record.insert("generation".into(), json!(generation));
            }
            if closed {
                record.insert("closed".into(), json!(true));
            }
            record
        };
        // (record generation, closed, expected generation, dropped)
        let rows: [(Option<f64>, bool, Option<f64>, bool); 14] = [
            (Some(2.0), false, None, false),
            (Some(2.0), false, Some(1.0), true),
            (Some(2.0), false, Some(2.0), false),
            (Some(2.0), false, Some(3.0), false),
            (Some(2.0), true, None, false),
            (Some(2.0), true, Some(1.0), true),
            (Some(2.0), true, Some(2.0), true),
            (Some(2.0), true, Some(3.0), false),
            (None, false, Some(0.0), false),
            (None, false, Some(-1.0), true),
            (None, true, Some(0.0), true),
            (None, true, Some(1.0), false),
            (None, false, None, false),
            (None, true, None, false),
        ];
        for (generation, closed, expected, dropped) in rows {
            assert_eq!(drops_against(&record(generation, closed), expected), dropped, "generation {generation:?}, closed {closed}, expected {expected:?}");
        }
    }

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("an object")
    }

    /// A thread header kept in memory, written the way the session actor writes it: a patch lands only while its
    /// `expect` holds. `conflict_once`: another write moves the header under the first patch.
    #[derive(Default)]
    struct Cell {
        header: std::sync::Mutex<Map<String, Value>>,
        conflict_once: std::sync::atomic::AtomicBool,
    }

    #[async_trait::async_trait]
    impl ThreadState for Cell {
        async fn header(&self, _: &ThreadId) -> Result<mixdog_store::schema::record::Header, PortError> {
            Ok(self.header.lock().unwrap().clone())
        }
        async fn patch_header(&self, _: &ThreadId, set: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
            self.header.lock().unwrap().extend(set);
            Ok(())
        }
        async fn patch_header_at(
            &self,
            thread: &ThreadId,
            at: &RunFence,
            expect: Map<String, Value>,
            set: Map<String, Value>,
            unset: Vec<String>,
        ) -> Result<FencedPatch, PortError> {
            mixdog_core_ports::ports::threads::patch_at_rest(self, thread, at, expect, set, unset).await
        }
        async fn patch_header_if(
            &self,
            _: &ThreadId,
            expect: Map<String, Value>,
            set: Map<String, Value>,
            _: Vec<String>,
        ) -> Result<Option<Map<String, Value>>, PortError> {
            let mut header = self.header.lock().unwrap();
            if self.conflict_once.swap(false, std::sync::atomic::Ordering::SeqCst) {
                header.insert("generation".into(), json!(5));
            }
            let now: Map<String, Value> = expect.keys().map(|key| (key.clone(), header.get(key).cloned().unwrap_or(Value::Null))).collect();
            if now != expect {
                return Ok(Some(now));
            }
            header.extend(set);
            Ok(None)
        }
        async fn store_header(
            &self,
            thread: &ThreadId,
            write: mixdog_core_ports::ports::threads::HeaderWrite,
        ) -> mixdog_core_ports::ports::threads::HeaderStored {
            mixdog_core_ports::ports::threads::HeaderStored::of_patch(self.patch_header(thread, write.set, write.unset).await)
        }
        fn log_identity(&self, _: &ThreadId) -> Option<String> {
            None
        }
        /// This fake holds nothing but the header it answers.
        async fn held_fields(
            &self,
            thread: &ThreadId,
            keys: &'static [&'static str],
        ) -> Result<serde_json::Map<String, serde_json::Value>, mixdog_tools::orch::util::PortError> {
            Ok(mixdog_core_ports::ports::threads::held_of(&self.header(thread).await?, keys))
        }
        async fn publish(&self, _: &ThreadId, _: mixdog_core_ports::ports::threads::Section) -> Result<(), PortError> {
            Ok(())
        }
    }

    /// A detach lands against the header it was computed from (computed again when another write moved it).
    #[tokio::test]
    async fn a_detach_fences_the_save_issued_before_it() {
        let thread = ThreadId::from("sess_a");
        let cell = Cell::default();
        assert_eq!(write_detach(&cell, &thread, "no live session clients", false, 7, None).await.unwrap(), Detached::Stamped);
        let header = cell.header.lock().unwrap().clone();
        assert_eq!(
            Value::Object(header),
            json!({ "generation": 1, "updatedAt": 7, "detachedReason": "no live session clients" }),
            "the fields Node's first detach records"
        );

        cell.conflict_once.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(write_detach(&cell, &thread, "SIGTERM", true, 9, None).await.unwrap(), Detached::Stamped);
        let header = cell.header.lock().unwrap().clone();
        assert_eq!((header["generation"].clone(), header["ownerClosedAt"].clone()), (json!(6), json!(9)), "computed again from the header another write moved");
    }

    /// `markSessionClosedAttempt`'s first close, re-close and cancel status rule.
    #[test]
    fn the_tombstone_is_nodes_first_close_and_re_close() {
        let first = tombstone(&obj(json!({ "generation": 2, "updatedAt": 5 })), "heartbeat-finished", 90);
        assert_eq!(Value::Object(first), json!({ "closed": true, "closedReason": "heartbeat-finished", "status": "closed", "generation": 3, "updatedAt": 90 }));
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

/// The idle sweep's close (`closeIdleRecord`, `sweep-row.mjs:134-163`): `markSessionClosed` with
/// `isSessionLive` and `singleAttempt`, which tombstones the record and lands nothing (`null`)
/// when a runtime holds the session or a commit of it is still landing. Here the thread's own
/// admission is the one the retention delete uses (`close_for_delete` with its `guard`): in the
/// one step that closes the thread it re-asks that nothing is running or queued, that nobody is
/// or ever was attached, that the activity the pass read has not moved and that the sweep is not
/// shut down; any refusal is `Ok(false)` and nothing changes. The tombstone is then appended as
/// the thread's last record (the tombstone the close path writes, [`tombstone`]) and the thread
/// leaves the directory. `Ok(false)` too for a session the catalog does not list.
pub(crate) async fn close_idle(
    directory: &super::directory::DirInner,
    id: &str,
    guard: super::control::DeleteGuard,
) -> Result<bool, mixdog_core_api::CoreError> {
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
    deps.side.forget(&thread, super::turn_ops::SideEnd::Tombstone);
    deps.deletion.release_mcp_scope(id);
    deps.session_grants.forget(id);
    deps.deletion.session_ended(id);
    Ok(true)
}

/// Teardown's `closeOwnSession` (`teardown/session-close.mjs:42-60`): the session a runtime holds is closed with the
/// stop's reason, tombstoned while it is an empty scratch session and detached otherwise. A worker session is not
/// the runtime's own: the agents' close already detached it, and it gets no second bump.
#[async_trait::async_trait]
impl super::directory::ExitClose for SessionClose {
    async fn close_on_exit(&self, thread: &ThreadId, reason: &str) {
        let header = match self.threads.header(thread).await {
            Ok(header) if is_worker(&header) => return,
            Ok(header) => header,
            Err(PortError::NotFound { .. }) => return,
            Err(error) => {
                tracing::warn!("[session-close] {thread}: its header could not be read at exit: {error:?}");
                return;
            }
        };
        let committed = match mixdog_core_ports::ports::memory_source::ThreadMessages::messages(&self.threads, thread).await {
            Ok(messages) => messages,
            Err(PortError::NotFound { .. }) => return,
            Err(error) => {
                tracing::warn!("[session-close] {thread}: its messages could not be read at exit: {error:?}");
                return;
            }
        };
        if header.get("closed") != Some(&Value::Bool(true))
            && let Some(handle) = self.directory.handle(thread)
            && !handle.cell.session_ended.swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            let (hooks, ended_thread, end_reason) = (self.directory.deps().lifecycle.clone(), thread.clone(), mixdog_mcp::hooks::session_end_reason(reason));
            let ended = tokio::spawn(async move { hooks.session_end(&ended_thread, &header, end_reason).await });
            let _ = mixdog_rt::time::timeout(super::lifecycle_hooks::SESSION_END_WAIT, ended).await;
        }
        let live: Vec<Value> = self.directory.handle(thread).map(|handle| handle.turn_messages_snapshot()).unwrap_or_default();
        let closed = if super::thread_switches::is_scratch(thread.as_str(), &committed, &live) {
            self.close(thread.as_str(), reason).await
        } else {
            self.detach(thread.as_str(), reason, false).await
        };
        if !closed {
            tracing::warn!("[session-close] {thread}: not closed at exit (reason={reason})");
        }
    }
}
