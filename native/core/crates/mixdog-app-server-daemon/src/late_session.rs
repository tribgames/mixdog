//! The two seams of the composition that are a true cycle through the session directory.
//!
//! The directory is built by `TurnPath::new`, from the tool pool; the pool holds the `setup` tool,
//! which holds the desktop request broker (`SetupRequests`, whose `SetupUiSurface` is
//! `SessionSetupUi` over the directory) and the setup callers (`CallerSessions` over the directory).
//! Neither can be built after the directory, so each is a cell bound once, right after it:
//! `LateSetupUi::bind(Arc::new(SessionSetupUi::new(directory, outgoing)))`, and `LateCallerSessions`
//! reads the same [`LateDirectory`] the other late views read.
//!
//! Nothing calls either before the bind: a setup request or a setup caller exists only inside a
//! turn, and a turn needs the directory. Unbound they answer as an unknown thread would.

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use mixdog_core::run_host::compose_parts::LateDirectory;
use mixdog_core_agents::setup::SetupUiSurface;
use mixdog_core_api::CoreError;
use mixdog_protocol::ThreadId;
use serde_json::{Map, Value};

use crate::compose_mcp::CallerSessions;

/// `SetupRequests`' surface, bound to `SessionSetupUi` once the directory exists.
#[derive(Default)]
pub struct LateSetupUi(OnceLock<Arc<dyn SetupUiSurface>>);

impl LateSetupUi {
    /// Binds the surface; a second bind is refused.
    pub fn bind(&self, surface: Arc<dyn SetupUiSurface>) -> Result<(), Arc<dyn SetupUiSurface>> {
        self.0.set(surface)
    }
}

#[async_trait]
impl SetupUiSurface for LateSetupUi {
    async fn notify(&self, thread: &ThreadId, request_id: &str) -> bool {
        match self.0.get() {
            Some(surface) => surface.notify(thread, request_id).await,
            None => false,
        }
    }
}

/// `SetupSeams.sessions` over the late directory.
pub struct LateCallerSessions(pub Arc<LateDirectory>);

#[async_trait]
impl CallerSessions for LateCallerSessions {
    async fn header(&self, thread: &ThreadId) -> Option<Map<String, Value>> {
        self.0.directory()?.stored_header(thread).await
    }

    async fn acting_agent(&self, thread: &ThreadId) -> Result<String, CoreError> {
        match self.0.directory() {
            Some(directory) => mixdog_core_session::session::SessionDirectory::acting_agent(&directory, thread).await,
            None => Err(CoreError::ThreadNotFound { thread_id: thread.clone() }),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    struct Counting(AtomicUsize);

    #[async_trait]
    impl SetupUiSurface for Counting {
        async fn notify(&self, _: &ThreadId, _: &str) -> bool {
            self.0.fetch_add(1, Ordering::SeqCst);
            true
        }
    }

    #[tokio::test]
    async fn the_setup_surface_answers_no_surface_until_bound_then_delegates() {
        let late = LateSetupUi::default();
        let thread = ThreadId::from("t");
        assert!(!late.notify(&thread, "r1").await);
        let counting = Arc::new(Counting(AtomicUsize::new(0)));
        assert!(late.bind(counting.clone()).is_ok());
        assert!(late.notify(&thread, "r1").await);
        assert_eq!(counting.0.load(Ordering::SeqCst), 1);
        assert!(late.bind(counting).is_err(), "a second bind is refused");
    }

    #[tokio::test]
    async fn the_callers_see_an_unknown_thread_until_the_directory_is_bound() {
        let callers = LateCallerSessions(Arc::new(LateDirectory::default()));
        let thread = ThreadId::from("t");
        assert!(callers.header(&thread).await.is_none());
        assert!(matches!(callers.acting_agent(&thread).await, Err(CoreError::ThreadNotFound { .. })));
    }
}
