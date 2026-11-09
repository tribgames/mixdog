use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::registry::keys::Environment;
use mixdog_core_domains::domains::ai_account::dashboards::SetupSource;
use mixdog_ledger::LedgerError;
use mixdog_ledger::refresh::Pricer;
use mixdog_ledger::repair::{PriceRequest, Priced};
use serde_json::json;
use tokio::sync::mpsc;

use super::*;
use crate::run_host::ledger_source::LedgerSource;

/// The recording of Node's `getUsageStats({ view: 'hour' })` and `getUsageDashboard({ refresh: true, refreshSetup: false })`
/// (`record-usage-stats-push.mjs`, from the pinned Node commit): the empty ledger, then after each appended row.
const GOLDEN: &str = include_str!("../../../../../fixtures/usage-stats-push/golden.json");

type Published = (SectionName, Option<String>, SectionChange);

/// A publisher the test awaits.
struct Seen(mpsc::UnboundedSender<Published>);

impl StatePublisher for Seen {
    fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
        self.0.send((section, key, change)).unwrap();
    }
}

fn seen() -> (Arc<Seen>, mpsc::UnboundedReceiver<Published>) {
    let (sender, receiver) = mpsc::unbounded_channel();
    (Arc::new(Seen(sender)), receiver)
}

fn inline(published: Published) -> Value {
    inline_of(STATS_KEY, published)
}

fn inline_of(want: &str, published: Published) -> Value {
    let (section, key, change) = published;
    assert_eq!((section, key.as_deref()), (SectionName::Usage, Some(want)));
    let SectionChange::Set(bytes) = change else { panic!("the statistics fit the inline limit") };
    serde_json::from_slice(&bytes).unwrap()
}

/// Reads answered from a script, each stamped with the (virtual) time it began.
struct Scripted {
    began: Instant,
    answers: Mutex<VecDeque<Result<Value, String>>>,
    /// One message per read, sent as it begins.
    reads: mpsc::UnboundedSender<()>,
}

#[async_trait]
impl SectionSource for Scripted {
    async fn read(&self, _: &Clock) -> Result<Value, String> {
        let at = Instant::now() - self.began;
        self.reads.send(()).unwrap();
        let answer = self.answers.lock().unwrap().pop_front().expect("one scripted answer per read");
        answer.map(|mut value| {
            value["at"] = u64::try_from(at.as_millis()).unwrap().into();
            value
        })
    }
}

fn scripted(answers: Vec<Result<Value, String>>) -> (Arc<Scripted>, mpsc::UnboundedReceiver<()>) {
    let (reads, began) = mpsc::unbounded_channel();
    (Arc::new(Scripted { began: Instant::now(), answers: Mutex::new(answers.into()), reads }), began)
}

fn push_into(publisher: Arc<Seen>) -> UsagePush {
    UsagePush::new(publisher, Arc::new(|| 0))
}

fn ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap()
}

/// The next message of `rx`, failing by assertion if the feed that should send it ends first: a feed that stops (or panics)
/// without sending is the test's failure with its output shown, not a wait the paused clock can never end.
async fn next<T>(rx: &mut mpsc::UnboundedReceiver<T>, feed: &mut tokio::task::JoinHandle<()>) -> T {
    tokio::select! {
        biased;
        message = rx.recv() => message.expect("the channel closed"),
        ended = feed => panic!("the feed ended before it sent: {ended:?}"),
    }
}
#[tokio::test(start_paused = true)]
async fn changes_are_published_at_a_bounded_rate_and_an_unchanged_ledger_is_never_read() {
    let (source, _reads) = scripted(vec![Ok(json!({})), Ok(json!({})), Ok(json!({}))]);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), STATS_KEY, changes, None, push_into(publisher), REFRESH_INTERVAL));

    // The first value is published at startup, with no change to wait for.
    assert_eq!(inline(next(&mut published, &mut feed).await)["at"], 0);

    // A storm of changes inside the interval is one read, when the interval since the previous read began ends.
    for _ in 0..1000 {
        changed.usage_changed();
    }
    assert_eq!(inline(next(&mut published, &mut feed).await)["at"], ms(REFRESH_INTERVAL));

    // Nothing changed for a long time: no read. The next change is read at once, not a whole interval later.
    tokio::time::advance(REFRESH_INTERVAL * 5).await;
    changed.usage_changed();
    assert_eq!(inline(next(&mut published, &mut feed).await)["at"], ms(REFRESH_INTERVAL * 6));
    assert!(published.try_recv().is_err(), "three reads for three bursts of changes");
}

