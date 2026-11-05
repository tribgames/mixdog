//! The stall monitor (LR §5.4 Crash, SPEC R48): it reports and never acts. A dedicated OS
//! thread posts a probe task onto the async runtime and measures how long the previous probe
//! has been waiting. It does not kill, restart or fence; the user terminates through the
//! control listener.

#![allow(clippy::disallowed_methods, reason = "diagnostics are appended by the monitor OS thread, which exists to survive a stalled runtime")]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use super::handle::Lifecycle;
use super::ports::CorePort;

/// Runs a closure on the async runtime the monitor watches.
pub type Post = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

/// A [`Post`] that spawns onto `handle`.
pub fn tokio_post(handle: tokio::runtime::Handle) -> Post {
    Arc::new(move |job| {
        handle.spawn(async move { job() });
    })
}

#[derive(Debug, Clone, Copy)]
pub struct StallConfig {
    /// How often a probe is posted and the wait measured.
    pub interval: Duration,
    /// A probe waiting this long counts as a stall worth reporting.
    pub report_after: Duration,
}

impl Default for StallConfig {
    fn default() -> Self {
        Self { interval: Duration::from_secs(1), report_after: Duration::from_secs(2) }
    }
}

/// Where a measurement goes: `core/health` on the feed and the diagnostics file.
pub struct StallReporter {
    core: Arc<dyn CorePort>,
    diagnostics: PathBuf,
    peak_ms: Mutex<u64>,
}

impl StallReporter {
    pub fn new(core: Arc<dyn CorePort>, diagnostics: PathBuf) -> Self {
        Self { core, diagnostics, peak_ms: Mutex::new(0) }
    }

    /// `stalled_ms == 0` means the runtime answered. The file gets one line when a stall
    /// starts and one when it ends.
    fn report(&self, stalled_ms: u64) {
        let mut peak = self.peak_ms.lock().unwrap_or_else(PoisonError::into_inner);
        let event = match (*peak, stalled_ms) {
            (0, 0) => None,
            (0, _) => Some("stalled"),
            (_, 0) => Some("recovered"),
            _ => None,
        };
        let line_ms = if stalled_ms == 0 { *peak } else { stalled_ms };
        *peak = if stalled_ms == 0 { 0 } else { (*peak).max(stalled_ms) };
        drop(peak);
        self.core.health(stalled_ms);
        if let Some(event) = event {
            self.append(event, line_ms);
        }
    }

    fn append(&self, event: &str, stalled_ms: u64) {
        use std::io::Write;
        let at_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
        let line = format!("{{\"event\":\"{event}\",\"atMs\":{at_ms},\"stalledMs\":{stalled_ms}}}\n");
        let written = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.diagnostics)
            .and_then(|mut file| file.write_all(line.as_bytes()));
        if let Err(error) = written {
            tracing::error!(%error, "stall diagnostics were not written");
        }
    }
}

pub struct StallMonitor {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl StallMonitor {
    pub fn spawn(
        config: StallConfig,
        post: Post,
        lifecycle: Arc<Lifecycle>,
        reporter: StallReporter,
    ) -> Self {
        let (stop, wake) = mpsc::channel::<()>();
        let thread = std::thread::Builder::new()
            .name("mixdog-stall-monitor".into())
            .spawn(move || watch(config, post, &lifecycle, &reporter, &wake))
            .expect("the OS refused the stall monitor thread");
        Self { stop: Some(stop), thread: Some(thread) }
    }
}

impl Drop for StallMonitor {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn watch(
    config: StallConfig,
    post: Post,
    lifecycle: &Lifecycle,
    reporter: &StallReporter,
    wake: &mpsc::Receiver<()>,
) {
    let origin = Instant::now();
    // Milliseconds since `origin` plus one at which the outstanding probe was posted; 0 = none.
    let outstanding = Arc::new(AtomicU64::new(0));
    loop {
        if !matches!(wake.recv_timeout(config.interval), Err(mpsc::RecvTimeoutError::Timeout)) {
            return;
        }
        let now = u64::try_from(origin.elapsed().as_millis()).unwrap_or(u64::MAX);
        let posted = outstanding.load(Ordering::Acquire);
        let waited = if posted == 0 {
            outstanding.store(now + 1, Ordering::Release);
            let answered = Arc::clone(&outstanding);
            post(Box::new(move || answered.store(0, Ordering::Release)));
            0
        } else {
            now.saturating_sub(posted - 1)
        };
        let stalled = if u128::from(waited) >= config.report_after.as_millis() { waited } else { 0 };
        lifecycle.set_stalled_ms(stalled);
        reporter.report(stalled);
    }
}
