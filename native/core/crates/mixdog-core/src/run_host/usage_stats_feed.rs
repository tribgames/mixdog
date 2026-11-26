//! Intervals follow Node's `REMOTE_STATS_REFRESH_INTERVAL_MS` ([`REFRESH_INTERVAL`]) and `USAGE_DASHBOARD_REFRESH_INTERVAL_MS` ([`DASHBOARD_INTERVAL`]).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::accounts::AccountStore;
use mixdog_core_api::state::{SectionChange, StatePublisher};
use mixdog_core_base::state::change_of;
use mixdog_core_domains::domains::ai_account::dashboards::Dashboards;
use mixdog_core_domains::domains::ai_account::usage::dashboard::UsageSources;
use mixdog_ledger::ledger::UsageLedger;
use mixdog_ledger::stats::UsageStatsOptions;
use mixdog_ledger::writer::UsageChanged;
use mixdog_protocol::SectionName;
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio::time::Instant;

/// The key of the statistics entry in the `usage` section.
pub const STATS_KEY: &str = "stats";
/// The key of the dashboard entry in the `usage` section.
pub const DASHBOARD_KEY: &str = "dashboard";

/// `REMOTE_STATS_REFRESH_INTERVAL_MS`: the least time between the starts of two statistics reads.
pub const REFRESH_INTERVAL: Duration = Duration::from_millis(30_000);
/// `USAGE_DASHBOARD_REFRESH_INTERVAL_MS`: the least time between the starts of two dashboard reads.
pub const DASHBOARD_INTERVAL: Duration = Duration::from_millis(5 * 60_000);
/// Small settle offset after a quota window's `resetAt` passes before polling upstream.
pub const RESET_SETTLE_DELAY: Duration = Duration::from_secs(2);
/// Bounded follow-up delays if upstream still echoes an elapsed `resetAt` briefly due to clock skew or caching.
pub const RESET_FOLLOWUP_DELAYS: [Duration; 3] = [Duration::from_secs(5), Duration::from_secs(15), Duration::from_secs(30)];
const MAX_RESET_HORIZON_MS: i64 = 365 * 24 * 60 * 60 * 1_000;

/// `Date.now()`, in milliseconds.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// Where the entries go, the clock the statistics are read with, and the dashboard's source (bound by the
/// composition once the provider services exist; the ledger is opened earlier).
#[derive(Clone)]
pub struct UsagePush {
    pub publisher: Arc<dyn StatePublisher>,
    pub clock: Clock,
    pub dashboard: Arc<DashboardSlot>,
}

impl UsagePush {
    pub fn new(publisher: Arc<dyn StatePublisher>, clock: Clock) -> Self {
        Self { publisher, clock, dashboard: Arc::new(DashboardSlot::default()) }
    }
}

/// The question the statistics dialog asks (`refreshStatsDataCache`).
pub fn dialog_question() -> UsageStatsOptions {
    UsageStatsOptions { view: Some("hour".into()), ..UsageStatsOptions::default() }
}

/// The question the dashboard store asks on its refresh (`runRefresh`): provider quotas live, the setup scan not repeated.
pub fn dashboard_question() -> Value {
    json!({ "refresh": true, "refreshSetup": false })
}

/// The writer's signal as a counter the feeds watch; many signals before a read are one.
pub struct Changed(watch::Sender<u64>);

pub fn changes() -> (Arc<Changed>, watch::Receiver<u64>) {
    let (sender, receiver) = watch::channel(0);
    (Arc::new(Changed(sender)), receiver)
}

impl UsageChanged for Changed {
    fn usage_changed(&self) {
        self.0.send_modify(|count| *count += 1);
    }
}

/// What a feed reads: the service's answer to the renderer's question.
#[async_trait]
pub trait SectionSource: Send + Sync + 'static {
    async fn read(&self, clock: &Clock) -> Result<Value, String>;

    /// Whether there is anything to read yet; a source that is not ready is waited for, not read.
    fn ready(&self) -> bool {
        true
    }
}

#[async_trait]
impl SectionSource for UsageLedger {
    async fn read(&self, clock: &Clock) -> Result<Value, String> {
        let clock = clock.clone();
        self.get_usage_stats(dialog_question(), move || clock()).await.map_err(|error| error.to_string())
    }
}

