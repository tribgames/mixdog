//! The tool surface the MCP side reads (`DaemonMcpSurface.surface`) before the session directory
//! exists.
//!
//! `mcp_services` builds the MCP surface with the pool, and the surface answers `tool_names` from
//! `ToolSurfaceStatus::surface(None)` (`getTools()`), whose production form is
//! `SessionToolStatus::new(SessionThreads::new(directory), host)`: a true cycle through the
//! directory, as for `LateSetupUi`. The cell is bound once, right after `TurnPath::new`, and the
//! composition verifies it before the listener accepts. `tool_names` is asked by a client's
//! skills or MCP call, so none reads it earlier; unbound it is the capability error.

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use mixdog_core::run_host::late::Bound;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::status::{StatusSurface, ToolSurfaceStatus};

/// `DaemonMcpSurface.surface`, bound to `SessionToolStatus`.
#[derive(Default)]
pub struct LateToolSurface(OnceLock<Arc<dyn ToolSurfaceStatus>>);

impl LateToolSurface {
    /// Binds the surface; a second bind is refused.
    pub fn bind(&self, surface: Arc<dyn ToolSurfaceStatus>) -> Result<(), Arc<dyn ToolSurfaceStatus>> {
        self.0.set(surface)
    }
}

#[async_trait]
impl ToolSurfaceStatus for LateToolSurface {
    async fn surface(&self, thread: Option<&ThreadId>) -> Result<StatusSurface, CoreError> {
        match self.0.get() {
            Some(surface) => surface.surface(thread).await,
            None => Err(CoreError::CapabilityUnavailable { capability: "tool surface".into(), detail: "the session layer is not up yet".into() }),
        }
    }

    /// `tools/toolsStatus` with `snapshot` reaches the surface through this cell, so it forwards the request
    /// build; the trait's default would answer every snapshot with `invalidParams`.
    async fn request_snapshot(&self, thread: &ThreadId, user_message: Option<&str>) -> Result<serde_json::Value, CoreError> {
        match self.0.get() {
            Some(surface) => surface.request_snapshot(thread, user_message).await,
            None => Err(CoreError::CapabilityUnavailable { capability: "tool surface".into(), detail: "the session layer is not up yet".into() }),
        }
    }
}

impl Bound for LateToolSurface {
    fn cell(&self) -> &'static str {
        "tool surface"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A surface that lists one tool, whichever thread is asked.
    struct Listing;

    #[async_trait]
    impl ToolSurfaceStatus for Listing {
        async fn surface(&self, _: Option<&ThreadId>) -> Result<StatusSurface, CoreError> {
            Ok(StatusSurface { listed: vec!["read".to_owned()], ..StatusSurface::default() })
        }

        async fn request_snapshot(&self, thread: &ThreadId, _user_message: Option<&str>) -> Result<serde_json::Value, CoreError> {
            Ok(serde_json::json!({ "thread": thread.to_string() }))
        }
    }

    #[tokio::test]
    async fn a_request_snapshot_reaches_the_bound_surface() {
        let late = LateToolSurface::default();
        let thread = ThreadId::from("t1");
        assert!(matches!(late.request_snapshot(&thread, None).await, Err(CoreError::CapabilityUnavailable { .. })));
        late.bind(Arc::new(Listing)).ok().unwrap();
        assert_eq!(late.request_snapshot(&thread, None).await.unwrap(), serde_json::json!({ "thread": "t1" }));
    }

    #[tokio::test]
    async fn the_surface_is_unavailable_until_bound_then_the_sessions() {
        let late = LateToolSurface::default();
        assert!(!late.is_bound());
        assert!(matches!(late.surface(None).await, Err(CoreError::CapabilityUnavailable { .. })));
        assert!(late.bind(Arc::new(Listing)).is_ok());
        assert!(late.is_bound());
        assert_eq!(late.surface(None).await.unwrap().listed, ["read"]);
        assert!(late.bind(Arc::new(Listing)).is_err(), "a second bind is refused");
    }
}
