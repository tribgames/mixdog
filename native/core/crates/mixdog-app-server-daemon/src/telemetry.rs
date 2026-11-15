//! The daemon's memory and in-flight work telemetry, and the opt-in stall sampler: the port of
//! `src/standalone/daemon-telemetry.mjs` and `daemon-lag-profiler.mjs`.
//!
//! One loop ([`Telemetry::run`]) measures how late a 100 ms timer fires on the runtime (the event-loop lag) and, every 30 s,
//! closes the window: [`Telemetry::tick`]. The memory and work line is written only for a window in which the daemon reported
//! activity ([`Telemetry::note_activity`]), so a crash during work leaves a recent record in `daemon.log` and a daemon at rest
//! writes nothing. A line holds counters only: no session bodies, tokens or environment. Retention is the log's own bound.
//!
//! Two departures from the Node module, both because a native process has none of what V8 reports: there is no managed heap,
//! so `heapUsedBytes` is the memory the process allocated for itself (its private bytes, as the crash record states it), and
//! there are no heap total, heap limit, external or array-buffer fields and no post-GC minimum.
//!
//! The stall sampler is on while `<data dir>/lag-profile.on` exists (a file the user creates by hand; nothing in Mixdog writes
//! it). The file is read once and again only after the data directory reports a change to it (the watch the daemon's discovery
//! uses, `notify`), as Node re-read it on a directory-watch event: a daemon at rest does not look for it, and creating or
//! removing the file starts or stops the sampler at once, without a restart. A window whose lag
//! was bad (p99 or max of a second or more) is kept in `<data dir>/profiles/daemon-lag-<time>.json` (the newest ten) with a
//! summary line in `daemon.log`. V8's CPU profiler has no native counterpart that needs no debug symbols or a second tool, so
//! a kept window holds what the runtime can say about itself: the window's lag, the in-flight work and the state `context`
//! returns (the lanes and spans the wiring chooses).

use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_agent::agent_tool::stamp::iso_from_ms;
use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;
use mixdog_rt::time::Instant;
use mixdog_rt::time::MissedTickBehavior;
use serde_json::Value;
use serde_json::json;

use crate::daemon_log::Clock;

/// `DAEMON_TELEMETRY_INTERVAL_MS`.
pub const INTERVAL: Duration = Duration::from_secs(30);
/// How often the lag probe fires.
pub const LAG_PROBE: Duration = Duration::from_millis(100);
/// The window lag (p99) from which `event-loop lag` is logged.
const LAG_LOG_P99_MS: u64 = 250;
/// `LAG_P99_THRESHOLD_MS` and `LAG_MAX_THRESHOLD_MS`: a window this late is kept by the sampler.
const LAG_KEEP_MS: u64 = 1000;
/// `LAG_PROFILE_FLAG_FILE`.
pub const LAG_PROFILE_FLAG_FILE: &str = "lag-profile.on";
const PROFILE_DIR: &str = "profiles";
/// `LAG_PROFILE_KEEP`.
const PROFILE_KEEP: usize = 10;
const PROFILE_PREFIX: &str = "daemon-lag-";
const PROFILE_SUFFIX: &str = ".json";

/// What is running now (`inFlightWork`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WorkCounts {
    pub active_calls: u64,
    pub queued_calls: u64,
    pub busy_sessions: u64,
    pub busy_memory_agents: u64,
}

/// The process's memory; `None` where the OS does not say.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MemoryUsage {
    /// `process.memoryUsage().rss`: the working set.
    pub rss_bytes: Option<u64>,
    /// The heap equivalent: what the process allocated for itself.
    pub heap_bytes: Option<u64>,
}

/// The lag of one window, in milliseconds.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LagWindow {
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub max_ms: u64,
}

impl LagWindow {
    /// The percentiles of the lateness samples of a window (nearest rank); all zero for none.
    pub fn from_samples(samples: &[u64]) -> Self {
        if samples.is_empty() {
            return Self::default();
        }
        let mut sorted = samples.to_vec();
        sorted.sort_unstable();
        let rank = |q: usize| sorted[(sorted.len() * q).div_ceil(100).max(1) - 1];
        Self { p95_ms: rank(95), p99_ms: rank(99), max_ms: sorted[sorted.len() - 1] }
    }

    /// `isLagWindow`.
    pub fn is_bad(&self) -> bool {
        self.p99_ms >= LAG_KEEP_MS || self.max_ms >= LAG_KEEP_MS
    }
}

