//! The one seam between the ports and the session runtime: a thread's acked header and the
//! section publication. The directory adapter uses `thread/header/read` and
//! `thread/header/patch` (a `meta` record), which the session serves to internal callers only.

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

use crate::session::Section;
use crate::session::SessionDirectory;

#[async_trait]
pub trait ThreadState: Send + Sync {
    /// The thread's acked header; a cold thread is opened.
    async fn header(&self, thread: &ThreadId) -> Result<Header, PortError>;
    async fn patch_header(&self, thread: &ThreadId, set: Map<String, Value>, unset: Vec<String>) -> Result<(), PortError>;
    /// A header patch the session actor applies only while `expect` still holds of its header
    /// (key to the value the patch was computed from, `null` for absent). `Ok(Some(current))`
    /// is a refusal: the keys' values now, to compute the patch again from.
    async fn patch_header_if(
        &self,
        thread: &ThreadId,
        expect: Map<String, Value>,
        set: Map<String, Value>,
        unset: Vec<String>,
    ) -> Result<Option<Map<String, Value>>, PortError>;
    async fn publish(&self, thread: &ThreadId, section: Section) -> Result<(), PortError>;
}

pub fn port_error(error: CoreError) -> PortError {
    match error {
        CoreError::ThreadNotFound { thread_id } => PortError::NotFound {
            target: thread_id.as_str().to_owned(),
            message: format!("session: {} is unavailable", thread_id.as_str()),
        },
        other => PortError::Failed { capability: "session".into(), message: format!("{other:?}") },
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

    pub(super) async fn call(&self, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, PortError> {
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
}

#[async_trait]
impl ThreadState for SessionThreads {
    async fn header(&self, thread: &ThreadId) -> Result<Header, PortError> {
        let value = self.call(thread, "thread/header/read", json!({ "threadId": thread })).await?;
        Ok(value.get("header").and_then(Value::as_object).cloned().unwrap_or_default())
    }

    async fn patch_header(&self, thread: &ThreadId, set: Map<String, Value>, unset: Vec<String>) -> Result<(), PortError> {
        self.call(thread, "thread/header/patch", json!({ "threadId": thread, "set": set, "unset": unset })).await.map(|_| ())
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
        Ok(reply.get("conflict").and_then(Value::as_object).cloned())
    }

    async fn publish(&self, thread: &ThreadId, section: Section) -> Result<(), PortError> {
        let ctx = CallContext::internal("ports");
        let handle = self.directory.open_handle(thread, &ctx).await.map_err(port_error)?;
        handle.set_section(section).await.map_err(port_error)
    }
}
