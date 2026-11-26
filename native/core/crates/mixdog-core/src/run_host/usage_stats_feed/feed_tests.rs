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

#[tokio::test(start_paused = true)]
async fn dashboard_feed_wakes_and_republishes_when_window_reset_elapses_without_ledger_write() {
    let _held = HeldClock::hold();
    let started = Instant::now();
    let base_ms: i64 = 1_700_000_000_000;
    let clock: Clock = Arc::new(move || base_ms + i64::try_from((Instant::now() - started).as_millis()).unwrap());

    let dashboard_with = |used_pct: u64, reset_5h: i64| {
        Ok(json!({
            "rows": [{
                "id": "openai-oauth",
                "windows": [
                    { "label": "5H", "usedPct": used_pct, "resetAt": reset_5h },
                    { "label": "7D", "usedPct": 20, "resetAt": base_ms + 500_000 }
                ]
            }]
        }))
    };

    // 1) Startup at t=0 with 5H resetting at +10s.
    // 2) First reset wakeup at +12s: upstream still echoes the elapsed resetAt briefly (clock skew).
    // 3) First bounded follow-up at +17s: upstream returns the rolled-over 5H window.
    let (source, mut reads) =
        scripted(vec![dashboard_with(100, base_ms + 10_000), dashboard_with(100, base_ms + 10_000), dashboard_with(0, base_ms + 18_010_000)]);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    let push = UsagePush::new(publisher, clock);
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), DASHBOARD_KEY, changes, None, push, DASHBOARD_INTERVAL));

    let first = inline_of(DASHBOARD_KEY, next("startup dashboard publication", &mut published, &mut feed).await);
    assert_eq!(first["at"], 0);
    assert_eq!(began(&mut reads), 1);

    // No ledger writes happen; feed wakes right after resetAt + RESET_SETTLE_DELAY (well before DASHBOARD_INTERVAL).
    through(Duration::from_secs(10) + RESET_SETTLE_DELAY, &mut reads).await;
    let skewed = inline_of(DASHBOARD_KEY, next("post-reset skewed publication", &mut published, &mut feed).await);
    assert_eq!(skewed["at"], ms(Duration::from_secs(10) + RESET_SETTLE_DELAY));
    assert_eq!(began(&mut reads), 1);

    // Bounded follow-up wakes after RESET_FOLLOWUP_DELAYS[0] and republishes the rolled-over window.
    through(RESET_FOLLOWUP_DELAYS[0], &mut reads).await;
    let rolled = inline_of(DASHBOARD_KEY, next("rolled-over publication", &mut published, &mut feed).await);
    assert_eq!(rolled["at"], ms(Duration::from_secs(10) + RESET_SETTLE_DELAY + RESET_FOLLOWUP_DELAYS[0]));
    assert_eq!(rolled["rows"][0]["windows"][0]["usedPct"], 0);
    assert_eq!(began(&mut reads), 1);

    drop(changed);
    awaiting(|| "the feed to exit cleanly when the writer drops".to_owned(), feed).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn dashboard_feed_bounds_followups_when_upstream_never_clears_elapsed_reset() {
    let _held = HeldClock::hold();
    let started = Instant::now();
    let base_ms: i64 = 1_700_000_000_000;
    let clock: Clock = Arc::new(move || base_ms + i64::try_from((Instant::now() - started).as_millis()).unwrap());

    let stuck = || {
        Ok(json!({
            "rows": [{
                "id": "openai-oauth",
                "windows": [{ "label": "5H", "usedPct": 100, "resetAt": base_ms + 10_000 }]
            }]
        }))
    };
    let answers: Vec<_> = (0..=RESET_FOLLOWUP_DELAYS.len() + 2).map(|_| stuck()).collect();
    let (source, mut reads) = scripted(answers);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    let push = UsagePush::new(publisher, clock);
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), DASHBOARD_KEY, changes, None, push, DASHBOARD_INTERVAL));

    // Startup read.
    inline_of(DASHBOARD_KEY, next("startup", &mut published, &mut feed).await);
    assert_eq!(began(&mut reads), 1);

    // Initial post-reset wakeup.
    through(Duration::from_secs(10) + RESET_SETTLE_DELAY, &mut reads).await;
    inline_of(DASHBOARD_KEY, next("post-reset wakeup", &mut published, &mut feed).await);
    assert_eq!(began(&mut reads), 1);

    // Each bounded follow-up runs once.
    for (idx, delay) in RESET_FOLLOWUP_DELAYS.iter().enumerate() {
        through(*delay, &mut reads).await;
        inline_of(DASHBOARD_KEY, next(&format!("follow-up {idx}"), &mut published, &mut feed).await);
        assert_eq!(began(&mut reads), 1);
    }

    // After bounded follow-ups exhaust, no spin loop occurs.
    tokio::time::advance(DASHBOARD_INTERVAL * 10).await;
    assert_eq!(began(&mut reads), 0, "no further reads after bounded follow-ups exhaust");
    assert!(published.try_recv().is_err());

    drop(changed);
    awaiting(|| "the feed to exit cleanly when the writer drops".to_owned(), feed).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn dashboard_feed_bounds_followups_when_window_alternates_elapsed_reset_timestamps() {
    let _held = HeldClock::hold();
    let started = Instant::now();
    let base_ms: i64 = 1_700_000_000_000;
    let clock: Clock = Arc::new(move || base_ms + i64::try_from((Instant::now() - started).as_millis()).unwrap());

    let dashboard_at = |reset_at: i64| {
        Ok(json!({
            "rows": [{
                "id": "openai-oauth",
                "windows": [{ "label": "5H", "usedPct": 100, "resetAt": reset_at }]
            }]
        }))
    };

    // Startup sees +10s; once elapsed, upstream alternates between +10s and +9s on every read.
    let mut answers = vec![dashboard_at(base_ms + 10_000)];
    for idx in 0..=RESET_FOLLOWUP_DELAYS.len() + 2 {
        answers.push(dashboard_at(if idx % 2 == 0 { base_ms + 10_000 } else { base_ms + 9_000 }));
    }
    let (source, mut reads) = scripted(answers);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    let push = UsagePush::new(publisher, clock);
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), DASHBOARD_KEY, changes, None, push, DASHBOARD_INTERVAL));

    inline_of(DASHBOARD_KEY, next("startup", &mut published, &mut feed).await);
    assert_eq!(began(&mut reads), 1);

    through(Duration::from_secs(10) + RESET_SETTLE_DELAY, &mut reads).await;
    inline_of(DASHBOARD_KEY, next("post-reset wakeup", &mut published, &mut feed).await);
    assert_eq!(began(&mut reads), 1);

    for (idx, delay) in RESET_FOLLOWUP_DELAYS.iter().enumerate() {
        through(*delay, &mut reads).await;
        inline_of(DASHBOARD_KEY, next(&format!("alternating follow-up {idx}"), &mut published, &mut feed).await);
        assert_eq!(began(&mut reads), 1);
    }

    tokio::time::advance(DASHBOARD_INTERVAL * 10).await;
    assert_eq!(began(&mut reads), 0, "alternating elapsed timestamps must still exhaust retry budget");
    assert!(published.try_recv().is_err());

    drop(changed);
    awaiting(|| "the feed to exit cleanly when the writer drops".to_owned(), feed).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn dashboard_feed_preserves_future_reset_deadlines_across_failed_reads() {
    let _held = HeldClock::hold();
    let started = Instant::now();
    let base_ms: i64 = 1_700_000_000_000;
    let clock: Clock = Arc::new(move || base_ms + i64::try_from((Instant::now() - started).as_millis()).unwrap());

    let (source, mut reads) = scripted(vec![
        Ok(json!({
            "rows": [{
                "id": "openai-oauth",
                "windows": [
                    { "label": "5H", "usedPct": 100, "resetAt": base_ms + 10_000 },
                    { "label": "7D", "usedPct": 80, "resetAt": base_ms + 600_000 }
                ]
            }]
        })),
        Err("transient upstream outage".to_owned()),
        Ok(json!({
            "rows": [{
                "id": "openai-oauth",
                "windows": [
                    { "label": "5H", "usedPct": 0, "resetAt": base_ms + 18_600_000 },
                    { "label": "7D", "usedPct": 0, "resetAt": base_ms + 605_400_000 }
                ]
            }]
        })),
    ]);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    let push = UsagePush::new(publisher, clock);
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), DASHBOARD_KEY, changes, None, push, DASHBOARD_INTERVAL));

    inline_of(DASHBOARD_KEY, next("startup", &mut published, &mut feed).await);
    assert_eq!(began(&mut reads), 1);

    // 5H wakeup fails at +12s.
    through(Duration::from_secs(10) + RESET_SETTLE_DELAY, &mut reads).await;
    next("failing 5H read to begin", &mut reads, &mut feed).await;
    assert!(published.try_recv().is_err());

    // Without any ledger write, 7D's future deadline (+600s + RESET_SETTLE_DELAY) still wakes the feed.
    through(Duration::from_secs(590), &mut reads).await;
    let recovered = inline_of(DASHBOARD_KEY, next("7D wakeup publication", &mut published, &mut feed).await);
    assert_eq!(recovered["at"], ms(Duration::from_secs(600) + RESET_SETTLE_DELAY));
    assert_eq!(recovered["rows"][0]["windows"][1]["usedPct"], 0);
    assert_eq!(began(&mut reads), 1);

    drop(changed);
    awaiting(|| "the feed to exit cleanly when the writer drops".to_owned(), feed).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn dashboard_feed_does_not_spend_window_retry_budget_on_unrelated_early_reads() {
    let _held = HeldClock::hold();
    let started = Instant::now();
    let base_ms: i64 = 1_700_000_000_000;
    let clock: Clock = Arc::new(move || base_ms + i64::try_from((Instant::now() - started).as_millis()).unwrap());

    let reset_a = base_ms + 10_000;
    let reset_b = base_ms + 13_000;
    let rolled_a = base_ms + 18_010_000;
    let rolled_b = base_ms + 18_013_000;

    let frame = |a_pct: u64, a_reset: i64, b_pct: u64, b_reset: i64| {
        Ok(json!({
            "rows": [
                { "id": "openai-oauth", "windows": [{ "label": "5H", "usedPct": a_pct, "resetAt": a_reset }] },
                { "id": "anthropic-oauth", "windows": [{ "label": "5H", "usedPct": b_pct, "resetAt": b_reset }] }
            ]
        }))
    };

    // Timeline with RESET_SETTLE_DELAY = 2s, RESET_FOLLOWUP_DELAYS = [5s, 15s, 30s]:
    // t=0:   startup
    // t=12s: A initial settle -> A next=17s; B still future (next=15s)
    // t=15s: B initial settle (A not due yet!) -> B next=20s; A stays next=17s (attempts=1)
    // t=17s: A follow-up 0 -> A next=32s; B not due yet (next=20s)
    // t=20s: B follow-up 0 -> B rolls over! A not due yet (stays attempts=2, next=32s)
    // t=32s: A follow-up 1 -> A next=62s
    // t=62s: A follow-up 2 -> A rolls over!
    let (source, mut reads) = scripted(vec![
        frame(100, reset_a, 100, reset_b),
        frame(100, reset_a, 100, reset_b),
        frame(100, reset_a, 100, reset_b),
        frame(100, reset_a, 100, reset_b),
        frame(100, reset_a, 0, rolled_b),
        frame(100, reset_a, 0, rolled_b),
        frame(0, rolled_a, 0, rolled_b),
    ]);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    let push = UsagePush::new(publisher, clock);
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), DASHBOARD_KEY, changes, None, push, DASHBOARD_INTERVAL));

    // t=0
    inline_of(DASHBOARD_KEY, next("startup", &mut published, &mut feed).await);
    assert_eq!(began(&mut reads), 1);

    // t=12s: A initial settle
    through(Duration::from_secs(12), &mut reads).await;
    assert_eq!(inline_of(DASHBOARD_KEY, next("t=12s", &mut published, &mut feed).await)["at"], 12_000);
    assert_eq!(began(&mut reads), 1);

    // t=15s: B initial settle (must not spend A's retry budget)
    through(Duration::from_secs(3), &mut reads).await;
    assert_eq!(inline_of(DASHBOARD_KEY, next("t=15s", &mut published, &mut feed).await)["at"], 15_000);
    assert_eq!(began(&mut reads), 1);

    // t=17s: A follow-up 0
    through(Duration::from_secs(2), &mut reads).await;
    assert_eq!(inline_of(DASHBOARD_KEY, next("t=17s", &mut published, &mut feed).await)["at"], 17_000);
    assert_eq!(began(&mut reads), 1);

    // t=20s: B follow-up 0 rolls over B (must not spend A's retry budget)
    through(Duration::from_secs(3), &mut reads).await;
    let b_rolled = inline_of(DASHBOARD_KEY, next("t=20s", &mut published, &mut feed).await);
    assert_eq!(b_rolled["at"], 20_000);
    assert_eq!(b_rolled["rows"][1]["windows"][0]["usedPct"], 0);
    assert_eq!(began(&mut reads), 1);

    // t=32s: A follow-up 1 (still gets its full 15s backoff from t=17s)
    through(Duration::from_secs(12), &mut reads).await;
    assert_eq!(inline_of(DASHBOARD_KEY, next("t=32s", &mut published, &mut feed).await)["at"], 32_000);
    assert_eq!(began(&mut reads), 1);

    // t=62s: A follow-up 2 (still gets its full 30s backoff from t=32s and rolls over)
    through(Duration::from_secs(30), &mut reads).await;
    let a_rolled = inline_of(DASHBOARD_KEY, next("t=62s", &mut published, &mut feed).await);
    assert_eq!(a_rolled["at"], 62_000);
    assert_eq!(a_rolled["rows"][0]["windows"][0]["usedPct"], 0);
    assert_eq!(began(&mut reads), 1);

    drop(changed);
    awaiting(|| "the feed to exit cleanly when the writer drops".to_owned(), feed).await.unwrap();
}