/// `usage/getUsageDashboard` over the provider usage services.
pub struct DashboardReading {
    pub dashboards: Arc<Dashboards>,
    pub sources: Arc<dyn UsageSources>,
    pub accounts: AccountStore,
}

#[async_trait]
impl SectionSource for DashboardReading {
    async fn read(&self, clock: &Clock) -> Result<Value, String> {
        self.dashboards.read_at(&dashboard_question(), self.sources.as_ref(), &self.accounts, clock()).await.map_err(|failure| failure.message().to_owned())
    }
}

/// The dashboard source, bound once by the composition. A read before the binding is an error, not an empty answer;
/// the binding itself wakes the dashboard feeds, so their first value does not wait for a ledger change.
pub struct DashboardSlot {
    source: OnceLock<Arc<dyn SectionSource>>,
    bound: watch::Sender<u64>,
}

impl Default for DashboardSlot {
    fn default() -> Self {
        Self { source: OnceLock::new(), bound: watch::channel(0).0 }
    }
}

impl DashboardSlot {
    pub fn bind(&self, source: Arc<dyn SectionSource>) -> Result<(), &'static str> {
        self.source.set(source).map_err(|_| "the usage dashboard source is already bound")?;
        self.bound.send_modify(|count| *count += 1);
        Ok(())
    }

    /// Fires once the source is bound.
    fn bindings(&self) -> watch::Receiver<u64> {
        self.bound.subscribe()
    }
}

#[async_trait]
impl SectionSource for DashboardSlot {
    async fn read(&self, clock: &Clock) -> Result<Value, String> {
        match self.source.get() {
            Some(source) => source.read(clock).await,
            None => Err("the usage dashboard source is not bound".to_owned()),
        }
    }

    fn ready(&self) -> bool {
        self.source.get().is_some()
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Wake {
    Closed,
    Signal,
    Reset,
}

struct DashboardResetWindow {
    key: String,
    reset_at: i64,
}

fn dashboard_reset_windows(value: &Value) -> Vec<DashboardResetWindow> {
    let mut out = Vec::new();
    let Some(rows) = value.get("rows").and_then(Value::as_array) else { return out };
    for (row_idx, row) in rows.iter().enumerate() {
        let Some(windows) = row.get("windows").and_then(Value::as_array) else { continue };
        let provider = row.get("id").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map_or_else(|| format!("row:{row_idx}"), str::to_owned);
        let account = row.get("credentialStamp").or_else(|| row.get("accountId")).and_then(Value::as_str).map(str::trim).unwrap_or("");
        let mut seen_labels: HashMap<String, usize> = HashMap::new();
        for (win_idx, window) in windows.iter().enumerate() {
            let Some(raw) = window.get("resetAt").and_then(Value::as_f64) else { continue };
            if !raw.is_finite() || raw <= 0.0 {
                continue;
            }
            let base = ["id", "window", "period", "label"]
                .iter()
                .find_map(|field| window.get(*field).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()))
                .map_or_else(|| format!("window:{win_idx}"), str::to_lowercase);
            let occ = seen_labels.entry(base.clone()).or_insert(0);
            let key = format!("{provider}\u{1f}{account}\u{1f}{base}\u{1f}{occ}");
            *occ += 1;
            out.push(DashboardResetWindow { key, reset_at: raw.round() as i64 });
        }
    }
    out
}

struct ElapsedWindowState {
    attempts: usize,
    next_due_at: Option<i64>,
    transport_failed: bool,
}

impl ElapsedWindowState {
    fn schedule_followup(&mut self, now_ms: i64) -> Option<Duration> {
        let delay = RESET_FOLLOWUP_DELAYS.get(self.attempts).copied();
        self.attempts += 1;
        if let Some(delay) = delay {
            let delay_ms = i64::try_from(delay.as_millis()).unwrap_or(0);
            self.next_due_at = Some(now_ms.saturating_add(delay_ms));
            Some(delay)
        } else {
            self.next_due_at = None;
            None
        }
    }
}

#[derive(Default)]
struct ResetSchedule {
    elapsed: HashMap<String, ElapsedWindowState>,
    known_future_resets: Vec<DashboardResetWindow>,
}

impl ResetSchedule {
    fn next_deadline(&mut self, value: &Value, read_started_ms: i64, now_ms: i64, now_instant: Instant) -> Option<Instant> {
        let windows = dashboard_reset_windows(value);
        let active_elapsed: HashSet<&str> = windows.iter().filter(|w| w.reset_at <= now_ms).map(|w| w.key.as_str()).collect();
        self.elapsed.retain(|key, _| active_elapsed.contains(key.as_str()));

        self.known_future_resets.clear();
        let settle_ms = i64::try_from(RESET_SETTLE_DELAY.as_millis()).unwrap_or(2_000);
        let mut soonest_delay: Option<Duration> = None;
        let mut consider = |delay: Duration| {
            soonest_delay = Some(soonest_delay.map_or(delay, |current| current.min(delay)));
        };

        for window in &windows {
            if window.reset_at > now_ms {
                let remaining_ms = window.reset_at - now_ms;
                if remaining_ms <= MAX_RESET_HORIZON_MS {
                    self.known_future_resets.push(DashboardResetWindow { key: window.key.clone(), reset_at: window.reset_at });
                    consider(Duration::from_millis(remaining_ms as u64) + RESET_SETTLE_DELAY);
                }
                continue;
            }

            let entry = self.elapsed.entry(window.key.clone()).or_insert_with(|| ElapsedWindowState {
                attempts: 0,
                next_due_at: Some(window.reset_at.saturating_add(settle_ms)),
                transport_failed: false,
            });

            if entry.transport_failed {
                entry.transport_failed = false;
                if let Some(delay) = entry.schedule_followup(now_ms) {
                    consider(delay);
                }
            } else if let Some(due_at) = entry.next_due_at {
                if read_started_ms >= due_at {
                    if let Some(delay) = entry.schedule_followup(now_ms) {
                        consider(delay);
                    }
                } else {
                    let remaining_ms = due_at.saturating_sub(now_ms).max(0);
                    consider(Duration::from_millis(remaining_ms as u64));
                }
            }
        }

        soonest_delay.and_then(|delay| now_instant.checked_add(delay))
    }

