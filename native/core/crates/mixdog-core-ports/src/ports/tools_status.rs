//! `ToolSurfaceStatus`: Node's `toolsStatusNow` input path (`agent-ops.mjs`) over a thread's
//! header. The catalog is `deferredToolCatalog` when the header has one, else `tools`; the
//! active names are `tools` plus `deferredCallableTools`; the discovered ones are
//! `deferredDiscoveredTools`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::status::StatusSurface;
use mixdog_tools::orch::status::StatusTool;
use mixdog_tools::orch::status::ToolSurfaceStatus;
use serde_json::Value;

use super::threads::ThreadState;

/// What the surface needs besides the thread's own header.
#[async_trait]
pub trait SurfaceHost: Send + Sync {
    /// The runtime mode (`rt.mode`).
    fn mode(&self) -> String;
    /// The surface before any session exists (the preview surface).
    fn preview(&self) -> StatusSurface;
    /// Brings an empty thread to the current settings (the turn-start reconcile); a thread
    /// with a conversation or a running turn is left alone.
    async fn reconcile_empty(&self, thread: &ThreadId) -> Result<(), CoreError>;
}

pub struct SessionToolStatus {
    threads: Arc<dyn ThreadState>,
    host: Arc<dyn SurfaceHost>,
}

impl SessionToolStatus {
    pub fn new(threads: Arc<dyn ThreadState>, host: Arc<dyn SurfaceHost>) -> Self {
        Self { threads, host }
    }
}

fn tools_of(header: &Header, key: &str) -> Option<Vec<StatusTool>> {
    let items = header.get(key)?.as_array()?;
    Some(
        items
            .iter()
            .map(|doc| StatusTool {
                name: doc.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
                description: doc.get("description").and_then(Value::as_str).unwrap_or_default().to_owned(),
                agent_hidden: truthy(doc.pointer("/annotations/agentHidden")),
                mixdog_kind: doc.pointer("/annotations/mixdogKind").and_then(Value::as_str).map(str::to_owned),
            })
            .collect(),
    )
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(_) => true,
    }
}

fn names_of(header: &Header, key: &str) -> Vec<String> {
    header
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// The surface a header describes.
pub fn surface_of_header(mode: String, header: &Header) -> StatusSurface {
    let eager = tools_of(header, "tools");
    let catalog = tools_of(header, "deferredToolCatalog").or_else(|| eager.clone()).unwrap_or_default();
    let mut active: Vec<String> = eager.unwrap_or_default().into_iter().map(|t| t.name).filter(|n| !n.is_empty()).collect();
    active.extend(names_of(header, "deferredCallableTools"));
    StatusSurface { mode, catalog, active, discovered: names_of(header, "deferredDiscoveredTools") }
}

#[async_trait]
impl ToolSurfaceStatus for SessionToolStatus {
    async fn surface(&self, thread: Option<&ThreadId>) -> Result<StatusSurface, CoreError> {
        let Some(thread) = thread else {
            return Ok(self.host.preview());
        };
        self.host.reconcile_empty(thread).await?;
        let header = self.threads.header(thread).await.map_err(|_| CoreError::ThreadNotFound { thread_id: thread.clone() })?;
        Ok(surface_of_header(self.host.mode(), &header))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_tools::orch::util::PortError;
    use serde_json::Map;
    use serde_json::json;

    use super::*;
    use crate::ports::threads::Section;

    struct Headers(Header);

    #[async_trait]
    impl ThreadState for Headers {
        async fn header(&self, _: &ThreadId) -> Result<Header, PortError> {
            Ok(self.0.clone())
        }
        async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
            Ok(())
        }
        async fn patch_header_if(&self, _: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
            Ok(None)
        }
        async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
            Ok(())
        }
    }

    struct Host(Mutex<Vec<String>>);

    #[async_trait]
    impl SurfaceHost for Host {
        fn mode(&self) -> String {
            "lead".into()
        }
        fn preview(&self) -> StatusSurface {
            StatusSurface { mode: "lead".into(), ..StatusSurface::default() }
        }
        async fn reconcile_empty(&self, thread: &ThreadId) -> Result<(), CoreError> {
            self.0.lock().unwrap().push(thread.as_str().to_owned());
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_named_thread_is_reconciled_then_read_from_its_header() {
        let header = json!({
            "tools": [{"name": "read", "description": "Read"}],
            "deferredToolCatalog": [{"name": "web_search", "description": "S", "annotations": {"agentHidden": true}}],
            "deferredCallableTools": ["web_search"],
            "deferredDiscoveredTools": ["web_search"],
        });
        let host = Arc::new(Host(Mutex::default()));
        let status = SessionToolStatus::new(Arc::new(Headers(header.as_object().unwrap().clone())), host.clone());
        let surface = status.surface(Some(&ThreadId::from("t1"))).await.unwrap();
        assert_eq!(host.0.lock().unwrap().as_slice(), ["t1"]);
        assert_eq!(surface.mode, "lead");
        assert_eq!(surface.catalog.len(), 1);
        assert!(surface.catalog[0].agent_hidden);
        assert_eq!(surface.active, ["read", "web_search"]);
        assert_eq!(surface.discovered, ["web_search"]);
        let none = status.surface(None).await.unwrap();
        assert!(none.catalog.is_empty());
        assert_eq!(host.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn without_a_deferred_catalog_the_eager_tools_are_the_catalog() {
        let header = json!({"tools": [{"name": "read"}]});
        let surface = surface_of_header("full".into(), header.as_object().unwrap());
        assert_eq!(surface.catalog.len(), 1);
        assert_eq!(surface.active, ["read"]);
    }
}
