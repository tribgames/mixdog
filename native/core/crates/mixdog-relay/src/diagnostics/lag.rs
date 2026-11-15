//! The scheduling-lag probe. Node's `monitorEventLoopDelay` has no Rust equivalent: here a 20 ms tick runs on the runtime
//! that serves the relay and its lateness (how long after its due time it ran) is recorded. `take` returns p50, p99 and max
//! in milliseconds over the window since the last `take` (or `start`) and opens a fresh one. The probe runs only between
//! `start` and `stop`, so an idle relay pays no tick.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use mixdog_rt::time::{Instant, MissedTickBehavior};

use crate::logline::LoopDelay;

/// The tick period while a probe runs (`LOOP_DELAY_RESOLUTION_MS`).
pub const LAG_RESOLUTION: Duration = Duration::from_millis(20);

/// The lateness samples of one reporting window, in milliseconds.
#[derive(Debug, Default)]
pub struct LagWindow {
    samples: Vec<f64>,
}

impl LagWindow {
    pub fn record(&mut self, lateness_ms: f64) {
        if lateness_ms.is_finite() {
            self.samples.push(lateness_ms.max(0.0));
        }
    }

    /// p50, p99 and max of the window, nearest-rank, and an empty window is all zeros; the window is emptied.
    pub fn take(&mut self) -> LoopDelay {
        let mut sorted = std::mem::take(&mut self.samples);
        sorted.sort_by(f64::total_cmp);
        let rank = |percent: f64| -> f64 {
            if sorted.is_empty() {
                return 0.0;
            }
            let count = sorted.len() as f64;
            let index = ((percent / 100.0 * count).ceil() as usize).clamp(1, sorted.len()) - 1;
            sorted[index]
        };
        LoopDelay { p50: rank(50.0), p99: rank(99.0), max: sorted.last().copied().unwrap_or(0.0) }
    }

    pub fn clear(&mut self) {
        self.samples.clear();
    }
}

fn locked(window: &Mutex<LagWindow>) -> MutexGuard<'_, LagWindow> {
    window.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The tick and its window. Starting a started probe changes nothing; `stop` ends the tick and drops the window.
#[derive(Default)]
pub struct LagProbe {
    window: Arc<Mutex<LagWindow>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl LagProbe {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts the tick on the current runtime.
    pub fn start(&mut self) {
        if self.task.is_some() {
            return;
        }
        let window = Arc::clone(&self.window);
        // The first tick is due one period from now, as `setInterval` does; armed here so the window starts at `start`.
        let mut ticker = mixdog_rt::time::interval_at_unrefed(Instant::now() + LAG_RESOLUTION, LAG_RESOLUTION);
        // A tick that ran late is one late sample, not a burst of catch-up ticks.
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        self.task = Some(tokio::spawn(async move {
            loop {
                let due = ticker.tick().await;
                let lateness = Instant::now().saturating_duration_since(due);
                locked(&window).record(lateness.as_secs_f64() * 1000.0);
            }
        }));
    }

    pub fn stop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        locked(&self.window).clear();
    }

    /// The window since the last `take` (or `start`); a fresh one opens.
    pub fn take(&mut self) -> LoopDelay {
        locked(&self.window).take()
    }
}

impl Drop for LagProbe {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
