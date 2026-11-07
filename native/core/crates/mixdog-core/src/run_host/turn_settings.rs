//! The settings reconcile every turn starts with (Node `await reconcileTurnSettings()` of the turn
//! preparation, `turn/turn-run/turn-prepare.mjs`): a gate that moved since the last turn reaches
//! this one through the thread's header, before the request is assembled.
//!
//! The settings host reads the session directory, which is built over the run factory that
//! calls it, so it is a late cell: bound once, after the directory exists. A turn that starts
//! before the bind fails with a typed text instead of running on stale gates.

use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;

use super::late::Bound;

/// What a turn start does to the thread's settings.
#[async_trait]
pub trait TurnSettings: Send + Sync + 'static {
    /// The thread's header once its settings follow the live ones: an empty thread (`conversation` false)
    /// that has a prompt identity is rebuilt whole, any other takes the moved tool gates and connectors
    /// without touching its prefix (`reconcileSession`).
    async fn reconcile(&self, thread: &ThreadId, conversation: bool) -> Result<Header, String>;
}

/// [`TurnSettings`] bound after the directory exists.
#[derive(Default)]
pub struct LateTurnSettings(OnceLock<Arc<dyn TurnSettings>>);

impl LateTurnSettings {
    /// Binds the host; a second bind is refused.
    pub fn bind(&self, host: Arc<dyn TurnSettings>) -> Result<(), Arc<dyn TurnSettings>> {
        self.0.set(host)
    }
}

#[async_trait]
impl TurnSettings for LateTurnSettings {
    async fn reconcile(&self, thread: &ThreadId, conversation: bool) -> Result<Header, String> {
        match self.0.get() {
            Some(host) => host.reconcile(thread, conversation).await,
            None => Err("the turn settings are not bound yet".to_owned()),
        }
    }
}

impl Bound for LateTurnSettings {
    fn cell(&self) -> &'static str {
        "turn settings"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed;

    #[async_trait]
    impl TurnSettings for Fixed {
        async fn reconcile(&self, _: &ThreadId, _: bool) -> Result<Header, String> {
            Ok(Header::from_iter([("fold".to_owned(), serde_json::Value::Bool(true))]))
        }
    }

    /// A turn before the bind fails with a text; after it the host's header is the turn's.
    #[tokio::test]
    async fn an_unbound_cell_refuses_the_turn_and_a_bound_one_answers() {
        let cell = LateTurnSettings::default();
        let thread = ThreadId::from("t1");
        assert!(!cell.is_bound());
        assert!(cell.reconcile(&thread, false).await.is_err());
        assert!(cell.bind(Arc::new(Fixed)).is_ok());
        assert!(cell.is_bound());
        assert_eq!(cell.reconcile(&thread, false).await.unwrap()["fold"], true);
        assert!(cell.bind(Arc::new(Fixed)).is_err(), "a second bind is refused");
    }
}