//! [`ThreadState`] and [`ThreadMessages`] over the session directory.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use mixdog_core_ports::ports::memory_source::ThreadMessages;
use mixdog_core_ports::ports::threads::Attempt;
use mixdog_core_ports::ports::threads::HeaderStored;
use mixdog_core_ports::ports::threads::HeaderUpdate;
use mixdog_core_ports::ports::threads::HeaderUpdates;
use mixdog_core_ports::ports::threads::HeaderWrite;
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_ports::ports::threads::port_error;

impl SessionDirectory {
    /// Applies `update` to the header of `thread` on its actor, the header's only writer: the
    /// change is computed from the header as it stands there and is the next record, so a
    /// concurrent write is neither lost nor raced. Opens the thread as the ports' reads do.
    pub async fn update_header(&self, thread: &ThreadId, update: HeaderUpdate) -> Result<(), CoreError> {
        self.submit_header_update(thread, update).await?.durable().await
    }

    /// [`Self::update_header`] split at the actor's mailbox: resolves once the update is accepted into the inbox (queued
    /// behind whatever the actor is doing), and the returned handle resolves once the change is durable. Lets a caller
    /// know a write is queued before it releases what the actor waits on.
    pub async fn submit_header_update(&self, thread: &ThreadId, update: HeaderUpdate) -> Result<PendingHeaderUpdate, CoreError> {
        let ctx = CallContext::internal("ports");
        let handle = self.open_handle(thread, &ctx).await?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        handle
            .inbox
            .send(super::actor::Inbox::UpdateHeader { update, tx })
            .await
            .map_err(|_| CoreError::Internal { incident_id: "header-update-closed".into() })?;
        Ok(PendingHeaderUpdate(rx))
    }

    /// [`Self::update_header`] over a step that awaits its outside reads on the actor: the actor handles nothing else
    /// while it waits, so every other header write queues behind this one.
    pub async fn update_header_awaiting(&self, thread: &ThreadId, update: super::actor::AwaitingHeaderUpdate) -> Result<(), CoreError> {
        let ctx = CallContext::internal("ports");
        let handle = self.open_handle(thread, &ctx).await?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        handle
            .inbox
            .send(super::actor::Inbox::UpdateHeaderAwaiting { update, tx })
            .await
            .map_err(|_| CoreError::Internal { incident_id: "header-update-closed".into() })?;
        rx.await.map_err(|_| CoreError::Internal { incident_id: "header-update-dropped".into() })??;
        Ok(())
    }
}

/// A header update accepted into a thread's inbox, not yet durable.
pub struct PendingHeaderUpdate(tokio::sync::oneshot::Receiver<Result<Reply, CoreError>>);

impl PendingHeaderUpdate {
    /// Resolves once the change is durable (or refused).
    pub async fn durable(self) -> Result<(), CoreError> {
        self.0.await.map_err(|_| CoreError::Internal { incident_id: "header-update-dropped".into() })??;
        Ok(())
    }

    /// Whether the actor has not answered yet. An answer that is already there is taken by this check, so it is for a
    /// caller that treats an early answer as a failure.
    pub fn still_waiting(&mut self) -> bool {
        matches!(self.0.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty))
    }
}

/// [`ThreadState`] over the session directory.
pub struct SessionThreads {
    directory: Arc<SessionDirectory>,
}

impl SessionThreads {
    pub fn new(directory: Arc<SessionDirectory>) -> Self {
        Self { directory }
    }