/// Node never retried a failed re-read by itself: with no later trigger a failure produces no further read, however long it waits.
#[tokio::test(start_paused = true)]
async fn a_failed_read_with_no_later_change_is_never_retried() {
    let (source, mut reads) = scripted(vec![Err("a statistics read".to_owned()), Ok(json!({}))]);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), STATS_KEY, changes, None, push_into(publisher), REFRESH_INTERVAL));

    next(&mut reads, &mut feed).await;
    tokio::time::advance(REFRESH_INTERVAL * 100).await;
    assert!(published.try_recv().is_err());
    // The one scripted answer left goes to the next read, which only the change triggers: a timer that had retried the
    // failure would have taken it at the end of the interval, not now.
    changed.usage_changed();
    assert_eq!(inline(next(&mut published, &mut feed).await)["at"], ms(REFRESH_INTERVAL * 100));
    next(&mut reads, &mut feed).await;
    assert!(!feed.is_finished());
    drop(changed);
}

/// A failure clears what was pending and starts the interval like any read: the next change reads again, but only at the
/// end of the interval counted from the failed read's start; and a burst of changes after it is one read, not one per change.
#[tokio::test(start_paused = true)]
async fn a_burst_of_changes_after_a_failed_read_stays_inside_the_bound() {
    let failure = || Err("a statistics read".to_owned());
    let (source, mut reads) = scripted(vec![failure(), failure(), Ok(json!({ "ok": true }))]);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), STATS_KEY, changes, None, push_into(publisher), REFRESH_INTERVAL));

    next(&mut reads, &mut feed).await;
    for _ in 0..1000 {
        changed.usage_changed();
    }
    // The burst is one read, an interval after the first began; it fails too, and a second burst is again one read an
    // interval after that one began.
    next(&mut reads, &mut feed).await;
    assert!(reads.try_recv().is_err(), "a thousand changes were one read");
    for _ in 0..1000 {
        changed.usage_changed();
    }
    let value = inline(next(&mut published, &mut feed).await);
    assert_eq!((value["ok"].as_bool(), value["at"].as_u64()), (Some(true), Some(ms(REFRESH_INTERVAL * 2))));
    assert!(reads.try_recv().is_ok() && reads.try_recv().is_err(), "the third read, and no more");
}

#[tokio::test(start_paused = true)]
async fn statistics_over_the_inline_limit_are_not_published() {
    let oversize = json!({ "text": "x".repeat(mixdog_protocol::INLINE_MAX) });
    let (source, mut reads) = scripted(vec![Ok(oversize), Ok(json!({ "small": true }))]);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), STATS_KEY, changes, None, push_into(publisher), REFRESH_INTERVAL));

    next(&mut reads, &mut feed).await;
    changed.usage_changed();
    // The startup read was not published; the next read's answer is the first publication.
    assert_eq!(inline(next(&mut published, &mut feed).await)["small"], true);
}

#[tokio::test(start_paused = true)]
async fn the_feed_ends_with_its_source_and_with_its_writer() {
    let (publisher, mut published) = seen();
    let (source, _reads) = scripted(vec![]);
    let (changed, changes) = super::changes();
    let feed = tokio::spawn(run(Arc::downgrade(&source), STATS_KEY, changes, None, push_into(publisher.clone()), REFRESH_INTERVAL));
    drop(source);
    changed.usage_changed();
    feed.await.unwrap();
    assert!(published.try_recv().is_err(), "a closed ledger publishes nothing");

    let (source, _reads) = scripted(vec![Ok(json!({}))]);
    let (changed, changes) = super::changes();
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), STATS_KEY, changes, None, push_into(publisher), REFRESH_INTERVAL));
    inline(next(&mut published, &mut feed).await);
    drop(changed);
    feed.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn the_dashboard_entry_has_its_own_interval() {
    let (source, _reads) = scripted(vec![Ok(json!({ "rows": [] })), Ok(json!({ "rows": [] }))]);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), DASHBOARD_KEY, changes, None, push_into(publisher), DASHBOARD_INTERVAL));
    assert_eq!(inline_of(DASHBOARD_KEY, next(&mut published, &mut feed).await)["at"], 0);
    changed.usage_changed();
    assert_eq!(inline_of(DASHBOARD_KEY, next(&mut published, &mut feed).await)["at"], ms(DASHBOARD_INTERVAL));
    assert_eq!(DASHBOARD_INTERVAL, Duration::from_secs(300));
}

