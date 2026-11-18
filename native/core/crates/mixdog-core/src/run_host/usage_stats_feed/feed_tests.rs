use std::collections::VecDeque;
use std::sync::Mutex;

use serde_json::json;
use tokio::sync::mpsc;

use mixdog_core_session::session::testing::{HeldClock, awaiting};

use super::*;

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

/// The next message of `rx` (`what` is what it carries), failing by assertion if the feed that should send it ends first, or if it
/// has not come by the wait's deadline: a feed that stops (or panics) without sending, or that waits for a time nobody advances to,
/// is the test's failure with its output shown, not a wait with no end. The tests hold the clock, so time moves only by their advance.
async fn next<T>(what: &str, rx: &mut mpsc::UnboundedReceiver<T>, feed: &mut tokio::task::JoinHandle<()>) -> T {
    mixdog_core_session::session::testing::awaiting(|| what.to_owned(), async {
        tokio::select! {
            biased;
            message = rx.recv() => message.expect("the channel closed"),
            ended = feed => panic!("the feed ended before {what}: {ended:?}"),
        }
    })
    .await
}

/// How many reads have begun since the last count.
fn began<T>(reads: &mut mpsc::UnboundedReceiver<T>) -> usize {
    let mut count = 0;
    while reads.try_recv().is_ok() {
        count += 1;
    }
    count
}

/// Moves the held clock to `interval` after `from`, in two steps with the first one tick short of it: nothing may read before the
/// interval has ended (each advance gives the feed its turn before it returns), and the read comes at the end of it.
async fn through<T>(interval: Duration, reads: &mut mpsc::UnboundedReceiver<T>) {
    tokio::time::advance(interval - Duration::from_millis(1)).await;
    assert_eq!(began(reads), 0, "no read before the interval since the previous one began has ended");
    tokio::time::advance(Duration::from_millis(1)).await;
}
#[tokio::test(start_paused = true)]
async fn changes_are_published_at_a_bounded_rate_and_an_unchanged_ledger_is_never_read() {
    let _held = HeldClock::hold();
    let (source, mut reads) = scripted(vec![Ok(json!({})), Ok(json!({})), Ok(json!({}))]);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), STATS_KEY, changes, None, push_into(publisher), REFRESH_INTERVAL));

    // The first value is published at startup, with no change to wait for.
    assert_eq!(inline(next("the startup publication", &mut published, &mut feed).await)["at"], 0);
    assert_eq!(began(&mut reads), 1);

    // A storm of changes inside the interval is one read, when the interval since the previous read began ends.
    for _ in 0..1000 {
        changed.usage_changed();
    }
    through(REFRESH_INTERVAL, &mut reads).await;
    assert_eq!(inline(next("the storm's publication", &mut published, &mut feed).await)["at"], ms(REFRESH_INTERVAL));
    assert_eq!(began(&mut reads), 1, "a thousand changes were one read");

    // Nothing changed for a long time: no read. The next change is read at once, not a whole interval later.
    tokio::time::advance(REFRESH_INTERVAL * 5).await;
    assert_eq!(began(&mut reads), 0, "no change, no read");
    changed.usage_changed();
    assert_eq!(inline(next("the late change's publication", &mut published, &mut feed).await)["at"], ms(REFRESH_INTERVAL * 6));
    assert!(published.try_recv().is_err(), "three reads for three bursts of changes");
}

/// How far the clock is advanced to show that a failed read arms no retry: a hundred refresh intervals, far past the end of any
/// interval the feed could retry on.
const NO_RETRY_HORIZON: Duration = REFRESH_INTERVAL.saturating_mul(100);

/// A failed re-read is not retried by itself: with no later trigger a failure produces no further read, however long it waits.
#[tokio::test(start_paused = true)]
async fn a_failed_read_with_no_later_change_is_never_retried() {
    let _held = HeldClock::hold();
    // A second scripted failure, so that a retry would be counted below and not end the feed by a missing answer.
    let (source, mut reads) = scripted(vec![Err("a statistics read".to_owned()), Err("a statistics read".to_owned())]);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    // The feed runs inside this test's own task, one poll at a time: what it does between two polls is exactly what that poll
    // did, so there is no turn of a runtime to wait for and no count of turns to tune.
    let feed = run(Arc::downgrade(&source), STATS_KEY, changes, None, push_into(publisher), REFRESH_INTERVAL);
    tokio::pin!(feed);
    let mut poll_feed = async || std::future::poll_fn(|cx| std::task::Poll::Ready(feed.as_mut().poll(cx))).await;

    // The source answers without awaiting, so the first poll takes the failure and parks the feed.
    assert!(poll_feed().await.is_pending());
    assert_eq!(began(&mut reads), 1, "the startup read began");
    // The explicit advance gives the clock's timers their turn, and the next poll resumes a feed that waited on one.
    tokio::time::advance(NO_RETRY_HORIZON).await;
    assert!(poll_feed().await.is_pending(), "the feed is parked on the writer, not finished");
    assert_eq!(began(&mut reads), 0, "no timer retries a failure");
    assert!(published.try_recv().is_err());
    // The writer was open the whole time; its closing is what ends the parked feed.
    drop(changed);
    assert!(poll_feed().await.is_ready(), "a feed parked on the next change ends with its writer");
}

