//! The clock and the wait between two polls of a device grant. This is
//! protocol pacing (the server sets the interval, RFC 8628 §3.5), not a wait
//! on provider content, so [`SystemPace`] is the one place of the login code
//! that sleeps.

use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;

#[async_trait]
pub trait Pace: Send + Sync {
    /// Unix milliseconds.
    fn now_ms(&self) -> u64;
    async fn wait(&self, duration: Duration);
}

pub struct SystemPace;

#[async_trait]
impl Pace for SystemPace {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64)
    }

    async fn wait(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

/// A clock that only moves when the flow waits.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FakePace {
    pub now: std::sync::atomic::AtomicU64,
    pub waits: std::sync::Mutex<Vec<Duration>>,
}

#[cfg(test)]
#[async_trait]
impl Pace for FakePace {
    fn now_ms(&self) -> u64 {
        self.now.load(std::sync::atomic::Ordering::SeqCst)
    }

    async fn wait(&self, d: Duration) {
        self.waits.lock().unwrap().push(d);
        self.now
            .fetch_add(d.as_millis() as u64, std::sync::atomic::Ordering::SeqCst);
    }
}
