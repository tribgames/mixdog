use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::error::stored::rejection_from_json;
use mixdog_core_api::error::stored::rejection_to_json;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ops::OpScope;
use mixdog_core_base::ops::OpGate;
use mixdog_core_base::ops::OpRecord;
use mixdog_core_base::ops::OpState;
use mixdog_core_base::ops::OpStore;
use mixdog_core_base::ops::PayloadDigest;
use mixdog_core_base::ops::ThreadOpGates;
use mixdog_core_base::ops::WeakOpGate;
use mixdog_rt::CancellationToken;
use mixdog_store::schema::bounded::Digest;
use mixdog_store::schema::bounded::Json;
use mixdog_store::schema::bounded::Text;
use mixdog_store::schema::record::OpRef;
use mixdog_store::schema::record::OpState as Logged;
use mixdog_store::schema::record::Record;
use serde_json::Value;
use serde_json::json;

use super::directory::DirInner;
use super::seams::StoredOp;

/// What the actor does for the thread's op store.
pub(crate) enum OpCall {
    /// Answer once a running execution of the op has settled (at once when none runs).
    Await(OpId),
    /// Append an `op` record.
    Record { op: Box<OpRef>, state: Logged, detail: Option<Value> },
}

/// The op a record applies, whichever record carries it.
pub(crate) fn op_ref_of(record: &Record) -> Option<&OpRef> {
    match record {
        Record::Session(r) => r.op.as_ref(),
        Record::Meta(r) => r.op.as_ref(),
        Record::Item(r) => r.op.as_ref(),
        Record::Amend(r) => r.op.as_ref(),
        Record::Rewind(r) => r.op.as_ref(),
        Record::Compacted(r) => r.op.as_ref(),
        Record::Run(r) => r.op.as_ref(),
        Record::Approval(r) => r.op.as_ref(),
        Record::ModelSwitch(r) => r.op.as_ref(),
        Record::Queue(r) => r.op.as_ref(),
        Record::Op(r) => Some(&r.op),
        Record::Checkpoint(_) | Record::Draft(_) | Record::WorkStop(_) => None,
    }
}

/// The method an `op` record of a fence names (a fence knows only the id).
const FENCE_METHOD: &str = "op/status";

/// `ThreadOpGates` over the thread directory: one live gate per thread while in use, held weakly so
/// unused gates are released once every caller and ticket drops them.
pub struct ThreadOps {
    dir: Arc<DirInner>,
    gates: Mutex<HashMap<ThreadId, WeakOpGate>>,
}

impl ThreadOps {
    pub(super) fn new(dir: Arc<DirInner>) -> Arc<Self> {
        Arc::new(Self { dir, gates: Mutex::new(HashMap::new()) })
    }

    fn gates(&self) -> std::sync::MutexGuard<'_, HashMap<ThreadId, WeakOpGate>> {
        self.gates.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn forget(&self, thread: &ThreadId) {
        let mut gates = self.gates();
        gates.remove(thread);
        gates.retain(|_, weak| weak.is_live());
    }

    pub(crate) fn prune_unused(&self) {
        self.gates().retain(|_, weak| weak.is_live());
    }

    #[cfg(test)]
    fn gates_held(&self) -> (usize, usize) {
        let gates = self.gates();
        let live = gates.values().filter(|weak| weak.is_live()).count();
        (gates.len(), live)
    }
}

#[async_trait]
impl ThreadOpGates for ThreadOps {
    /// `threadNotFound` for a thread with no stored session (its gate is dropped).
    async fn gate(&self, thread: &ThreadId, _ctx: &CallContext) -> Result<OpGate, CoreError> {
        // Only whether the session is there is asked: none of its header is taken.
        if self.dir.stored_fields(thread, &[]).await.is_none() {
            let mut gates = self.gates();
            gates.remove(thread);
            gates.retain(|_, weak| weak.is_live());
            return Err(CoreError::ThreadNotFound { thread_id: thread.clone() });
        }
        let mut gates = self.gates();
        gates.retain(|_, weak| weak.is_live());
        if let Some(gate) = gates.get(thread).and_then(WeakOpGate::upgrade) {
            return Ok(gate);
        }
        let gate = OpGate::thread(OpScope::Thread(thread.clone()), Arc::new(ThreadOpStore { dir: self.dir.clone(), thread: thread.clone() }));
        gates.insert(thread.clone(), gate.downgrade());
        Ok(gate)
    }
}

