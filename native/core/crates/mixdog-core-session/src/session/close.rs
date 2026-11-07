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
/// computed from. `Ok(false)`: no such session.
pub(crate) async fn write_detach(threads: &dyn ThreadState, thread: &ThreadId, reason: &str, owner_close: bool, now: i64) -> Result<bool, PortError> {
    loop {
        let recorded = match threads.header(thread).await {
            Ok(header) => header,
            Err(PortError::NotFound { .. }) => return Ok(false),
            Err(error) => return Err(error),
        };
        let set = detach_fields(&recorded, reason, owner_close, now);
        let expect = DETACH_KEYS.into_iter().map(|key| (key.to_owned(), recorded.get(key).cloned().unwrap_or(Value::Null))).collect();
        match threads.patch_header_if(thread, expect, set, Vec::new()).await {
            Ok(None) => return Ok(true),
            // Another write moved the header meanwhile: computed again from what it holds now.
            Ok(Some(_)) => continue,
            Err(PortError::NotFound { .. }) => return Ok(false),
            Err(error) => return Err(error),
        }
    }
}

/// `_dropsAgainst(recorder, { expectedGeneration })` (`store.mjs:149-153`): the record's lifecycle outranks a copy
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

/// A header write issued for `expected_generation` (`saveSessionAsync(session, { expectedGeneration })`): refused
/// when the record is past that generation ([`drops_against`]), judged against the header the write then lands on.
pub async fn patch_header_fenced(
    threads: &dyn ThreadState,
    thread: &ThreadId,
    expected_generation: Option<f64>,
    set: Map<String, Value>,
    unset: Vec<String>,
) -> Result<Saved, PortError> {
    loop {
        let recorded = threads.header(thread).await?;
        if drops_against(&recorded, expected_generation) {
            return Ok(Saved::Dropped);
        }
        let expect = ["generation", "closed"].into_iter().map(|key| (key.to_owned(), recorded.get(key).cloned().unwrap_or(Value::Null))).collect();
        match threads.patch_header_if(thread, expect, set.clone(), unset.clone()).await? {
            None => return Ok(Saved::Written),
            // The lifecycle moved meanwhile: judged again against it.
            Some(_) => continue,
        }
    }
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
        self.teardown(&thread, reason).await;
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
        match write_detach(&self.threads, &thread, reason, owner_close, self.directory.deps().clock.now_ms()).await {
            Ok(true) => {}
            Ok(false) => return true,
            Err(error) => {
                tracing::warn!("[agent-close] session={session_id} reason={reason} tombstone=false FAILED durable lifecycle barrier: {error:?}");
                return false;
            }
        }
        self.teardown(&thread, reason).await;
        true
    }

    /// What a landed close does to the runtime: its work stops, its side checkouts and provider
    /// connections go and the actor learns the thread is closed.
    async fn teardown(&self, thread: &ThreadId, reason: &str) {
        stop_session_work(&self.directory, &*self.shells, &self.read_state, thread, reason, "session-close").await;
        self.directory.deps().side.forget(thread, true);
        self.providers.release_session(thread.as_str());
        if let Some(handle) = self.directory.handle(thread) {
            let _ = handle.cell.ctl_tx.send(Ctl::Closed).await;
        }
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

/// An agent worker's session (`owner: "agent"`, the lead check of `pool-list`: `owner !== 'agent'`). A runtime's own
/// session is never one: the workers are closed by the runtime's `agentTool.closeAll` (`teardown.mjs:231`), which
/// detaches each of them and which `OwnerTeardown` already ran.
fn is_worker(header: &Map<String, Value>) -> bool {
    header.get("owner").map(mixdog_js::value_to_string).is_some_and(|owner| mixdog_js::js_trim(&owner).eq_ignore_ascii_case("agent"))
}

/// Teardown's `closeOwnSession` (`teardown/session-close.mjs:42-60`): the session a runtime holds is closed with the
/// stop's reason, tombstoned while it is an empty scratch session and detached otherwise. A worker session is not
/// the runtime's own: the agents' close already detached it, and it gets no second bump.
#[async_trait::async_trait]
impl super::directory::ExitClose for SessionClose {
    async fn close_on_exit(&self, thread: &ThreadId, reason: &str) {
        match self.threads.header(thread).await {
            Ok(header) if is_worker(&header) => return,
            Ok(_) => {}
            Err(PortError::NotFound { .. }) => return,
            Err(error) => {
                tracing::warn!("[session-close] {thread}: its header could not be read at exit: {error:?}");
                return;
            }
        }
        let committed = match mixdog_core_ports::ports::memory_source::ThreadMessages::messages(&self.threads, thread).await {
            Ok(messages) => messages,
            Err(PortError::NotFound { .. }) => return,
            Err(error) => {
                tracing::warn!("[session-close] {thread}: its messages could not be read at exit: {error:?}");
                return;
            }
        };
        let live: Vec<Value> = self.directory.handle(thread).map(|handle| (**handle.cell.turn_messages.borrow()).clone()).unwrap_or_default();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("an object")
    }

    const TWIN: &str = include_str!("../../../../fixtures/session-lifecycle/twin.json");
    const LIFECYCLE_KEYS: [&str; 9] = ["generation", "updatedAt", "detachedReason", "ownerClosedAt", "closed", "closedReason", "status", "cancelStatus", "cancelledAt"];

    /// The clock of recorded call window `step` (0 is the session's creation, step `n` its `n`th barrier).
    fn clock_of(step: i64) -> i64 {
        1000 * (step + 1)
    }

    /// A recorded lifecycle header with its `{ "step": n }` stamps read as the clock of that call.
    fn resolved(recorded: &Value) -> Map<String, Value> {
        recorded
            .as_object()
            .expect("a lifecycle")
            .iter()
            .map(|(key, value)| (key.clone(), value.get("step").and_then(Value::as_i64).map_or_else(|| value.clone(), |step| json!(clock_of(step)))))
            .collect()
    }

    fn lifecycle(header: &Map<String, Value>) -> Map<String, Value> {
        LIFECYCLE_KEYS.iter().filter_map(|key| header.get(*key).map(|value| ((*key).to_owned(), value.clone()))).collect()
    }

    /// Node's recorded barriers (`bumpSessionGenerationAttempt`, `markSessionClosedAttempt`) over the real session
    /// store: each step leaves the lifecycle header the Rust fields make from the same header and clock.
    #[test]
    fn the_barriers_leave_what_node_recorded() {
        let twin: Value = serde_json::from_str(TWIN).expect("twin.json");
        let cases = twin["barriers"].as_array().expect("barriers");
        assert_eq!(cases.len(), 7);
        for case in cases {
            let name = case["name"].as_str().expect("name");
            let steps = case["steps"].as_array().expect("steps");
            let mut header = resolved(&steps[0]["before"]);
            for (index, step) in steps.iter().enumerate() {
                let now = clock_of(index as i64 + 1);
                let (reason, op) = (step["reason"].as_str().expect("reason"), step["op"].as_str().expect("op"));
                assert_eq!(lifecycle(&header), resolved(&step["before"]), "{name} step {index}: the header the step starts from");
                let fields = match op {
                    "detach" => detach_fields(&header, reason, step["ownerClose"] == json!(true), now),
                    _ => tombstone(&header, reason, now),
                };
                header.extend(fields);
                assert_eq!(lifecycle(&header), resolved(&step["after"]), "{name} step {index} ({op} {reason})");
                assert_eq!(header["generation"], step["generation"], "{name} step {index}: the generation the barrier resolves");
            }
        }
    }

    /// `_dropsAgainst` over Node's recorded saves: the same record and expected generation drop or land alike.
    #[test]
    fn a_stale_save_is_refused_as_node_refuses_it() {
        let twin: Value = serde_json::from_str(TWIN).expect("twin.json");
        let cases = twin["fence"].as_array().expect("fence");
        assert_eq!(cases.len(), 16);
        let mut refused = 0;
        for case in cases {
            let recorded = obj(json!({ "generation": case["recorded"]["generation"], "closed": case["recorded"]["closed"] }));
            let dropped = drops_against(&recorded, case["expected"].as_f64());
            assert_eq!(dropped, case["dropped"] == json!(true), "{} expected {}", case["state"], case["expected"]);
            refused += usize::from(dropped);
        }
        assert_eq!(refused, 5, "a refused save is in the recording");
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
        async fn patch_header_if(&self, _: &ThreadId, expect: Map<String, Value>, set: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
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
        async fn publish(&self, _: &ThreadId, _: mixdog_core_ports::ports::threads::Section) -> Result<(), PortError> {
            Ok(())
        }
    }

    /// A detach lands against the header it was computed from (computed again when another write moved it), and a
    /// save issued for the generation before it is refused while one issued for the new generation lands.
    #[tokio::test]
    async fn a_detach_fences_the_save_issued_before_it() {
        let thread = ThreadId::from("sess_a");
        let cell = Cell::default();
        assert!(write_detach(&cell, &thread, "no live session clients", false, 7).await.unwrap());
        let header = cell.header.lock().unwrap().clone();
        assert_eq!(
            Value::Object(header),
            json!({ "generation": 1, "updatedAt": 7, "detachedReason": "no live session clients" }),
            "the fields Node's first detach records"
        );

        let late = obj(json!({ "title": "late" }));
        assert_eq!(patch_header_fenced(&cell, &thread, Some(0.0), late.clone(), Vec::new()).await.unwrap(), Saved::Dropped);
        assert!(cell.header.lock().unwrap().get("title").is_none(), "the refused save wrote nothing");
        assert_eq!(patch_header_fenced(&cell, &thread, Some(1.0), late, Vec::new()).await.unwrap(), Saved::Written);
        assert_eq!(cell.header.lock().unwrap()["title"], json!("late"));

        cell.conflict_once.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(write_detach(&cell, &thread, "SIGTERM", true, 9).await.unwrap());
        let header = cell.header.lock().unwrap().clone();
        assert_eq!((header["generation"].clone(), header["ownerClosedAt"].clone()), (json!(6), json!(9)), "computed again from the header another write moved");
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
