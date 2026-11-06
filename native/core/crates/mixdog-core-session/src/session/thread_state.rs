//! [`ThreadState`] and [`ThreadMessages`] over the session directory.

use std::sync::Arc;

use async_trait::async_trait;
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
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_ports::ports::threads::port_error;

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

#[async_trait]
impl ThreadMessages for SessionThreads {
    async fn messages(&self, thread: &ThreadId) -> Result<Vec<Value>, PortError> {
        let value = self.call(thread, "thread/messages/read", json!({ "threadId": thread })).await?;
        Ok(value.get("messages").and_then(Value::as_array).cloned().unwrap_or_default())
    }
}
