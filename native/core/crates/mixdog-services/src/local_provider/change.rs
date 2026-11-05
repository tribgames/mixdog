//! The one public change signal of the local provider: a counter that ticks whenever the value
//! `LocalProvider::status()` returns may have changed (installations, server running or idle, the
//! runtime and model catalog, the request queue). Subscribers read `status()` after a tick; ticks
//! carry no payload and coalesce, so a slow subscriber sees the latest state, never a backlog.

use std::sync::Arc;

use tokio::sync::watch;

#[derive(Clone)]
pub struct ChangeSignal(Arc<watch::Sender<u64>>);

impl Default for ChangeSignal {
    fn default() -> Self {
        Self(Arc::new(watch::channel(0).0))
    }
}

impl ChangeSignal {
    /// Marks the status as changed.
    pub fn notify(&self) {
        self.0.send_modify(|n| *n = n.wrapping_add(1));
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.0.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ticks_coalesce_and_reach_every_subscriber() {
        let signal = ChangeSignal::default();
        let (mut a, mut b) = (signal.subscribe(), signal.subscribe());
        signal.notify();
        signal.notify();
        a.changed().await.unwrap();
        assert_eq!(*a.borrow_and_update(), 2);
        b.changed().await.unwrap();
        assert!(!a.has_changed().unwrap());
        signal.clone().notify();
        assert!(a.has_changed().unwrap());
    }
}
