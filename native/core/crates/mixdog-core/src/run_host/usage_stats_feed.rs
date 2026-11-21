//! Intervals follow Node's `REMOTE_STATS_REFRESH_INTERVAL_MS` ([`REFRESH_INTERVAL`]) and `USAGE_DASHBOARD_REFRESH_INTERVAL_MS` ([`DASHBOARD_INTERVAL`]).

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

/// Waits for the next ledger change or binding; `false` when the writer is gone.
async fn woken(changes: &mut watch::Receiver<u64>, bindings: &mut Option<watch::Receiver<u64>>) -> bool {
    match bindings {
        Some(bindings) => tokio::select! {
            changed = changes.changed() => changed.is_ok(),
            bound = bindings.changed() => bound.is_ok(),
        },
        None => changes.changed().await.is_ok(),
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
            if let Some(began) = stamp {
                mixdog_rt::time::sleep_until(began + interval).await;
            }
            let Some(live) = source.upgrade() else { return };
            // Whatever was signalled while waiting is in this read, too.
            changes.borrow_and_update();
            stamp = Some(Instant::now());
            match live.read(&push.clock).await {
                Ok(value) => match change_of(&value) {
                    SectionChange::Stub { count } => {
                        tracing::warn!(key, count, "[usage] the entry exceeds the inline section limit and was not published");
                    }
                    change => push.publisher.publish(SectionName::Usage, Some(key.to_owned()), change),
                },
                Err(error) => tracing::warn!(key, %error, "[usage] the entry could not be read for the usage section"),
            }
        }
        if !woken(&mut changes, &mut bindings).await {
            return;
        }
    }
}
