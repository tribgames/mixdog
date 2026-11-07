//! The thread scope's op gates (P §9.2, `ThreadOpGates`): `gate(thread)` is the one `OpGate`
//! of a thread, over the thread's log.
//!
//! The thread's actor is the scope's only writer. A lookup (`OpStore::get`) first lets a
//! running execution of the op settle in the actor, then reads the op's indexed row and the
//! frame that carries it (the mutation record's result, an `op` record's rejection or external
//! state). A write (`OpStore::put`: a fence, a rejection, an external state) is an `op` record
//! the actor appends, answered once durable. The actor refuses an id it fenced
//! (`opFenced`), and refuses a fence for an id it already runs or answered.
//!
//! Node has no op store: `call-dispatch.mjs` shares one promise per call id, which the
//! actor's `OpTable` ports (attach, replay, `opIdConflict`). `op/status`, the fence and the
//! durable record are the Rust protocol's (P §9.4), so there is no Node answer to replay.

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
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
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
    Record { op: OpRef, state: Logged, detail: Option<Value> },
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
        Record::Checkpoint(_) => None,
    }
}

/// The method an `op` record of a fence names (a fence knows only the id).
const FENCE_METHOD: &str = "op/status";

/// `ThreadOpGates` over the thread directory: one gate per thread, made on first use, so the
/// slots that order one op's lookups, fences and executions are shared by every caller.
pub struct ThreadOps {
    dir: Arc<DirInner>,
    gates: Mutex<HashMap<ThreadId, OpGate>>,
}

impl ThreadOps {
    pub(super) fn new(dir: Arc<DirInner>) -> Arc<Self> {
        Arc::new(Self { dir, gates: Mutex::new(HashMap::new()) })
    }

    fn gates(&self) -> std::sync::MutexGuard<'_, HashMap<ThreadId, OpGate>> {
        self.gates.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[async_trait]
impl ThreadOpGates for ThreadOps {
    /// `threadNotFound` for a thread with no stored session (its gate is dropped).
    async fn gate(&self, thread: &ThreadId, _ctx: &CallContext) -> Result<OpGate, CoreError> {
        if self.dir.stored_header(thread).await.is_none() {
            self.gates().remove(thread);
            return Err(CoreError::ThreadNotFound { thread_id: thread.clone() });
        }
        let gate = self
            .gates()
            .entry(thread.clone())
            .or_insert_with(|| {
                OpGate::thread(OpScope::Thread(thread.clone()), Arc::new(ThreadOpStore { dir: self.dir.clone(), thread: thread.clone() }))
            })
            .clone();
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
        let (store, thread, op) = (deps.store.clone(), self.thread.clone(), id.as_str().to_owned());
        let stored = deps
            .lanes
            .io
            .submit(&CancellationToken::new(), move |lane| store.thread_op(lane, &thread, &op))?
            .await
            .map_err(|_| CoreError::Internal { incident_id: "session-op-job-dropped".into() })??;
        stored.map(record_of).transpose()
    }

    async fn put(&self, id: &OpId, record: OpRecord) -> Result<(), CoreError> {
        let (method, digest, state, detail, result) = match record {
            OpRecord::Fenced => {
                (FENCE_METHOD.to_owned(), PayloadDigest::of_params(&json!({})).as_str().to_owned(), Logged::Fenced, None, None)
            }
            OpRecord::Settled { method, digest, state } => {
                let (state, detail, result) = match state {
                    OpState::Applied { result, .. } => (Logged::Applied, None, result),
                    OpState::Rejected { error } => (Logged::Rejected, Some(rejection_to_json(&error)), None),
                    OpState::ExternalPending { effect, target } => {
                        (Logged::ExternalPending, Some(json!({ "effect": &*effect, "target": &*target })), None)
                    }
                    OpState::ExternalUnknown { effect, target } => {
                        (Logged::ExternalUnknown, Some(json!({ "effect": &*effect, "target": &*target })), None)
                    }
                };
                (method.to_string(), digest.as_str().to_owned(), state, detail, result)
            }
        };
        let op = OpRef {
            id: Text::try_from(id.as_str()).map_err(|_| too_long("opId"))?,
            method: Text::try_from(method.as_str()).map_err(|_| too_long("method"))?,
            digest: Digest::try_from(digest).map_err(|_| unreadable())?,
            result: result.and_then(|value| Json::try_from(value).ok()),
        };
        let handle = self.dir.op_target(&self.thread).await?;
        handle.op_call(OpCall::Record { op, state, detail }).await.map(drop)
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
    Ok(OpRecord::Settled { method: op.method.into(), digest: PayloadDigest::from_stored(op.digest.into()), state })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(state: Logged, result: Option<Value>, detail: Option<Value>) -> StoredOp {
        StoredOp { method: "turn/start".into(), digest: "sha256:d".into(), state, seq: 7, result, detail }
    }

    #[test]
    fn an_applied_op_reads_back_with_its_ordinal_and_stored_result() {
        let got = record_of(stored(Logged::Applied, Some(json!({ "kind": "started" })), None)).unwrap();
        assert_eq!(
            got,
            OpRecord::Settled {
                method: "turn/start".into(),
                digest: PayloadDigest::from_stored("sha256:d".into()),
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
}