fn bytes_field(value: Option<u64>) -> i64 {
    value.and_then(|n| i64::try_from(n).ok()).unwrap_or(-1)
}

/// Why a line was written: `reason=` of `formatDaemonTelemetry`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// Once when the daemon is ready, whatever its activity.
    Boot,
    /// At the end of a window with activity.
    Periodic,
}

impl Reason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Boot => "boot",
            Self::Periodic => "periodic",
        }
    }
}

/// `formatDaemonTelemetry`: one line, counters only.
pub fn format_line(reason: Reason, at_ms: i64, pid: u32, memory: MemoryUsage, work: WorkCounts) -> String {
    format!(
        "daemon-telemetry reason={} ts={} pid={pid} rssBytes={} heapUsedBytes={} activeCalls={} queuedCalls={} busySessions={} busyMemoryAgents={}",
        reason.as_str(),
        iso_from_ms(at_ms),
        bytes_field(memory.rss_bytes),
        bytes_field(memory.heap_bytes),
        work.active_calls,
        work.queued_calls,
        work.busy_sessions,
        work.busy_memory_agents,
    )
}

/// `process.memoryUsage()`'s `rss` and `heapUsed`: the working set, and the private bytes the process allocated.
#[cfg(windows)]
pub fn process_memory() -> MemoryUsage {
    use windows_sys::Win32::System::ProcessStatus::GetProcessMemoryInfo;
    use windows_sys::Win32::System::ProcessStatus::PROCESS_MEMORY_COUNTERS;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    // SAFETY: a plain query of the current process into an out struct of the declared size.
    unsafe {
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        if GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) == 0 {
            return MemoryUsage::default();
        }
        MemoryUsage { rss_bytes: Some(counters.WorkingSetSize as u64), heap_bytes: Some(counters.PagefileUsage as u64) }
    }
}

/// `/proc/self/statm`: resident and data pages; elsewhere neither is known.
#[cfg(not(windows))]
#[allow(clippy::disallowed_methods, reason = "a 40-byte procfs read, the same one the crash record makes")]
pub fn process_memory() -> MemoryUsage {
    let Ok(statm) = std::fs::read_to_string("/proc/self/statm") else { return MemoryUsage::default() };
    let pages: Vec<u64> = statm.split_whitespace().filter_map(|n| n.parse().ok()).collect();
    // SAFETY: sysconf has no preconditions.
    let page = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).unwrap_or(4096);
    MemoryUsage { rss_bytes: pages.get(1).map(|n| n * page), heap_bytes: pages.get(5).map(|n| n * page) }
}

/// The profile directory as the sampler needs it. Each call runs on the maintenance lane.
pub trait ProfileStore: Send + Sync + 'static {
    /// Whether `lag-profile.on` exists.
    fn flag_present(&self, lane: &InLane<MaintenanceIo>) -> bool;
    /// The profile file `name` written, the directory made first.
    fn save(&self, lane: &InLane<MaintenanceIo>, name: &str, bytes: &[u8]) -> io::Result<()>;
    /// The names in the profile directory.
    fn list(&self, lane: &InLane<MaintenanceIo>) -> io::Result<Vec<String>>;
    fn remove(&self, lane: &InLane<MaintenanceIo>, name: &str) -> io::Result<()>;
    /// The folder whose changes can create or remove the flag file; `None` where nothing can be watched.
    fn watch_dir(&self) -> Option<PathBuf> {
        None
    }
}

/// The data directory's flag and `profiles` folder.
pub struct DiskProfileStore {
    data_dir: PathBuf,
}

impl DiskProfileStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    fn dir(&self) -> PathBuf {
        self.data_dir.join(PROFILE_DIR)
    }
}

impl ProfileStore for DiskProfileStore {
    fn flag_present(&self, lane: &InLane<MaintenanceIo>) -> bool {
        mixdog_statefile::metadata(lane, &self.data_dir.join(LAG_PROFILE_FLAG_FILE)).is_ok()
    }

    fn save(&self, lane: &InLane<MaintenanceIo>, name: &str, bytes: &[u8]) -> io::Result<()> {
        mixdog_statefile::create_dir_all(lane, &self.dir())?;
        let opts = mixdog_statefile::Opts { fsync: false, lock: false, ..mixdog_statefile::Opts::default() };
        mixdog_statefile::write_file(lane, &self.dir().join(name), bytes, &opts).map(|_| ()).map_err(|error| io::Error::other(error.to_string()))
    }