struct ThreadOpStore {
    dir: Arc<DirInner>,
    thread: ThreadId,
}

fn unreadable() -> CoreError {
    CoreError::Internal { incident_id: "thread-op-unreadable".into() }
}

fn too_long(path: &str) -> CoreError {
    CoreError::InvalidParams { path: path.into(), expected: "a shorter value".into() }
}

#[async_trait]
impl OpStore for ThreadOpStore {
    async fn get(&self, id: &OpId) -> Result<Option<OpRecord>, CoreError> {
        if let Some(handle) = self.dir.loaded(&self.thread) {
            // A failed execution recorded nothing: the read below finds the op unseen.
            drop(handle.op_call(OpCall::Await(id.clone())).await);
        }
        let deps = self.dir.deps();
        deps.store.unheld(&self.thread).await;
        let (store, thread, op) = (deps.store.clone(), self.thread.clone(), id.as_str().to_owned());
        let stored =
            mixdog_core_base::support::on_lane_wait(deps.lanes.io, &CancellationToken::new(), move |lane| store.thread_op(lane, &thread, &op)).await??;
        stored.map(record_of).transpose()
    }

    async fn put(&self, id: &OpId, record: OpRecord) -> Result<(), CoreError> {
        let (method, digest, audience, state, detail, result) = match record {
            OpRecord::Fenced => (FENCE_METHOD.to_owned(), PayloadDigest::of_params(&json!({})).as_str().to_owned(), None, Logged::Fenced, None, None),
            OpRecord::Settled { method, digest, audience, state } => {
                let (state, detail, result) = match state {
                    OpState::Applied { result, .. } => (Logged::Applied, None, result),
                    OpState::Rejected { error } => (Logged::Rejected, Some(rejection_to_json(&error)), None),
                    OpState::ExternalPending { effect, target } => (Logged::ExternalPending, Some(json!({ "effect": &*effect, "target": &*target })), None),
                    OpState::ExternalUnknown { effect, target } => (Logged::ExternalUnknown, Some(json!({ "effect": &*effect, "target": &*target })), None),
                };
                let audience = audience.map(|a| Digest::try_from(a.as_str().to_owned())).transpose().map_err(|_| unreadable())?;
                (method.to_string(), digest.as_str().to_owned(), audience, state, detail, result)
            }
        };
        let op = OpRef {
            id: Text::try_from(id.as_str()).map_err(|_| too_long("opId"))?,
            method: Text::try_from(method.as_str()).map_err(|_| too_long("method"))?,
            digest: Digest::try_from(digest).map_err(|_| unreadable())?,
            audience,
            result: result.and_then(|value| Json::try_from(value).ok()),
        };
        let handle = self.dir.op_target(&self.thread).await?;
        handle.op_call(OpCall::Record { op: Box::new(op), state, detail }).await.map(drop)
    }

    /// Thread scopes keep no watermark.
    async fn watermark(&self) -> Result<Option<u64>, CoreError> {
        Ok(None)
    }
}

fn external(detail: Option<Value>) -> Result<(Arc<str>, Arc<str>), CoreError> {
    let detail = detail.ok_or_else(unreadable)?;
    let field = |key: &str| detail.get(key).and_then(Value::as_str).map(Arc::<str>::from).ok_or_else(unreadable);
    Ok((field("effect")?, field("target")?))
}