/// A read before the composition binds the dashboard source is an error, so the feed does not read an unbound source (no
/// failed read to count in the interval). Binding wakes the feed: the first value is published then, with no ledger change
/// and not an interval later.
#[tokio::test(start_paused = true)]
async fn binding_the_dashboard_source_publishes_the_first_value_without_a_ledger_change() {
    let slot = Arc::new(DashboardSlot::default());
    let clock: Clock = Arc::new(|| 0);
    assert!(slot.read(&clock).await.is_err(), "no answer is invented before the composition binds the source");

    let (source, _reads) = scripted(vec![Ok(json!({ "rows": [] }))]);
    let (publisher, mut published) = seen();
    let push = push_into(publisher);
    let (_changed, changes) = super::changes();
    let mut feed = tokio::spawn(run(Arc::downgrade(&slot), DASHBOARD_KEY, changes, Some(slot.bindings()), push, DASHBOARD_INTERVAL));

    // The feed started unbound; some time and a ledger change pass, and the first publication is the bound source's.
    tokio::time::advance(Duration::from_secs(10)).await;
    _changed.usage_changed();
    slot.bind(source).unwrap();
    assert_eq!(inline_of(DASHBOARD_KEY, next(&mut published, &mut feed).await)["at"], 10_000);
    assert_eq!(slot.bind(scripted(vec![]).0), Err("the usage dashboard source is already bound"));
}

struct NoEnv;

impl Environment for NoEnv {
    fn var(&self, _: &str) -> Option<String> {
        None
    }
}

/// Every row of the recording carries its own cost: nothing is priced here.
struct NoPrices;

impl Pricer for NoPrices {
    fn revision(&self) -> String {
        String::new()
    }

    fn price(&self, _: &PriceRequest) -> mixdog_ledger::error::Result<Priced> {
        Err(LedgerError::Invalid("a price"))
    }
}

/// The key order Node wrote is part of the answer.
fn bytes(value: &Value) -> String {
    mixdog_js::json_stringify(value)
}

/// The provider setup and display config the dashboard is built over: the recording's inputs of the current step.
struct RecordedSetup {
    setup: Value,
    config: Mutex<Value>,
}

#[async_trait]
impl SetupSource for RecordedSetup {
    async fn setup(&self, force: bool, quick: bool) -> Result<Value, String> {
        assert!(!force && !quick, "the dashboard question does not force the setup scan (`refreshSetup: false`)");
        Ok(self.setup.clone())
    }

    async fn display_config(&self) -> Result<Value, String> {
        Ok(self.config.lock().unwrap().clone())
    }
}

/// The quota readings Node's dashboard was answered from in the current step, replayed to the real dashboard builder.
struct RecordedQuotas {
    steps: Vec<Value>,
    step: AtomicUsize,
}

impl RecordedQuotas {
    fn lane(&self, lane: &str) -> &Value {
        &self.steps[self.step.load(Ordering::SeqCst)]["dashboard"][lane]
    }

    fn reading(&self, lane: &str, provider: &str, field: &str) -> Option<Value> {
        let reading = self.lane(lane).get(provider).expect("the recording holds a reading for every provider the dashboard asks");
        let value = reading.get(field).expect("the recording holds every field of a reading");
        (!value.is_null()).then(|| value.clone())
    }
}

#[async_trait]
impl UsageSources for RecordedQuotas {
    async fn cached_oauth(&self, provider: &str, allow_stale: bool) -> Option<Value> {
        self.reading("oauth", provider, if allow_stale { "stale" } else { "cached" })
    }