    fn list(&self, lane: &InLane<MaintenanceIo>) -> io::Result<Vec<String>> {
        mixdog_statefile::list_dir(lane, &self.dir())
    }

    fn remove(&self, lane: &InLane<MaintenanceIo>, name: &str) -> io::Result<()> {
        mixdog_statefile::remove_file(lane, &self.dir().join(name))
    }

    fn watch_dir(&self) -> Option<PathBuf> {
        Some(self.data_dir.clone())
    }
}

/// What a window's sampler pass did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SamplerOutcome {
    /// No flag file: nothing sampled.
    Off,
    /// The flag is there and the window was not bad.
    Discarded,
    /// The window was kept under this file name.
    Saved(String),
    Failed,
    /// The previous pass has not finished.
    Busy,
}

/// `profileFileName`: `daemon-lag-<ISO with : as ->.json`.
pub fn profile_file_name(at_ms: i64) -> String {
    format!("{PROFILE_PREFIX}{}{PROFILE_SUFFIX}", iso_from_ms(at_ms).replace(':', "-"))
}

fn is_profile_name(name: &str) -> bool {
    name.len() > PROFILE_PREFIX.len() + PROFILE_SUFFIX.len() && name.starts_with(PROFILE_PREFIX) && name.ends_with(PROFILE_SUFFIX)
}

/// The state the wiring adds to a kept window (lane diagnostics, slow spans); `Null` for none.
pub type Context = Arc<dyn Fn() -> Value + Send + Sync>;

struct Sampler {
    store: Arc<dyn ProfileStore>,
    lane: MaintenanceIo,
    cancel: CancellationToken,
    context: Context,
    profile_dir: PathBuf,
    pending: AtomicBool,
    /// `enabled` and `lastFailure`.
    state: Mutex<(bool, String)>,
    /// Whether the flag file was there when it was last read, and whether it may have changed since (true until the first read).
    flag: Mutex<bool>,
    flag_stale: AtomicBool,
}

impl Sampler {
    async fn window(self: &Arc<Self>, at_ms: i64, lag: LagWindow, work: WorkCounts, log: Arc<dyn Fn(&str) + Send + Sync>) -> SamplerOutcome {
        if self.pending.swap(true, Ordering::AcqRel) {
            return SamplerOutcome::Busy;
        }
        let this = Arc::clone(self);
        let job = mixdog_core_base::support::on_lane(self.lane, &self.cancel, move |lane| this.pass(lane, at_ms, lag, work, log.as_ref())).await;
        self.pending.store(false, Ordering::Release);
        job.unwrap_or(SamplerOutcome::Failed)
    }

    /// The flag file's presence: read from the store only for the first window and after a change was reported.
    fn flag_present(&self, lane: &InLane<MaintenanceIo>) -> bool {
        let mut known = self.flag.lock().unwrap_or_else(PoisonError::into_inner);
        if self.flag_stale.swap(false, Ordering::AcqRel) {
            *known = self.store.flag_present(lane);
        }
        *known
    }

    fn fail(&self, stage: &str, error: &dyn std::fmt::Display, log: &(dyn Fn(&str) + Send + Sync)) {
        let message = format!("{stage}: {error}");
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.1 == message {
            return;
        }
        log(&format!("lag-profile failed {message}"));
        state.1 = message;
    }

    fn pass(&self, lane: &InLane<MaintenanceIo>, at_ms: i64, lag: LagWindow, work: WorkCounts, log: &(dyn Fn(&str) + Send + Sync)) -> SamplerOutcome {
        let present = self.flag_present(lane);
        {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            let was = std::mem::replace(&mut state.0, present);
            if !present {
                state.1.clear();
                if was {
                    log("lag-profile disabled");
                }
                return SamplerOutcome::Off;
            }
            if !was {
                log(&format!("lag-profile enabled dir={}", self.profile_dir.display()));
            }
        }
        if !lag.is_bad() {
            return SamplerOutcome::Discarded;
        }
        let name = profile_file_name(at_ms);
        let body = json!({
            "at": iso_from_ms(at_ms),
            "windowMs": u64::try_from(INTERVAL.as_millis()).unwrap_or(u64::MAX),
            "lag": { "p95Ms": lag.p95_ms, "p99Ms": lag.p99_ms, "maxMs": lag.max_ms },
            "work": {
                "activeCalls": work.active_calls,
                "queuedCalls": work.queued_calls,
                "busySessions": work.busy_sessions,
                "busyMemoryAgents": work.busy_memory_agents,
            },
            "state": (self.context)(),
        });
        let bytes = serde_json::to_vec(&body).unwrap_or_default();
        if let Err(error) = self.store.save(lane, &name, &bytes) {
            self.fail("save", &error, log);
            return SamplerOutcome::Failed;
        }
        if let Err(error) = self.prune(lane) {
            self.fail("save", &error, log);
            return SamplerOutcome::Failed;
        }
        log(&format!("lag-profile saved file={name} p99={}ms max={}ms busySessions={}", lag.p99_ms, lag.max_ms, work.busy_sessions));
        SamplerOutcome::Saved(name)
    }