    fn next_deadline_after_failure(&mut self, read_started_ms: i64, now_ms: i64, now_instant: Instant) -> Option<Instant> {
        let settle_ms = i64::try_from(RESET_SETTLE_DELAY.as_millis()).unwrap_or(2_000);
        let mut soonest_delay: Option<Duration> = None;
        let mut consider = |delay: Duration| {
            soonest_delay = Some(soonest_delay.map_or(delay, |current| current.min(delay)));
        };
        let mut remaining_future = Vec::with_capacity(self.known_future_resets.len());
        for window in self.known_future_resets.drain(..) {
            let settle_at = window.reset_at.saturating_add(settle_ms);
            if settle_at > read_started_ms {
                let remaining_ms = settle_at.saturating_sub(now_ms).max(0);
                if remaining_ms <= MAX_RESET_HORIZON_MS {
                    consider(Duration::from_millis(remaining_ms as u64));
                }
                remaining_future.push(window);
            } else {
                self.elapsed
                    .entry(window.key)
                    .and_modify(|entry| {
                        entry.next_due_at = None;
                        entry.transport_failed = true;
                    })
                    .or_insert(ElapsedWindowState { attempts: 0, next_due_at: None, transport_failed: true });
            }
        }
        self.known_future_resets = remaining_future;
        for entry in self.elapsed.values_mut() {
            if let Some(due_at) = entry.next_due_at {
                if due_at > read_started_ms {
                    let remaining_ms = due_at.saturating_sub(now_ms).max(0);
                    if remaining_ms <= MAX_RESET_HORIZON_MS {
                        consider(Duration::from_millis(remaining_ms as u64));
                    }
                } else {
                    entry.next_due_at = None;
                    entry.transport_failed = true;
                }
            }
        }
        soonest_delay.and_then(|delay| now_instant.checked_add(delay))
    }
}

/// Waits for the next ledger change, binding, or reset deadline; `Wake::Closed` when the writer is gone.
async fn woken(changes: &mut watch::Receiver<u64>, bindings: &mut Option<watch::Receiver<u64>>, reset_deadline: Option<Instant>) -> Wake {
    let sleep_reset = async {
        match reset_deadline {
            Some(deadline) => mixdog_rt::time::sleep_until(deadline).await,
            None => std::future::pending::<()>().await,
        }
    };
    match bindings {
        Some(bindings) => tokio::select! {
            biased;
            changed = changes.changed() => if changed.is_ok() { Wake::Signal } else { Wake::Closed },
            bound = bindings.changed() => if bound.is_ok() { Wake::Signal } else { Wake::Closed },
            () = sleep_reset => Wake::Reset,
        },
        None => tokio::select! {
            biased;
            changed = changes.changed() => if changed.is_ok() { Wake::Signal } else { Wake::Closed },
            () = sleep_reset => Wake::Reset,
        },
    }
}

/// A push into a recording publisher, for tests of the ledger's other behaviour.
#[cfg(any(test, feature = "test-support"))]
#[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
pub(crate) fn recording_push() -> UsagePush {
    UsagePush::new(Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), Arc::new(|| chrono::Utc::now().timestamp_millis()))
}
#[cfg(test)]
mod feed_tests;