struct DelayedScripted {
    began: Instant,
    answers: Mutex<VecDeque<(Duration, Result<Value, String>)>>,
    reads: mpsc::UnboundedSender<()>,
}

#[async_trait]
impl SectionSource for DelayedScripted {
    async fn read(&self, _: &Clock) -> Result<Value, String> {
        let at = Instant::now() - self.began;
        self.reads.send(()).unwrap();
        let (delay, answer) = self.answers.lock().unwrap().pop_front().expect("one scripted answer per read");
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        answer.map(|mut value| {
            value["at"] = u64::try_from(at.as_millis()).unwrap().into();
            value
        })
    }
}

fn delayed_scripted(answers: Vec<(Duration, Result<Value, String>)>) -> (Arc<DelayedScripted>, mpsc::UnboundedReceiver<()>) {
    let (reads, began) = mpsc::unbounded_channel();
    (Arc::new(DelayedScripted { began: Instant::now(), answers: Mutex::new(answers.into()), reads }), began)
}

#[tokio::test(start_paused = true)]
async fn dashboard_feed_preserves_other_window_pending_followup_across_failed_read() {
    let _held = HeldClock::hold();
    let started = Instant::now();
    let base_ms: i64 = 1_700_000_000_000;
    let clock: Clock = Arc::new(move || base_ms + i64::try_from((Instant::now() - started).as_millis()).unwrap());

    let reset_a = base_ms + 10_000;
    let reset_b = base_ms + 13_000;
    let rolled_a = base_ms + 18_010_000;
    let rolled_b = base_ms + 18_013_000;

    let frame = |a_pct: u64, a_reset: i64, b_pct: u64, b_reset: i64| {
        Ok(json!({
            "rows": [
                { "id": "openai-oauth", "windows": [{ "label": "5H", "usedPct": a_pct, "resetAt": a_reset }] },
                { "id": "anthropic-oauth", "windows": [{ "label": "5H", "usedPct": b_pct, "resetAt": b_reset }] }
            ]
        }))
    };

    // t=0: startup -> A resets at +10s (settle +12s), B resets at +13s (settle +15s).
    // t=12s: A settle echoes elapsed A -> A pending follow-up at +17s.
    // t=15s: B settle read fails -> A's pending follow-up at +17s must still survive and fire.
    let (source, mut reads) = scripted(vec![
        frame(100, reset_a, 100, reset_b),
        frame(100, reset_a, 100, reset_b),
        Err("transient outage on B".to_owned()),
        frame(0, rolled_a, 0, rolled_b),
    ]);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    let push = UsagePush::new(publisher, clock);
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), DASHBOARD_KEY, changes, None, push, DASHBOARD_INTERVAL));

    inline_of(DASHBOARD_KEY, next("startup", &mut published, &mut feed).await);
    assert_eq!(began(&mut reads), 1);

    // t=12s: A initial settle schedules A's follow-up at t=17s.
    through(Duration::from_secs(12), &mut reads).await;
    assert_eq!(inline_of(DASHBOARD_KEY, next("t=12s A settle", &mut published, &mut feed).await)["at"], 12_000);
    assert_eq!(began(&mut reads), 1);

    // t=15s: B's reset read fails.
    through(Duration::from_secs(3), &mut reads).await;
    next("failing B read at t=15s", &mut reads, &mut feed).await;
    assert!(published.try_recv().is_err());

    // t=17s: without any ledger write, A's pending follow-up still fires and rolls over A.
    through(Duration::from_secs(2), &mut reads).await;
    let recovered = inline_of(DASHBOARD_KEY, next("t=17s A follow-up", &mut published, &mut feed).await);
    assert_eq!(recovered["at"], 17_000);
    assert_eq!(recovered["rows"][0]["windows"][0]["usedPct"], 0);
    assert_eq!(began(&mut reads), 1);

    drop(changed);
    awaiting(|| "the feed to exit cleanly when the writer drops".to_owned(), feed).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn dashboard_feed_does_not_spend_window_retry_budget_on_slow_read() {
    let _held = HeldClock::hold();
    let started = Instant::now();
    let base_ms: i64 = 1_700_000_000_000;
    let clock: Clock = Arc::new(move || base_ms + i64::try_from((Instant::now() - started).as_millis()).unwrap());

    let reset_a = base_ms + 10_000;
    let reset_b = base_ms + 13_000;
    let rolled_a = base_ms + 18_010_000;
    let rolled_b = base_ms + 18_013_000;

    let frame = |a_pct: u64, a_reset: i64, b_pct: u64, b_reset: i64| {
        Ok(json!({
            "rows": [
                { "id": "openai-oauth", "windows": [{ "label": "5H", "usedPct": a_pct, "resetAt": a_reset }] },
                { "id": "anthropic-oauth", "windows": [{ "label": "5H", "usedPct": b_pct, "resetAt": b_reset }] }
            ]
        }))
    };

    // t=0:   startup
    // t=12s: A settle -> A next_due_at = 17s (attempt 1)
    // t=15s: B settle starts BEFORE A is due (15s < 17s) but takes 3s (finishes at 18s).
    //        Must NOT spend A's retry budget; A wakes immediately at 18s for follow-up 0.
    // t=18s: A follow-up 0 -> next_due_at = 33s (attempt 2)
    // t=33s: A follow-up 1 -> next_due_at = 63s (attempt 3)
    // t=63s: A follow-up 2 -> rolls over A!
    let (source, mut reads) = delayed_scripted(vec![
        (Duration::ZERO, frame(100, reset_a, 100, reset_b)),
        (Duration::ZERO, frame(100, reset_a, 100, reset_b)),
        (Duration::from_secs(3), frame(100, reset_a, 0, rolled_b)),
        (Duration::ZERO, frame(100, reset_a, 0, rolled_b)),
        (Duration::ZERO, frame(100, reset_a, 0, rolled_b)),
        (Duration::ZERO, frame(0, rolled_a, 0, rolled_b)),
    ]);
    let (publisher, mut published) = seen();
    let (changed, changes) = super::changes();
    let push = UsagePush::new(publisher, clock);
    let mut feed = tokio::spawn(run(Arc::downgrade(&source), DASHBOARD_KEY, changes, None, push, DASHBOARD_INTERVAL));

    inline_of(DASHBOARD_KEY, next("startup", &mut published, &mut feed).await);
    assert_eq!(began(&mut reads), 1);

    // t=12s: A initial settle
    through(Duration::from_secs(12), &mut reads).await;
    assert_eq!(inline_of(DASHBOARD_KEY, next("t=12s", &mut published, &mut feed).await)["at"], 12_000);
    assert_eq!(began(&mut reads), 1);

    // t=15s: B slow read starts, sleeps 3s until t=18s.
    through(Duration::from_secs(3), &mut reads).await;
    next("slow B read to begin at t=15s", &mut reads, &mut feed).await;
    tokio::time::advance(Duration::from_secs(3)).await;
    let b_rolled = inline_of(DASHBOARD_KEY, next("t=15s slow read publication", &mut published, &mut feed).await);
    assert_eq!(b_rolled["at"], 15_000);
    assert_eq!(b_rolled["rows"][1]["windows"][0]["usedPct"], 0);

    // t=18s: A follow-up 0 fires immediately because A was not due when B's read started at t=15s.
    let a_followup_0 = inline_of(DASHBOARD_KEY, next("t=18s A follow-up 0", &mut published, &mut feed).await);
    assert_eq!(a_followup_0["at"], 18_000);
    assert_eq!(began(&mut reads), 1);

    // t=33s (+15s): A follow-up 1
    through(RESET_FOLLOWUP_DELAYS[1], &mut reads).await;
    assert_eq!(inline_of(DASHBOARD_KEY, next("t=33s A follow-up 1", &mut published, &mut feed).await)["at"], 33_000);
    assert_eq!(began(&mut reads), 1);

    // t=63s (+30s): A follow-up 2 rolls over A (full 3 follow-ups preserved)
    through(RESET_FOLLOWUP_DELAYS[2], &mut reads).await;
    let a_rolled = inline_of(DASHBOARD_KEY, next("t=63s A follow-up 2", &mut published, &mut feed).await);
    assert_eq!(a_rolled["at"], 63_000);
    assert_eq!(a_rolled["rows"][0]["windows"][0]["usedPct"], 0);
    assert_eq!(began(&mut reads), 1);

    drop(changed);
    awaiting(|| "the feed to exit cleanly when the writer drops".to_owned(), feed).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn reset_schedule_records_transport_failed_when_first_settle_read_fails() {
    let _held = HeldClock::hold();
    let base_instant = Instant::now();
    let base_ms: i64 = 1_700_000_000_000;
    let reset_a = base_ms + 10_000;
    let reset_b = base_ms + 60_000;

    let initial = json!({
        "rows": [
            { "id": "openai-oauth", "windows": [{ "label": "5H", "usedPct": 100, "resetAt": reset_a }] },
            { "id": "anthropic-oauth", "windows": [{ "label": "5H", "usedPct": 40, "resetAt": reset_b }] }
        ]
    });

    let mut schedule = ResetSchedule::default();
    let first_deadline = schedule.next_deadline(&initial, base_ms, base_ms, base_instant);
    assert_eq!(first_deadline, Some(base_instant + Duration::from_secs(12)));
    assert_eq!(schedule.known_future_resets.len(), 2);

    // At t=12s, A's first settle read fails; A must be promoted into `elapsed` with `transport_failed = true`
    // while B remains scheduled for t=62s.
    let at_12s = base_instant + Duration::from_secs(12);
    let after_fail = schedule.next_deadline_after_failure(base_ms + 12_000, base_ms + 12_000, at_12s);
    assert_eq!(after_fail, Some(at_12s + Duration::from_secs(50)));
    assert_eq!(schedule.known_future_resets.len(), 1);
    assert_eq!(schedule.known_future_resets[0].reset_at, reset_b);

    let key_a = "openai-oauth\u{1f}\u{1f}5h\u{1f}0";
    let failed_entry = schedule.elapsed.get(key_a).expect("failed first settle must be tracked in elapsed");
    assert!(failed_entry.transport_failed);
    assert_eq!(failed_entry.attempts, 0);
    assert_eq!(failed_entry.next_due_at, None);

    // A later successful read at t=15s echoing a skewed elapsed resetAt (base_ms + 14_000, whose fresh settle would
    // be t=16s) immediately resumes follow-ups instead of resetting back to initial settle waiting.
    let skewed_followup = json!({
        "rows": [
            { "id": "openai-oauth", "windows": [{ "label": "5H", "usedPct": 100, "resetAt": base_ms + 14_000 }] },
            { "id": "anthropic-oauth", "windows": [{ "label": "5H", "usedPct": 40, "resetAt": reset_b }] }
        ]
    });
    let at_15s = base_instant + Duration::from_secs(15);
    let resumed = schedule.next_deadline(&skewed_followup, base_ms + 15_000, base_ms + 15_000, at_15s);
    assert_eq!(resumed, Some(at_15s + RESET_FOLLOWUP_DELAYS[0]));
    let resumed_entry = schedule.elapsed.get(key_a).expect("A stays tracked for follow-up");
    assert!(!resumed_entry.transport_failed);
    assert_eq!(resumed_entry.attempts, 1);
    assert_eq!(resumed_entry.next_due_at, Some(base_ms + 15_000 + i64::try_from(RESET_FOLLOWUP_DELAYS[0].as_millis()).unwrap()));
}