    /// Keeps only the newest [`PROFILE_KEEP`] profiles (names sort by time).
    fn prune(&self, lane: &InLane<MaintenanceIo>) -> io::Result<()> {
        let mut names: Vec<String> = self.store.list(lane)?.into_iter().filter(|name| is_profile_name(name)).collect();
        names.sort();
        let stale = names.len().saturating_sub(PROFILE_KEEP);
        for name in &names[..stale] {
            self.store.remove(lane, name)?;
        }
        Ok(())
    }
}

/// The seams of [`Telemetry`]: the daemon wires the real ones ([`process_memory`], [`crate::daemon_log::system_now_ms`]).
pub struct Seams {
    pub work: Arc<dyn Fn() -> WorkCounts + Send + Sync>,
    pub memory: Arc<dyn Fn() -> MemoryUsage + Send + Sync>,
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
    pub now_ms: Clock,
    pub pid: u32,
}

/// The telemetry loop and the stall sampler.
pub struct Telemetry {
    seams: Seams,
    activity: AtomicBool,
    sampler: Arc<Sampler>,
    /// The watch on the folder of the flag file, held for as long as the loop runs.
    watch: Mutex<Option<notify::RecommendedWatcher>>,
}

impl Telemetry {
    /// `store`, `lane` and `cancel` are the sampler's (the data directory, the maintenance lane, the daemon's run token);
    /// `context` is what a kept window adds (`|| Value::Null` for nothing).
    pub fn new(seams: Seams, store: Arc<dyn ProfileStore>, profile_dir: PathBuf, lane: MaintenanceIo, cancel: CancellationToken, context: Context) -> Arc<Self> {
        let sampler = Arc::new(Sampler { store, lane, cancel, context, profile_dir, pending: AtomicBool::new(false), state: Mutex::new((false, String::new())), flag: Mutex::new(false), flag_stale: AtomicBool::new(true) });
        Arc::new(Self { seams, activity: AtomicBool::new(false), sampler, watch: Mutex::new(None) })
    }

    /// `emit('boot')`: the line written once when the daemon is ready, with or without activity. It leaves the activity of
    /// the first window as it is.
    pub fn boot(&self) {
        let work = (self.seams.work)();
        (self.seams.log)(&format_line(Reason::Boot, (self.seams.now_ms)(), self.seams.pid, (self.seams.memory)(), work));
    }

    /// The daemon did work: the next window writes its memory and work line.
    pub fn note_activity(&self) {
        self.activity.store(true, Ordering::Release);
    }

    /// One window's end: the memory and work line when there was activity, `event-loop lag` when the window was late, and the
    /// sampler's pass (spawned: the loop's timer keeps firing while it waits for the lane).
    pub fn tick(self: &Arc<Self>, lag: LagWindow) {
        let work = (self.seams.work)();
        let at_ms = (self.seams.now_ms)();
        if self.activity.swap(false, Ordering::AcqRel) {
            (self.seams.log)(&format_line(Reason::Periodic, at_ms, self.seams.pid, (self.seams.memory)(), work));
        }
        if lag.p99_ms >= LAG_LOG_P99_MS {
            (self.seams.log)(&format!("event-loop lag p95={}ms p99={}ms max={}ms", lag.p95_ms, lag.p99_ms, lag.max_ms));
        }
        let this = Arc::clone(self);
        tokio::spawn(async move { this.sample(at_ms, lag, work).await });
    }

    /// The flag file may have been created or removed: the next pass reads it again.
    pub fn flag_changed(&self) {
        self.sampler.flag_stale.store(true, Ordering::Release);
    }

