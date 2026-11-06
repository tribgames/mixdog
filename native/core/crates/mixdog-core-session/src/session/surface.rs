//! The real [`ToolSurfaceSource`]: today's `preDispatchDenyForSession` inputs, read from the
//! session header (`mixdog_tools::policy::SessionSurface::from_header`) plus the one piece the
//! header does not hold, the provider route's exclusions, which the run owns in memory.
//!
//! `connector_disabled` and `project_disabled` stay false here: they depend on the called tool
//! and `ToolPolicy::authorize` sets them per call.

use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use mixdog_tools::policy::SessionSurface;

use super::seams::ToolSurfaceSource;

/// Tools the provider rejected for the thread's current route, with the model text of why
/// (`providerToolExclusionReason`).
pub trait RouteExclusions: Send + Sync + 'static {
    /// The tools the thread's route left out, as `(tool, reason)`; `header` names the route.
    fn excluded(&self, thread: &ThreadId, header: &Header) -> Vec<(String, String)>;
}

/// No route has excluded anything (a run that has not started, or a provider without schema
/// validation).
pub struct NoRouteExclusions;

impl RouteExclusions for NoRouteExclusions {
    fn excluded(&self, _thread: &ThreadId, _header: &Header) -> Vec<(String, String)> {
        Vec::new()
    }
}

pub struct HeaderToolSurfaces {
    exclusions: Arc<dyn RouteExclusions>,
}

impl HeaderToolSurfaces {
    pub fn new(exclusions: Arc<dyn RouteExclusions>) -> Self {
        Self { exclusions }
    }
}

impl ToolSurfaceSource for HeaderToolSurfaces {
    fn surface(&self, thread: &ThreadId, header: &Header) -> SessionSurface {
        SessionSurface::from_header(header, self.exclusions.excluded(thread, header))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct Excluded;

    impl RouteExclusions for Excluded {
        fn excluded(&self, thread: &ThreadId, _header: &Header) -> Vec<(String, String)> {
            assert_eq!(thread, &ThreadId::from("t1"));
            vec![("goal".into(), "tool \"goal\" is unavailable with the current model".into())]
        }
    }

    #[test]
    fn the_surface_follows_the_header_and_the_threads_route_exclusions() {
        let header = json!({"disallowedTools": ["react"], "toolSpec": "readonly", "owner": "Agent"});
        let header = header.as_object().expect("object").clone();
        let surface = HeaderToolSurfaces::new(Arc::new(Excluded)).surface(&ThreadId::from("t1"), &header);
        assert_eq!(surface.disallowed, ["react"]);
        assert!(surface.readonly && surface.agent_owned);
        assert_eq!(surface.route_excluded.len(), 1);
        assert!(!surface.connector_disabled && !surface.project_disabled);
        let bare = HeaderToolSurfaces::new(Arc::new(NoRouteExclusions)).surface(&ThreadId::from("t1"), &header);
        assert!(bare.route_excluded.is_empty());
    }
}