    async fn call(&self, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, PortError> {
        let ctx = CallContext::internal("ports");
        let handle = self.directory.open_handle(thread, &ctx).await.map_err(port_error)?;
        let reply = handle.request(CoreRequest { method: Method(method), params, op: None, ctx }).await.map_err(port_error)?;
        match reply {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(_) => Err(PortError::Failed { capability: "session".into(), message: format!("{method} subscribed") }),
        }
    }

    /// A header write issued for `expected_generation` (`saveSessionAsync(session, { expectedGeneration })`):
    /// `thread/header/patch` with `expectedGeneration`, which the thread drops when the header it lands on is past that
    /// generation. A record ahead of it that failed to land leaves it decided against a header that never was: sent again.
    pub async fn patch_header_fenced(
        &self,
        thread: &ThreadId,
        expected_generation: Option<f64>,
        set: Map<String, Value>,
        unset: Vec<String>,
    ) -> Result<super::close::Saved, PortError> {
        let params = json!({ "threadId": thread, "expectedGeneration": expected_generation, "set": set, "unset": unset });
        loop {
            let reply = match self.call(thread, "thread/header/patch", params.clone()).await {
                Ok(reply) => reply,
                // A deleted session's late save is fenced (`deleteSession(id, { fenceWrites: true })`): dropped.
                Err(PortError::NotFound { .. }) => return Ok(super::close::Saved::Dropped),
                Err(error) => return Err(error),
            };
            if reply.get("dropped") == Some(&Value::Bool(true)) {
                return Ok(super::close::Saved::Dropped);
            }
            if reply.get("conflict").is_none() {
                return Ok(super::close::Saved::Written);
            }
        }
    }
}

/// What the actor's answer to a stored patch establishes ([`ThreadState::store_header`]).
///
/// That nothing was written is established by a refusal only for a first submission: no record of the operation can
/// exist but the one this submission would have made. For an operation submitted before, a refusal that came before
/// the actor looked for its record (it is shutting down, its window or queue is full) says nothing of that record, and
/// is no answer: `Indeterminate`. Then only what the lookup itself found refuses it (no record, a fence, a record of
/// other parameters), or the barrier of the append the lookup allowed.
fn stored_answer(attempt: Attempt, reply: Result<Reply, CoreError>) -> HeaderStored {
    let first = attempt == Attempt::First;
    match reply {
        Ok(Reply::Value(value)) if value.get("absent") == Some(&Value::Bool(true)) => {
            HeaderStored::Refused("the journal holds no record of the operation".into())
        }
        Ok(_) => HeaderStored::Stored,
        Err(CoreError::PreconditionFailed { precondition }) => HeaderStored::Superseded(format!("{precondition:?}")),
        // The lookup's own finding, or a barrier that rolled the record back: nothing of the operation is stored.
        Err(error @ (CoreError::BarrierFailed { .. } | CoreError::OpFenced { .. } | CoreError::OpIdConflict { .. })) => {
            HeaderStored::Refused(format!("{error:?}"))
        }
        // Answered before a record was accepted.
        Err(
            error @ (CoreError::InvalidParams { .. }
            | CoreError::ThreadNotFound { .. }
            | CoreError::WindowFull { .. }
            | CoreError::QueueFull { .. }
            | CoreError::OpIdRequired
            | CoreError::CapabilityUnavailable { .. }),
        ) if first => HeaderStored::Refused(format!("{error:?}")),
        // An append whose outcome is unknown, a record that cannot be read for, an actor that ended with the request
        // in hand, or one that refused before it looked.
        Err(error) => HeaderStored::Indeterminate(format!("{error:?}")),
    }
}

#[cfg(test)]
mod stored_answer_tests {
    use super::*;

    /// A shutting-down actor refuses before it looks for the operation. For a first submission that is proof that
    /// nothing was written; for a settle or a replay it is no answer, and never "absent".
    #[test]
    fn a_refusal_before_the_lookup_is_proof_only_for_a_first_submission() {
        let unavailable = || Err(CoreError::CapabilityUnavailable { capability: "session".into(), detail: "the session is shutting down".into() });
        assert!(matches!(stored_answer(Attempt::First, unavailable()), HeaderStored::Refused(_)));
        for again in [Attempt::Settle, Attempt::Replay] {
            assert!(matches!(stored_answer(again, unavailable()), HeaderStored::Indeterminate(_)), "{again:?}");
            let full = Err(CoreError::QueueFull { queue: "control".into() });
            assert!(matches!(stored_answer(again, full), HeaderStored::Indeterminate(_)), "{again:?}");
            // What the lookup found is an answer.
            let absent = Ok(Reply::Value(json!({ "absent": true })));
            assert!(matches!(stored_answer(again, absent), HeaderStored::Refused(_)), "{again:?}");
            let fenced = Err(CoreError::OpFenced { op_id: mixdog_core_api::ids::OpId::from("o".to_owned()) });
            assert!(matches!(stored_answer(again, fenced), HeaderStored::Refused(_)), "{again:?}");
            assert_eq!(stored_answer(again, Ok(Reply::Value(json!({})))), HeaderStored::Stored);
        }
    }
}

#[async_trait]
impl ThreadState for SessionThreads {
    async fn header(&self, thread: &ThreadId) -> Result<Header, PortError> {
        // A read opens no session: the live header of a loaded thread, else the stored record. Only a session with no
        // listed record (unconverted, row-only, unknown) goes the opening way.
        if let Some(header) = self.directory.listed_header(thread).await {
            return Ok(header);
        }
        let value = self.call(thread, "thread/header/read", json!({ "threadId": thread })).await?;
        Ok(value.get("header").and_then(Value::as_object).cloned().unwrap_or_default())
    }

    /// Of a loaded thread the members are picked from its live header, which is not copied. A thread that is not loaded is
    /// read as [`header`](Self::header) reads it, from its record: the index row is not asked, which can outlive a log
    /// that is gone.
    async fn header_fields(&self, thread: &ThreadId, fields: &'static [&'static str]) -> Result<Header, PortError> {
        if let Some(header) = self.directory.loaded_fields(thread, fields) {
            return Ok(header);
        }
        Ok(self.header(thread).await?.into_iter().filter(|(key, _)| fields.contains(&key.as_str())).collect())
    }