    /// Starts watching the folder of the flag file: a change to the file re-reads it and runs a sampler pass at once (so
    /// "enabled" or "disabled" is said when the file appears or goes, as Node said it on the watch event). Without a watch
    /// the file is read once, at the start, and said so.
    fn watch_flag(self: &Arc<Self>) {
        use notify::Watcher;
        let Some(dir) = self.sampler.store.watch_dir() else { return };
        let (weak, runtime) = (Arc::downgrade(self), tokio::runtime::Handle::current());
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let concerns_flag = match &event {
                Ok(event) => event.paths.iter().any(|path| path.file_name().is_some_and(|name| name == LAG_PROFILE_FLAG_FILE)),
                Err(_) => true,
            };
            if !concerns_flag {
                return;
            }
            let Some(this) = weak.upgrade() else { return };
            this.flag_changed();
            let (at_ms, work) = ((this.seams.now_ms)(), (this.seams.work)());
            runtime.spawn(async move { this.sample(at_ms, LagWindow::default(), work).await });
        });
        match watcher.and_then(|mut watcher| watcher.watch(&dir, notify::RecursiveMode::NonRecursive).map(|()| watcher)) {
            Ok(watcher) => *self.watch.lock().unwrap_or_else(PoisonError::into_inner) = Some(watcher),
            Err(error) => (self.seams.log)(&format!("lag-profile: the data folder cannot be watched, so the flag file is read only at start: {error}")),
        }
    }

    /// The sampler's pass for one window.
    pub async fn sample(&self, at_ms: i64, lag: LagWindow, work: WorkCounts) -> SamplerOutcome {
        self.sampler.window(at_ms, lag, work, Arc::clone(&self.seams.log)).await
    }

    /// The loop: a sampler pass at once (`onStart`: with the flag there, the sampler says it is on from the start), then every
    /// [`LAG_PROBE`] the lateness of the timer is recorded and every [`INTERVAL`] the window is closed. Its timer is unrefed, as
    /// Node's was. Ends when `cancel` is cancelled.
    pub async fn run(self: Arc<Self>, cancel: CancellationToken) {
        self.watch_flag();
        let this = Arc::clone(&self);
        let work = (self.seams.work)();
        let at_ms = (self.seams.now_ms)();
        tokio::spawn(async move { this.sample(at_ms, LagWindow::default(), work).await });
        let start = Instant::now();
        let mut probe = mixdog_rt::time::interval_at_unrefed(start + LAG_PROBE, LAG_PROBE);
        probe.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut next_window = start + INTERVAL;
        let mut late_ms: Vec<u64> = Vec::new();
        while !cancel.is_cancelled() {
            let due = probe.tick().await;
            let now = Instant::now();
            late_ms.push(u64::try_from(now.saturating_duration_since(due).as_millis()).unwrap_or(u64::MAX));
            if now >= next_window {
                self.tick(LagWindow::from_samples(&late_ms));
                late_ms.clear();
                next_window = now + INTERVAL;
            }
        }
        drop(self.watch.lock().unwrap_or_else(PoisonError::into_inner).take());
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::atomic::AtomicUsize;

    use super::*;

    fn tokens() -> mixdog_rt::LaneTokens {
        mixdog_rt::testing::tokens()
    }

    /// An in-memory profile directory.
    #[derive(Default)]
    struct MemStore {
        flag: AtomicBool,
        files: Mutex<BTreeSet<String>>,
        fail_save: AtomicBool,
        saves: AtomicUsize,
    }

    impl ProfileStore for MemStore {
        fn flag_present(&self, _: &InLane<MaintenanceIo>) -> bool {
            self.flag.load(Ordering::SeqCst)
        }

        fn save(&self, _: &InLane<MaintenanceIo>, name: &str, bytes: &[u8]) -> io::Result<()> {
            self.saves.fetch_add(1, Ordering::SeqCst);
            if self.fail_save.load(Ordering::SeqCst) {
                return Err(io::Error::other("disk full"));
            }
            assert!(serde_json::from_slice::<Value>(bytes).is_ok());
            self.files.lock().unwrap().insert(name.to_owned());
            Ok(())
        }

        fn list(&self, _: &InLane<MaintenanceIo>) -> io::Result<Vec<String>> {
            let mut names: Vec<String> = self.files.lock().unwrap().iter().cloned().collect();
            names.push("notes.txt".to_owned());
            Ok(names)
        }

        fn remove(&self, _: &InLane<MaintenanceIo>, name: &str) -> io::Result<()> {
            self.files.lock().unwrap().remove(name);
            Ok(())
        }
    }

    struct Fixture {
        telemetry: Arc<Telemetry>,
        store: Arc<MemStore>,
        lines: Arc<Mutex<Vec<String>>>,
    }

    fn fixture() -> Fixture {
        let store = Arc::new(MemStore::default());
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&lines);
        let seams = Seams {
            work: Arc::new(|| WorkCounts { active_calls: 2, queued_calls: 1, busy_sessions: 3, busy_memory_agents: 4 }),
            memory: Arc::new(|| MemoryUsage { rss_bytes: Some(1000), heap_bytes: None }),
            log: Arc::new(move |line| sink.lock().unwrap().push(line.to_owned())),
            now_ms: Arc::new(|| 1_793_925_139_716),
            pid: 77,
        };
        let telemetry = Telemetry::new(seams, store.clone(), PathBuf::from("data/profiles"), tokens().maintenance_io, CancellationToken::new(), Arc::new(|| json!({ "lanes": "ok" })));
        Fixture { telemetry, store, lines }
    }

    fn lines(f: &Fixture) -> Vec<String> {
        f.lines.lock().unwrap().clone()
    }

    #[tokio::test]
    async fn the_line_carries_time_pid_memory_and_counts_only() {
        let f = fixture();
        f.telemetry.note_activity();
        f.telemetry.tick(LagWindow::default());
        assert_eq!(
            lines(&f),
            ["daemon-telemetry reason=periodic ts=2026-11-06T00:32:19.716Z pid=77 rssBytes=1000 heapUsedBytes=-1 activeCalls=2 queuedCalls=1 busySessions=3 busyMemoryAgents=4"]
        );
    }

    #[tokio::test]
    async fn the_boot_line_is_written_without_activity_and_leaves_the_window_silent() {
        let f = fixture();
        f.telemetry.boot();
        assert_eq!(
            lines(&f),
            ["daemon-telemetry reason=boot ts=2026-11-06T00:32:19.716Z pid=77 rssBytes=1000 heapUsedBytes=-1 activeCalls=2 queuedCalls=1 busySessions=3 busyMemoryAgents=4"]
        );
        f.telemetry.tick(LagWindow::default());
        assert_eq!(lines(&f).len(), 1, "the boot line is not activity");
    }

    #[tokio::test]
    async fn a_daemon_at_rest_writes_nothing_and_activity_writes_one_line_per_window() {
        let f = fixture();
        f.telemetry.tick(LagWindow::default());
        f.telemetry.tick(LagWindow::default());
        assert!(lines(&f).is_empty());
        f.telemetry.note_activity();
        f.telemetry.note_activity();
        f.telemetry.tick(LagWindow::default());
        assert_eq!(lines(&f).len(), 1);
        f.telemetry.tick(LagWindow::default());
        assert_eq!(lines(&f).len(), 1, "the activity of one window is spent by its line");
    }

    #[tokio::test]
    async fn a_late_window_logs_its_lag_with_or_without_activity() {
        let f = fixture();
        f.telemetry.tick(LagWindow { p95_ms: 100, p99_ms: 249, max_ms: 300 });
        assert!(lines(&f).is_empty());
        f.telemetry.tick(LagWindow { p95_ms: 100, p99_ms: 250, max_ms: 300 });
        assert_eq!(lines(&f), ["event-loop lag p95=100ms p99=250ms max=300ms"]);
    }

    #[test]
    fn percentiles_are_nearest_rank_and_empty_is_zero() {
        assert_eq!(LagWindow::from_samples(&[]), LagWindow::default());
        let samples: Vec<u64> = (1..=100).collect();
        assert_eq!(LagWindow::from_samples(&samples), LagWindow { p95_ms: 95, p99_ms: 99, max_ms: 100 });
        assert!(LagWindow { p95_ms: 0, p99_ms: 0, max_ms: 1000 }.is_bad());
        assert!(!LagWindow { p95_ms: 999, p99_ms: 999, max_ms: 999 }.is_bad());
    }

    #[test]
    fn profile_names_sort_by_time_and_hold_no_colon() {
        let name = profile_file_name(1_793_925_139_716);
        assert_eq!(name, "daemon-lag-2026-11-06T00-32-19.716Z.json");
        assert!(is_profile_name(&name) && !is_profile_name("notes.txt"));
    }

    const BAD: LagWindow = LagWindow { p95_ms: 900, p99_ms: 1200, max_ms: 3000 };

    #[tokio::test]
    async fn the_sampler_is_off_without_the_flag_and_says_nothing() {
        let f = fixture();
        let out = f.telemetry.sample(1_793_925_139_716, BAD, WorkCounts::default()).await;
        assert_eq!(out, SamplerOutcome::Off);
        assert!(lines(&f).is_empty() && f.store.saves.load(Ordering::SeqCst) == 0);
    }

    #[tokio::test]
    async fn the_flag_starts_and_stops_the_sampler_without_a_restart() {
        let f = fixture();
        let at = 1_793_925_139_716;
        f.store.flag.store(true, Ordering::SeqCst);
        f.telemetry.flag_changed();
        assert_eq!(f.telemetry.sample(at, LagWindow::default(), WorkCounts::default()).await, SamplerOutcome::Discarded);
        assert_eq!(lines(&f), ["lag-profile enabled dir=data/profiles"]);
        assert_eq!(f.telemetry.sample(at, LagWindow::default(), WorkCounts::default()).await, SamplerOutcome::Discarded);
        assert_eq!(lines(&f).len(), 1, "enabled is said once");
        f.store.flag.store(false, Ordering::SeqCst);
        assert_eq!(f.telemetry.sample(at, LagWindow::default(), WorkCounts::default()).await, SamplerOutcome::Discarded, "nothing reported the change: the file is not read again");
        f.telemetry.flag_changed();
        assert_eq!(f.telemetry.sample(at, BAD, WorkCounts::default()).await, SamplerOutcome::Off);
        assert_eq!(lines(&f).last().unwrap(), "lag-profile disabled");
        assert_eq!(f.telemetry.sample(at, BAD, WorkCounts::default()).await, SamplerOutcome::Off);
        assert_eq!(lines(&f).len(), 2, "disabled is said once");
    }

    #[tokio::test]
    async fn only_a_late_window_is_kept_and_the_newest_ten_stay() {
        let f = fixture();
        f.store.flag.store(true, Ordering::SeqCst);
        let work = WorkCounts { busy_sessions: 5, ..WorkCounts::default() };
        assert_eq!(f.telemetry.sample(0, LagWindow { p95_ms: 10, p99_ms: 999, max_ms: 999 }, work).await, SamplerOutcome::Discarded);
        assert!(f.store.files.lock().unwrap().is_empty());
        for n in 0..12 {
            let out = f.telemetry.sample(1_793_925_139_716 + n * 30_000, BAD, work).await;
            assert!(matches!(out, SamplerOutcome::Saved(_)));
        }
        let kept: Vec<String> = f.store.files.lock().unwrap().iter().cloned().collect();
        assert_eq!(kept.len(), 10);
        assert_eq!(kept[0], profile_file_name(1_793_925_139_716 + 2 * 30_000));
        assert!(lines(&f).last().unwrap().starts_with("lag-profile saved file=daemon-lag-2026-11-06T00-37-49.716Z.json p99=1200ms max=3000ms busySessions=5"));
    }

    #[tokio::test]
    async fn a_failed_save_is_reported_once_per_cause() {
        let f = fixture();
        f.store.flag.store(true, Ordering::SeqCst);
        f.store.fail_save.store(true, Ordering::SeqCst);
        assert_eq!(f.telemetry.sample(0, BAD, WorkCounts::default()).await, SamplerOutcome::Failed);
        assert_eq!(f.telemetry.sample(1, BAD, WorkCounts::default()).await, SamplerOutcome::Failed);
        let failures: Vec<String> = lines(&f).into_iter().filter(|l| l.starts_with("lag-profile failed")).collect();
        assert_eq!(failures, ["lag-profile failed save: disk full"]);
    }

    #[tokio::test]
    async fn a_sampler_pass_that_is_still_running_is_busy() {
        let f = fixture();
        f.telemetry.sampler.pending.store(true, Ordering::SeqCst);
        assert_eq!(f.telemetry.sample(0, BAD, WorkCounts::default()).await, SamplerOutcome::Busy);
    }

    #[test]
    fn the_real_memory_read_answers() {
        let memory = process_memory();
        assert!(memory.rss_bytes.is_some_and(|n| n > 0));
    }
}
