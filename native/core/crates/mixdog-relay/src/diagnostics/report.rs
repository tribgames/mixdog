//! The 30 s socket line: `[relay] sockets 30s phones=N buffered desktop:<8>=..KB phone:<8>=.. loop-p50=..ms ...`, written only
//! while at least one phone is attached. A cheap watch tick (5 s) starts the lag probe when the first connection (a desktop
//! leg or a phone) appears and stops it when the last one is gone; each report covers the window since the previous one (or
//! since sampling started). The buffered values come from a snapshot the legs code passes in.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use mixdog_rt::time::Instant;

use super::lag::LagProbe;
use crate::js::js_slice;
use crate::logline::{self, Line, LoopDelay, SocketBuffer};

pub const SOCKET_REPORT_INTERVAL: Duration = Duration::from_secs(30);
/// How often the relay looks for a connection to start or stop sampling.
const WATCH_INTERVAL: Duration = Duration::from_secs(5);

/// One phone's socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneSocket {
    pub client_id: String,
    /// The socket's `buffered_amount` in bytes.
    pub buffered: u64,
}

/// One live desktop entry: its leg socket (if attached) and its phones.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopSockets {
    pub device_id: String,
    pub socket_attached: bool,
    /// The leg socket's `buffered_amount` in bytes; 0 when no socket is attached.
    pub socket_buffered: u64,
    pub phones: Vec<PhoneSocket>,
}

/// What the legs code reports: every live desktop entry, read when asked.
pub type Snapshot = Arc<dyn Fn() -> Vec<DesktopSockets> + Send + Sync>;

/// The watch tick: 5 s, or the whole interval when that is shorter.
pub fn watch_interval(interval: Duration) -> Duration {
    interval.min(WATCH_INTERVAL)
}

/// The sockets of every desktop that has a phone attached, and the phone count.
pub fn collect_sockets(desktops: &[DesktopSockets]) -> (usize, Vec<SocketBuffer>) {
    let mut sockets = Vec::new();
    let mut phones = 0;
    for desktop in desktops {
        if desktop.phones.is_empty() {
            continue;
        }
        phones += desktop.phones.len();
        sockets.push(SocketBuffer {
            name: format!("desktop:{}", js_slice(&desktop.device_id, 8)),
            buffered_bytes: desktop.socket_buffered as f64,
        });
        for phone in &desktop.phones {
            sockets.push(SocketBuffer { name: format!("phone:{}", js_slice(&phone.client_id, 8)), buffered_bytes: phone.buffered as f64 });
        }
    }
    (phones, sockets)
}

/// A desktop leg or a phone is attached.
fn any_connection(desktops: &[DesktopSockets]) -> bool {
    desktops.iter().any(|desktop| desktop.socket_attached || !desktop.phones.is_empty())
}

/// The probe the report reads: [`LagProbe`] in the relay, a scripted one in tests.
pub trait LoopDelayProbe: Send {
    fn start(&mut self);
    fn stop(&mut self);
    fn take(&mut self) -> LoopDelay;
}

impl LoopDelayProbe for LagProbe {
    fn start(&mut self) {
        Self::start(self);
    }
    fn stop(&mut self) {
        Self::stop(self);
    }
    fn take(&mut self) -> LoopDelay {
        Self::take(self)
    }
}

type Write = Box<dyn FnMut(&Line) + Send>;

struct State {
    snapshot: Snapshot,
    interval: Duration,
    ticks_per_report: u32,
    write: Write,
    probe: Box<dyn LoopDelayProbe>,
    sampling: bool,
    ticks: u32,
    stopped: bool,
}

impl State {
    fn tick(&mut self) {
        let desktops = (self.snapshot)();
        if !any_connection(&desktops) {
            if self.sampling {
                self.probe.stop();
            }
            self.sampling = false;
            self.ticks = 0;
            return;
        }
        if !self.sampling {
            self.probe.start();
            self.sampling = true;
            self.ticks = 0;
        }
        self.ticks += 1;
        if self.ticks < self.ticks_per_report {
            return;
        }
        self.ticks = 0;
        let loop_delay = self.probe.take();
        let (phones, sockets) = collect_sockets(&desktops);
        if phones == 0 {
            return;
        }
        let interval_ms = u64::try_from(self.interval.as_millis()).unwrap_or(u64::MAX);
        (self.write)(&logline::sockets_report(phones, &sockets, &loop_delay, interval_ms));
    }

    fn stop(&mut self) {
        if self.sampling {
            self.probe.stop();
        }
        self.sampling = false;
        self.stopped = true;
    }
}

fn locked(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The running report. `stop` (or a drop) ends the watch tick and the probe.
pub struct SocketDiagnostics {
    state: Arc<Mutex<State>>,
    task: tokio::task::JoinHandle<()>,
}

impl SocketDiagnostics {
    pub fn stop(&self) {
        locked(&self.state).stop();
        self.task.abort();
    }
}

impl Drop for SocketDiagnostics {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The relay's report: every 30 s to the relay's log, measured by the scheduling-lag probe. Call inside the relay's runtime.
pub fn start_socket_diagnostics(snapshot: Snapshot) -> SocketDiagnostics {
    start_socket_diagnostics_with(snapshot, SOCKET_REPORT_INTERVAL, Box::new(|line| logline::emit(line)), Box::new(LagProbe::new()))
}

/// [`start_socket_diagnostics`] with its interval, its writer and its probe given.
pub fn start_socket_diagnostics_with(snapshot: Snapshot, interval: Duration, write: Write, probe: Box<dyn LoopDelayProbe>) -> SocketDiagnostics {
    let watch = watch_interval(interval);
    let ratio = (interval.as_secs_f64() / watch.as_secs_f64()).round();
    let ticks_per_report = if ratio.is_finite() && ratio >= 1.0 { ratio as u32 } else { 1 };
    let state = Arc::new(Mutex::new(State { snapshot, interval, ticks_per_report, write, probe, sampling: false, ticks: 0, stopped: false }));
    // `setInterval(.., watch).unref()`: the first tick is due one period from now.
    let mut ticker = mixdog_rt::time::interval_at_unrefed(Instant::now() + watch, watch);
    let shared = Arc::clone(&state);
    let task = tokio::spawn(async move {
        loop {
            ticker.tick().await;
            let mut state = locked(&shared);
            if state.stopped {
                break;
            }
            state.tick();
        }
    });
    SocketDiagnostics { state, task }
}