/// The gate's record of a stored op.
fn record_of(op: StoredOp) -> Result<OpRecord, CoreError> {
    let state = match op.state {
        Logged::Fenced => return Ok(OpRecord::Fenced),
        Logged::Applied => OpState::Applied { seq: Some(op.seq), result: op.result },
        Logged::Rejected => OpState::Rejected { error: rejection_from_json(op.detail.ok_or_else(unreadable)?)? },
        Logged::ExternalPending => {
            let (effect, target) = external(op.detail)?;
            OpState::ExternalPending { effect, target }
        }
        Logged::ExternalUnknown => {
            let (effect, target) = external(op.detail)?;
            OpState::ExternalUnknown { effect, target }
        }
    };
    Ok(OpRecord::Settled {
        method: op.method.into(),
        digest: PayloadDigest::from_stored(op.digest.into()),
        audience: op.audience.map(|a| PayloadDigest::from_stored(a.into())),
        state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(state: Logged, result: Option<Value>, detail: Option<Value>) -> StoredOp {
        StoredOp { method: "turn/start".into(), digest: "sha256:d".into(), audience: None, state, seq: 7, result, detail }
    }

    #[test]
    fn an_applied_op_reads_back_with_its_ordinal_and_stored_result() {
        let got = record_of(stored(Logged::Applied, Some(json!({ "kind": "started" })), None)).unwrap();
        assert_eq!(
            got,
            OpRecord::Settled {
                method: "turn/start".into(),
                digest: PayloadDigest::from_stored("sha256:d".into()),
                audience: None,
                state: OpState::Applied { seq: Some(7), result: Some(json!({ "kind": "started" })) },
            }
        );
    }

    #[test]
    fn a_fence_a_rejection_and_an_external_state_read_back() {
        assert_eq!(record_of(stored(Logged::Fenced, None, None)).unwrap(), OpRecord::Fenced);
        let error = CoreError::OpIdConflict { op_id: OpId::from("o".to_owned()) };
        let rejected = record_of(stored(Logged::Rejected, None, Some(rejection_to_json(&error)))).unwrap();
        assert!(matches!(rejected, OpRecord::Settled { state: OpState::Rejected { error: e }, .. } if e == error));
        let pending = record_of(stored(Logged::ExternalPending, None, Some(json!({ "effect": "push", "target": "origin" })))).unwrap();
        assert!(matches!(
            pending,
            OpRecord::Settled { state: OpState::ExternalPending { effect, target }, .. } if &*effect == "push" && &*target == "origin"
        ));
        assert!(record_of(stored(Logged::Rejected, None, None)).is_err());
    }

    #[tokio::test]
    async fn unused_and_deleted_thread_gates_are_released() {
        let rig = crate::session::testing::Rig::new();
        let directory = crate::session::SessionDirectory::new(rig.deps());
        let ops = directory.thread_ops();
        let ctx = CallContext::internal("test");

        let first = crate::session::tests::start_thread(&directory).await.id.clone();
        let second = crate::session::tests::start_thread(&directory).await.id.clone();

        let gate_a = ops.gate(&first, &ctx).await.expect("first gate");
        let gate_a_shared = ops.gate(&first, &ctx).await.expect("shared first gate");
        assert!(gate_a.same_gate(&gate_a_shared), "concurrent callers share one live gate");
        assert_eq!(ops.gates_held(), (1, 1));

        drop(gate_a);
        drop(gate_a_shared);
        assert_eq!(ops.gates_held().1, 0, "dropping all callers releases the OpGate immediately");

        let gate_b = ops.gate(&second, &ctx).await.expect("second gate");
        assert_eq!(ops.gates_held(), (1, 1), "unused dead entry is pruned on next lookup");

        drop(gate_b);
        ops.forget(&second);
        assert_eq!(ops.gates_held(), (0, 0), "deleted thread gate entry is removed");

        let reopened = ops.gate(&first, &ctx).await.expect("recreated gate");
        assert_eq!(ops.gates_held(), (1, 1));
        drop(reopened);
        directory.release(&first).await;
        directory.unload_settled(&first).await;
        assert_eq!(ops.gates_held(), (0, 0), "unloading prunes dead gate entries");
    }
}
