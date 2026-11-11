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
use mixdog_core_ports::ports::threads::HeaderUpdate;
use mixdog_core_ports::ports::threads::HeaderUpdates;
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
        let reply = handle
            .request(CoreRequest { method: Method(method), params, op: None, ctx })
            .await
            .map_err(port_error)?;
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

#[async_trait]
impl ThreadState for SessionThreads {
    async fn header(&self, thread: &ThreadId) -> Result<Header, PortError> {
        let value = self.call(thread, "thread/header/read", json!({ "threadId": thread })).await?;
        Ok(value.get("header").and_then(Value::as_object).cloned().unwrap_or_default())
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
        let reply = self
            .call(thread, "thread/header/patch", json!({ "threadId": thread, "expect": expect, "set": set, "unset": unset }))
            .await?;
        self.directory.deps().store.indexed(thread).await.map_err(port_error)?;
        Ok(reply.get("conflict").and_then(Value::as_object).cloned())
    }

    async fn publish(&self, thread: &ThreadId, section: Section) -> Result<(), PortError> {
        let ctx = CallContext::internal("ports");
        let handle = self.directory.open_handle(thread, &ctx).await.map_err(port_error)?;
        handle.set_section(section).await.map_err(port_error)
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
}
