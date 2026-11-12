//! The home delivery's thread store over the session directory (`HomeThreads`): what Node's
//! `agent-home-delivery.mjs` reads and writes through `loadSession`, `saveSessionAsync` and
//! `isSessionTurnInFlight`.
//!
//! Node pushes the rows onto the live session object and then stores it; here the rows are the
//! room-row append of the thread (`thread/roomRows/append`: stored as rows of no turn, shown
//! live, skipped when their `meta.transcript.messageId` is already held), which is durable when
//! it answers, so a later `append` with no rows has nothing left to store. `updatedAt` is
//! stamped by that append at the time it lands (the delivery passes `Date.now()` for the same
//! instant).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_services::bots::delivery::env::{HomeThreads, ThreadSnapshot};
use serde_json::{Value, json};

use super::SessionDirectory;

#[cfg(test)]
mod tests;

/// [`HomeThreads`] over the process's session directory.
pub struct DirectoryHomeThreads {
    directory: Arc<SessionDirectory>,
}

impl DirectoryHomeThreads {
    pub fn new(directory: Arc<SessionDirectory>) -> Self {
        Self { directory }
    }

    /// The thread's header: the live one of a loaded thread, else the stored record. `None` when
    /// the store has no such session (`threadNotFound`); any other failure to read it is an error,
    /// never absence.
    async fn header(&self, thread: &ThreadId) -> Result<Option<mixdog_store::schema::record::Header>, String> {
        if let Some(handle) = self.directory.handle(thread) {
            return Ok(Some(handle.cell.header.load_full().as_ref().clone()));
        }
        let deps = self.directory.deps();
        deps.store.unheld().await;
        let (store, id) = (deps.store.clone(), thread.clone());
        let read = deps
            .lanes
            .io
            .submit(&CancellationToken::new(), move |lane| store.read_header(lane, &id))
            .map_err(|error| error.to_string())?
            .await
            .map_err(|_| "the header read was dropped".to_string())?;
        match read {
            Ok(header) => Ok(Some(header)),
            Err(CoreError::ThreadNotFound { .. }) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[async_trait]
impl HomeThreads for DirectoryHomeThreads {
    async fn load(&self, id: &str) -> Result<Option<ThreadSnapshot>, String> {
        let thread = ThreadId::from(id);
        let Some(header) = self.header(&thread).await? else { return Ok(None) };
        let messages = self.directory.model_context(&thread).read().await.map_err(|error| error.to_string())?;
        Ok(Some(ThreadSnapshot { closed: header.get("closed") == Some(&Value::Bool(true)), messages: messages.into_iter().map(|(_, message)| message).collect() }))
    }

    async fn append(&self, id: &str, rows: Vec<Value>, _touched_at: Option<i64>) -> Result<(), String> {
        if rows.is_empty() {
            return Ok(());
        }
        let ctx = CallContext::internal("home-delivery");
        let handle = self.directory.open_handle(&ThreadId::from(id), &ctx).await.map_err(|error| error.to_string())?;
        let request = CoreRequest { method: Method("thread/roomRows/append"), params: json!({ "messages": rows }), op: None, ctx };
        handle.request(request).await.map_err(|error| error.to_string())?;
        Ok(())
    }

    fn turn_in_flight(&self, id: &str) -> bool {
        self.directory.handle(&ThreadId::from(id)).is_some_and(|handle| {
            handle.cell.run.load_full().is_some() || handle.cell.view.load_full().state.runtime.as_ref().is_some_and(|runtime| runtime.busy)
        })
    }

    /// Deleting a session removes its record and leaves no tombstone: only an absent record with
    /// no loaded copy proves it. A record that fails to read stays.
    async fn session_deleted(&self, id: &str) -> bool {
        let thread = ThreadId::from(id);
        self.directory.handle(&thread).is_none() && matches!(self.header(&thread).await, Ok(None))
    }
}