/// Starts both feeds of one opened ledger. The statistics feed holds the ledger weakly (it never keeps a
/// closed ledger alive); both end when the writer is gone.
pub fn spawn_feeds(ledger: &Arc<UsageLedger>, changes: watch::Receiver<u64>, push: &UsagePush) {
    spawn(Arc::downgrade(ledger), STATS_KEY, REFRESH_INTERVAL, changes.clone(), None, push.clone());
    spawn(Arc::downgrade(&push.dashboard), DASHBOARD_KEY, DASHBOARD_INTERVAL, changes, Some(push.dashboard.bindings()), push.clone());
}
/// Publishes `source`'s answer under `key`: once at startup (a client that subscribes later is handed the entry
/// the section holds, so the first value never waits for a ledger change), again whenever `changes` says the figures
/// moved, and when `bindings` says the source became readable; until the writer or the source is gone.
pub fn spawn<S: SectionSource>(
    source: Weak<S>,
    key: &'static str,
    interval: Duration,
    changes: watch::Receiver<u64>,
    bindings: Option<watch::Receiver<u64>>,
    push: UsagePush,
) {
    tokio::spawn(run(source, key, changes, bindings, push, interval));
}
async fn run<S: SectionSource>(
    source: Weak<S>,
    key: &'static str,
    mut changes: watch::Receiver<u64>,
    mut bindings: Option<watch::Receiver<u64>>,
    push: UsagePush,
    interval: Duration,
) {
    let mut stamp: Option<Instant> = None;
    let mut reset_schedule = ResetSchedule::default();
    let mut reset_deadline: Option<Instant> = None;
    let mut wake = Wake::Signal;
    loop {
        // Everything signalled so far is covered by the read below; a signal during it is the next one.
        changes.borrow_and_update();
        if let Some(bindings) = &mut bindings {
            bindings.borrow_and_update();
        }
        let Some(live) = source.upgrade() else { return };
        // A source that is not bound yet is not read (there is nothing to fail): the binding is the trigger.
        let ready = live.ready();
        drop(live);
        if ready {
            if wake != Wake::Reset
                && let Some(began) = stamp
            {
                let throttle_until = began + interval;
                let wait_until = reset_deadline.map_or(throttle_until, |deadline| deadline.min(throttle_until));
                mixdog_rt::time::sleep_until(wait_until).await;
            }
            let Some(live) = source.upgrade() else { return };
            // Whatever was signalled while waiting is in this read, too.
            changes.borrow_and_update();
            let read_started_ms = (push.clock)();
            stamp = Some(Instant::now());
            match live.read(&push.clock).await {
                Ok(value) => {
                    if key == DASHBOARD_KEY {
                        reset_deadline = reset_schedule.next_deadline(&value, read_started_ms, (push.clock)(), Instant::now());
                    }
                    match change_of(&value) {
                        SectionChange::Stub { count } => {
                            tracing::warn!(key, count, "[usage] the entry exceeds the inline section limit and was not published");
                        }
                        change => push.publisher.publish(SectionName::Usage, Some(key.to_owned()), change),
                    }
                }
                Err(error) => {
                    if key == DASHBOARD_KEY {
                        reset_deadline = reset_schedule.next_deadline_after_failure(read_started_ms, (push.clock)(), Instant::now());
                    } else {
                        reset_deadline = None;
                    }
                    tracing::warn!(key, %error, "[usage] the entry could not be read for the usage section");
                }
            }
        }
        wake = woken(&mut changes, &mut bindings, reset_deadline).await;
        if wake == Wake::Closed {
            return;
        }
    }
}