    /// Answered once the change is durable and in the index, so every read after the answer — the Agents pool's worker
    /// rows among them — sees it (Node's write is the file every later listing reads).
    async fn patch_header(&self, thread: &ThreadId, set: Map<String, Value>, unset: Vec<String>) -> Result<(), PortError> {
        self.call(thread, "thread/header/patch", json!({ "threadId": thread, "set": set, "unset": unset })).await?;
        self.directory.deps().store.indexed(thread).await.map_err(port_error)
    }

    async fn patch_header_if(
        &self,
        thread: &ThreadId,
        expect: Map<String, Value>,
        set: Map<String, Value>,
        unset: Vec<String>,
    ) -> Result<Option<Map<String, Value>>, PortError> {
        let reply = self.call(thread, "thread/header/patch", json!({ "threadId": thread, "expect": expect, "set": set, "unset": unset })).await?;
        self.directory.deps().store.indexed(thread).await.map_err(port_error)?;
        Ok(reply.get("conflict").and_then(Value::as_object).cloned())
    }

    async fn publish(&self, thread: &ThreadId, section: Section) -> Result<(), PortError> {
        let ctx = CallContext::internal("ports");
        let handle = self.directory.open_handle(thread, &ctx).await.map_err(port_error)?;
        handle.set_section(section).await.map_err(port_error)
    }

    /// The write goes to the thread's actor as a stored patch (`Inbox::StoredPatch`), with its operation as the
    /// request's op (the `meta` record carries it), its `incarnation` and its `expect`: the same request each time the
    /// operation is submitted. The actor holds the rule (`SessionActor::stored_patch`) and answers at the patch's own
    /// barrier (`Effect::Stored`), so a save that failed is this caller's failure though the session is loaded. Nothing
    /// is waited for after that answer: the index and the catalog follow the journal in their own time.
    ///
    /// A first submission to a thread that cannot be opened took nothing. One submitted before is another matter: its
    /// record may be in a journal that cannot be read now, so that is not told; and the log's own unknown outcome, if
    /// it has one, is settled before the actor is asked.
    async fn store_header(&self, thread: &ThreadId, write: HeaderWrite) -> HeaderStored {
        let ctx = CallContext::internal("ports");
        let HeaderWrite { operation, incarnation, expect, set, unset, attempt } = write;
        let first = attempt == Attempt::First;
        let handle = match self.directory.open_handle(thread, &ctx).await {
            Ok(handle) => handle,
            Err(error) if first => return HeaderStored::Refused(format!("{error:?}")),
            Err(error) => return HeaderStored::Indeterminate(format!("the session could not be opened to ask: {error:?}")),
        };
        if !first && let Err(error) = handle.storage_reconciled().await {
            return HeaderStored::Indeterminate(format!("the log's unknown outcome is not settled: {error:?}"));
        }
        let params = json!({ "threadId": thread, "set": set, "unset": unset, "incarnation": incarnation, "expect": expect });
        let op = Some(mixdog_core_api::ids::OpId::from(operation));
        stored_answer(attempt, handle.stored_patch(CoreRequest { method: Method("thread/header/patch"), params, op, ctx }, attempt).await)
    }

    fn log_identity(&self, thread: &ThreadId) -> Option<String> {
        self.directory.handle(thread).map(|handle| handle.log_id.to_string())
    }

    /// Asked of the thread's actor, which answers from the header as it projects it: no record is written and neither
    /// the published header nor the index is read, so a thread whose projection failed is answered like any other.
    async fn held_fields(&self, thread: &ThreadId, keys: &'static [&'static str]) -> Result<Map<String, Value>, PortError> {
        let handle = self.directory.open_handle(thread, &CallContext::internal("ports")).await.map_err(port_error)?;
        handle.held_fields(keys).await.map_err(port_error)
    }
}

#[async_trait]
impl HeaderUpdates for SessionThreads {
    async fn update_header(&self, thread: &ThreadId, update: HeaderUpdate) -> Result<(), PortError> {
        self.directory.update_header(thread, update).await.map_err(port_error)
    }
}

#[async_trait]
impl ThreadMessages for SessionThreads {
    async fn messages(&self, thread: &ThreadId) -> Result<Vec<Value>, PortError> {
        let value = self.call(thread, "thread/messages/read", json!({ "threadId": thread })).await?;
        Ok(value.get("messages").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    async fn messages_until(&self, thread: &ThreadId, wanted: &(dyn for<'v> Fn(&'v Value) -> bool + Sync)) -> Result<Vec<Value>, PortError> {
        let ctx = CallContext::internal("ports");
        let handle = self.directory.open_handle(thread, &ctx).await.map_err(port_error)?;
        handle.model_messages(Some(wanted)).await.map_err(port_error)
    }
}