/// A failure clears what was pending and starts the interval like any read: the next change reads again, but only at the
/// end of the interval counted from the failed read's start; and a burst of changes after it is one read, not one per change.
#[tokio::test(start_paused = true)]
async fn a_burst_of_changes_after_a_failed_read_stays_inside_the_bound() {
    let _held = HeldClock::hold();
    let failure = || Err("a statistics read".to_owned());
    let (source, mut reads) = scripted(vec![failure(), failure(), Ok(json!({ "ok": true }))]);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), STATS_KEY, changes, None, push_into(publisher), REFRESH_INTERVAL));

    next("the failing first read to begin", &mut reads, &mut feed).await;
    for _ in 0..1000 {
        changed.usage_changed();
    }
    // The burst is one read, an interval after the first began; it fails too, and a second burst is again one read an
    // interval after that one began.
    through(REFRESH_INTERVAL, &mut reads).await;
    next("the burst's read to begin", &mut reads, &mut feed).await;
    assert_eq!(began(&mut reads), 0, "a thousand changes were one read");
    for _ in 0..1000 {
        changed.usage_changed();
    }
    through(REFRESH_INTERVAL, &mut reads).await;
    let value = inline(next("the second burst's publication", &mut published, &mut feed).await);
    assert_eq!((value["ok"].as_bool(), value["at"].as_u64()), (Some(true), Some(ms(REFRESH_INTERVAL * 2))));
    assert_eq!(began(&mut reads), 1, "the third read, and no more");
}

#[tokio::test(start_paused = true)]
async fn statistics_over_the_inline_limit_are_not_published() {
    let _held = HeldClock::hold();
    let oversize = json!({ "text": "x".repeat(mixdog_protocol::INLINE_MAX) });
    let (source, mut reads) = scripted(vec![Ok(oversize), Ok(json!({ "small": true }))]);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), STATS_KEY, changes, None, push_into(publisher), REFRESH_INTERVAL));

    next("the startup read to begin", &mut reads, &mut feed).await;
    changed.usage_changed();
    tokio::time::advance(REFRESH_INTERVAL).await;
    // The startup read was not published; the next read's answer is the first publication.
    assert_eq!(inline(next("the first publication", &mut published, &mut feed).await)["small"], true);
}

#[tokio::test(start_paused = true)]
async fn the_feed_ends_with_its_source_and_with_its_writer() {
    let _held = HeldClock::hold();
    let (publisher, mut published) = seen();
    let (source, _reads) = scripted(vec![]);
    let (changed, changes) = super::changes();
    let feed = tokio::spawn(run(Arc::downgrade(&source), STATS_KEY, changes, None, push_into(publisher.clone()), REFRESH_INTERVAL));
    drop(source);
    changed.usage_changed();
    awaiting(|| "the feed to end once its source is gone".to_owned(), feed).await.unwrap();
    assert!(published.try_recv().is_err(), "a closed ledger publishes nothing");

    let (source, _reads) = scripted(vec![Ok(json!({}))]);
    let (changed, changes) = super::changes();
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), STATS_KEY, changes, None, push_into(publisher), REFRESH_INTERVAL));
    inline(next("the startup publication", &mut published, &mut feed).await);
    drop(changed);
    awaiting(|| "the feed to end once its writer is gone".to_owned(), feed).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn the_dashboard_entry_has_its_own_interval() {
    let _held = HeldClock::hold();
    let (source, mut reads) = scripted(vec![Ok(json!({ "rows": [] })), Ok(json!({ "rows": [] }))]);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), DASHBOARD_KEY, changes, None, push_into(publisher), DASHBOARD_INTERVAL));
    assert_eq!(inline_of(DASHBOARD_KEY, next("the startup publication", &mut published, &mut feed).await)["at"], 0);
    assert_eq!(began(&mut reads), 1);
    changed.usage_changed();
    through(DASHBOARD_INTERVAL, &mut reads).await;
    assert_eq!(inline_of(DASHBOARD_KEY, next("the change's publication", &mut published, &mut feed).await)["at"], ms(DASHBOARD_INTERVAL));
    assert_eq!(DASHBOARD_INTERVAL, Duration::from_secs(300));
}

/// A read before the composition binds the dashboard source is an error, so the feed does not read an unbound source (no
/// failed read to count in the interval). Binding wakes the feed: the first value is published then, with no ledger change
/// and not an interval later.
#[tokio::test(start_paused = true)]
async fn binding_the_dashboard_source_publishes_the_first_value_without_a_ledger_change() {
    let _held = HeldClock::hold();
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
    assert_eq!(inline_of(DASHBOARD_KEY, next("the bound source's first publication", &mut published, &mut feed).await)["at"], 10_000);
    assert_eq!(slot.bind(scripted(vec![]).0), Err("the usage dashboard source is already bound"));
}