    fn oauth_provider_ready(&self, provider: &str) -> bool {
        self.lane("oauth").get(provider).is_some()
    }

    async fn fetch_oauth(&self, provider: &str, force: bool) -> Result<Option<Value>, String> {
        assert!(force, "the dashboard question refreshes");
        Ok(self.reading("oauth", provider, "fetched"))
    }

    async fn cached_api(&self, provider: &str) -> Option<Value> {
        self.reading("api", provider, "cached")
    }

    async fn fetch_api(&self, provider: &str, force: bool) -> Result<Option<Value>, String> {
        assert!(force, "the dashboard question refreshes");
        Ok(self.reading("api", provider, "fetched"))
    }
}

/// What a ledger source publishes, as the writer's commits drive it, equals what Node answered at the same point of the same ledger,
/// bytes and key order included: the statistics (`getUsageStats`), and the dashboard (`getUsageDashboard`) built by the real dashboard
/// source over the provider setup, config and quota readings Node's dashboard was given.
#[tokio::test(start_paused = true)]
async fn the_ledger_sources_pushed_entries_equal_nodes_answers() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    assert_eq!(golden["question"], json!({ "view": "hour" }));
    assert_eq!(serde_json::to_value(dialog_question().view).unwrap(), golden["question"]["view"]);
    assert_eq!(golden["dashboardQuestion"], dashboard_question());
    let steps = golden["steps"].as_array().unwrap();
    let now = Arc::new(AtomicI64::new(steps[0]["now"].as_i64().unwrap()));
    let (publisher, mut published) = seen();
    let clock: Clock = {
        let now = now.clone();
        Arc::new(move || now.load(Ordering::SeqCst))
    };
    let root = tempfile::tempdir().unwrap();
    let push = UsagePush::new(publisher, clock);
    let setup = Arc::new(RecordedSetup { setup: golden["dashboardSetup"].clone(), config: Mutex::new(steps[0]["dashboard"]["config"].clone()) });
    let quotas = Arc::new(RecordedQuotas { steps: steps.clone(), step: AtomicUsize::new(0) });
    let tokens = mixdog_rt::testing::tokens();
    let accounts = AccountStore::new(root.path().join("accounts"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    push.dashboard.bind(Arc::new(DashboardReading { dashboards: Dashboards::new(setup.clone()), sources: quotas.clone(), accounts })).unwrap();
    let source = LedgerSource::new(Arc::new(NoEnv), root.path().join("data"), tokens, Arc::new(NoPrices), push);
    let ledger = source.get().await.unwrap();
    ledger.writer.sums_built().await.unwrap();

    for (n, step) in steps.iter().enumerate() {
        if n > 0 {
            quotas.step.store(n, Ordering::SeqCst);
            *setup.config.lock().unwrap() = step["dashboard"]["config"].clone();
            now.store(step["now"].as_i64().unwrap(), Ordering::SeqCst);
            for row in step["rows"].as_array().unwrap() {
                // The record carries the price snapshot as the JSON text its producer serialized once.
                let mut row = row.clone();
                let rates = bytes(&row["rates"]);
                row["rates"] = Value::String(rates);
                ledger.writer.record_queued(serde_json::from_value(row).unwrap()).await.unwrap();
            }
            ledger.writer.settle_writes().await.unwrap();
        }
        // One change, two entries: the statistics (every 30 s at most) and the dashboard (every 5 min at most), in either order.
        let (first, second) = (published.recv().await.unwrap(), published.recv().await.unwrap());
        let (stats, dashboard) = if first.1.as_deref() == Some(STATS_KEY) { (first, second) } else { (second, first) };
        let got = inline(stats);
        assert_eq!(got, step["stats"], "step {n}");
        assert_eq!(bytes(&got), bytes(&step["stats"]), "step {n}: key order and number text");
        let got = inline_of(DASHBOARD_KEY, dashboard);
        let want = &step["dashboard"]["answer"];
        assert_eq!(got, *want, "step {n}: the dashboard");
        assert_eq!(bytes(&got), bytes(want), "step {n}: the dashboard's key order and number text");
    }
    assert_eq!(steps.len(), 11);
    source.close_all();
}
