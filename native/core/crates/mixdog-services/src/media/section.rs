//! The `mediaJobs` section (desktop-services.md §15 P9, SPEC R14): key = job id, value = the snapshot
//! `media/getMediaJob` answers, delivered on the scoped feed `media:<jobId>` and kept out of the app
//! snapshot. A job's changes are pushed as they happen; a job that left the table (a start or a list
//! swept it past its terminal TTL, where `getMediaJob` answers null) has its key removed and its route dropped,
//! so the section holds the jobs the table holds and no more.
//!
//! Progress arrives as often as a lane reports it; the task folds everything that queued up while
//! it ran into the latest state per job, so a burst is one push per job.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::Arc;

use mixdog_core_api::ids::FeedId;
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::state::StatePublisher;
use mixdog_core_base::state::ScopedSection;
use mixdog_core_base::state::ScopedSections;
use mixdog_core_base::state::change_of;
use mixdog_protocol::SectionName;
use mixdog_rt::CancellationToken;
use mixdog_rt::TaskClass;
use serde_json::Value;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;

use super::jobs::JobEvent;
use super::jobs::MediaJobs;

/// What a job's key holds after the events of one wake: its latest snapshot, or gone.
type Latest = BTreeMap<String, Option<Value>>;
/// The snapshot each key of the section holds.
type Held = HashMap<String, Value>;

fn fold(latest: &mut Latest, event: JobEvent) {
    match event {
        JobEvent::Changed(snapshot) => {
            let id = snapshot["id"].as_str().expect("a job snapshot has an id").to_owned();
            latest.insert(id, Some(snapshot));
        }
        JobEvent::Swept(id) => {
            latest.insert(id, None);
        }
    }
}

/// The scoped feeds of the jobs held, one per key.
type Open = HashMap<String, ScopedSection>;

/// Publishes `latest`; `held` is the snapshot each key holds, so an unchanged one is not pushed again
/// (a lane reports the same progress twice) and a removal is only sent for a key held. A job's feed
/// `media:<jobId>` is opened with its first snapshot; after the removal its route is dropped and the
/// subscriber, which has seen the removal, ends its subscription.
fn push(latest: Latest, held: &mut Held, open: &mut Open, scoped: &ScopedSections, publisher: &dyn StatePublisher) {
    for (id, snapshot) in latest {
        match snapshot {
            Some(snapshot) => {
                if held.get(&id) != Some(&snapshot) {
                    if !open.contains_key(&id) {
                        open.insert(id.clone(), scoped.open(FeedId::from(format!("media:{id}")), SectionName::MediaJobs, &id));
                    }
                    publisher.publish(SectionName::MediaJobs, Some(id.clone()), change_of(&snapshot));
                    held.insert(id, snapshot);
                }
            }
            None => {
                if held.remove(&id).is_some() {
                    publisher.publish(SectionName::MediaJobs, Some(id.clone()), SectionChange::Removed);
                    open.remove(&id);
                }
            }
        }
    }
}
enum Wake {
    Events(Latest),
    /// The receiver fell behind and lost events.
    Lagged,
    Closed,
}

/// One wake: `first` and everything queued behind it.
fn wake(events: &mut broadcast::Receiver<JobEvent>, first: Result<JobEvent, RecvError>) -> Wake {
    let mut latest = Latest::new();
    match first {
        Ok(event) => fold(&mut latest, event),
        Err(RecvError::Closed) => return Wake::Closed,
        Err(RecvError::Lagged(_)) => return Wake::Lagged,
    }
    loop {
        match events.try_recv() {
            Ok(event) => fold(&mut latest, event),
            Err(broadcast::error::TryRecvError::Lagged(_)) => return Wake::Lagged,
            Err(_) => return Wake::Events(latest),
        }
    }
}

/// After a lag the section is rebuilt from the table: its jobs are set and every other key held is removed.
/// The receiver is replaced first, so an event after the listing is delivered rather than lost.
fn rebuild(events: &mut broadcast::Receiver<JobEvent>, jobs: &MediaJobs, held: &Held) -> Latest {
    *events = events.resubscribe();
    let mut latest: Latest = held.keys().map(|id| (id.clone(), None)).collect();
    for snapshot in jobs.list() {
        fold(&mut latest, JobEvent::Changed(snapshot));
    }
    latest
}

/// Starts the task that keeps the `mediaJobs` section pushed. `publisher` is the core's one
/// `StatePublisher`: it routes each job's key to the scoped feed `scoped` opened for it.
pub fn spawn_media_section(jobs: &Arc<MediaJobs>, publisher: Arc<dyn StatePublisher>, scoped: ScopedSections, cancel: CancellationToken) {
    let mut events = jobs.subscribe();
    let jobs = jobs.clone();
    mixdog_rt::spawn("media-jobs-section", TaskClass::Work, async move {
        let mut held = Held::new();
        let mut open = Open::new();
        loop {
            let first = tokio::select! {
                () = cancel.cancelled() => return,
                first = events.recv() => first,
            };
            let latest = match wake(&mut events, first) {
                Wake::Events(latest) => latest,
                Wake::Lagged => rebuild(&mut events, &jobs, &held),
                Wake::Closed => return,
            };
            push(latest, &mut held, &mut open, &scoped, &*publisher);
        }
    });
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicI64;
    use std::sync::atomic::Ordering;

    use async_trait::async_trait;
    use bytes::Bytes;
    use mixdog_core_api::feed::Feed;
    use mixdog_core_api::feed::FeedSource;
    use mixdog_core_api::feed::ScopedFeed;
    use mixdog_core_api::feed::ScopedFeeds;
    use mixdog_core_api::feed::FeedView;
    use mixdog_core_api::feed::Window;
    use mixdog_core_api::feed::subscribe;
    use mixdog_core_api::ids::ConnectionId;
    use mixdog_core_api::ids::SubscriptionId;
    use mixdog_core_api::mock::EchoView;
    use mixdog_core_api::mock::MockConnection;
    use mixdog_core_api::mock::MockFeed;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_api::mock::MockScopedFeeds;
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_core_api::mock::epoch;
    use mixdog_core_api::sink::ConnectionSink;
    use mixdog_core_base::state::ScopedRouteTable;
    use mixdog_core_base::state::StateRuntime;
    use serde_json::json;

    use super::*;
    use crate::media::jobs::GeneratedMedia;
    use crate::media::jobs::GenerationRequest;
    use crate::media::jobs::MediaFailure;
    use crate::media::jobs::MediaGenerator;
    use crate::media::jobs::ResolvedMedia;
    use crate::media::store::Marks;
    use crate::media::store::MediaStore;

    /// `section-producers/media-jobs.json` by `record-section-producers.mjs`: Node's own `getMediaJob(id)`
    /// answers through each scenario (every field: the job id, the clock stamps and the asset id are the ones
    /// the recording pinned, `ids` and `clock`), what its adapter did to cause them, and `getMediaJob` after
    /// the TTL passed and a list swept.
    fn twin() -> Value {
        serde_json::from_str(include_str!("../../../../fixtures/section-producers/media-jobs.json")).unwrap()
    }

    fn value(change: &SectionChange) -> Value {
        match change {
            SectionChange::Set(bytes) => serde_json::from_slice(bytes).unwrap(),
            other => panic!("not an inline value: {other:?}"),
        }
    }

    fn id_of(scenario: &Value) -> String {
        scenario["reads"][0]["id"].as_str().unwrap().to_owned()
    }

    fn scoped_sections() -> ScopedSections {
        ScopedSections::new(Arc::new(MockScopedFeeds::new(MockLimits::default())), Arc::new(ScopedRouteTable::default()))
    }

    /// Takes what is queued on `events` through one wake and pushes it.
    async fn deliver(events: &mut broadcast::Receiver<JobEvent>, held: &mut Held, open: &mut Open, scoped: &ScopedSections, publisher: &dyn StatePublisher) {
        let first = events.recv().await;
        let Wake::Events(latest) = wake(events, first) else { panic!("no lag in this test") };
        push(latest, held, open, scoped, publisher);
    }

    /// Each answer Node gave is the value its job's key holds, in order; an answer equal to the one before
    /// pushes nothing; the sweep's removal is pushed once and ends the job's route.
    #[tokio::test]
    async fn a_job_is_pushed_as_node_answered_and_removed_when_it_leaves_the_table() {
        for scenario in twin()["scenarios"].as_array().unwrap() {
            let (tx, mut rx) = broadcast::channel(64);
            let (publisher, mut held, mut open, scoped) = (MockStatePublisher::default(), Held::new(), Open::new(), scoped_sections());
            let id = id_of(scenario);
            let mut distinct: Vec<&Value> = Vec::new();
            for read in scenario["reads"].as_array().unwrap() {
                tx.send(JobEvent::Changed(read.clone())).unwrap();
                deliver(&mut rx, &mut held, &mut open, &scoped, &publisher).await;
                if distinct.last() != Some(&read) {
                    distinct.push(read);
                }
            }
            assert_eq!(open.keys().collect::<Vec<_>>(), [&id], "{}: the job's feed is open while it is held", scenario["name"]);
            let published = publisher.published();
            assert_eq!(published.len(), distinct.len(), "{}: one push per changed answer", scenario["name"]);
            for ((section, key, change), read) in published.iter().zip(distinct) {
                assert_eq!((*section, key.as_deref()), (SectionName::MediaJobs, Some(id.as_str())), "{}", scenario["name"]);
                assert_eq!(&value(change), read, "{}", scenario["name"]);
            }
            assert!(scenario["afterSweep"].is_null(), "Node answers null once swept");
            for _ in 0..2 {
                tx.send(JobEvent::Swept(id.clone())).unwrap();
                deliver(&mut rx, &mut held, &mut open, &scoped, &publisher).await;
            }
            let after = publisher.published();
            assert_eq!(after.len(), published.len() + 1, "{}: one removal", scenario["name"]);
            assert_eq!((after.last().unwrap().0, after.last().unwrap().1.as_deref(), &after.last().unwrap().2), (SectionName::MediaJobs, Some(id.as_str()), &SectionChange::Removed));
            assert!(open.is_empty(), "{}: the route ends with the job", scenario["name"]);
        }
    }

    /// A burst that queued up while the task ran is one push per job: the latest.
    #[tokio::test]
    async fn a_burst_of_progress_is_one_push_of_the_latest() {
        let twin = twin();
        let scenario = &twin["scenarios"][0];
        let (tx, mut rx) = broadcast::channel(64);
        let (publisher, mut held, mut open, scoped) = (MockStatePublisher::default(), Held::new(), Open::new(), scoped_sections());
        for read in scenario["reads"].as_array().unwrap() {
            tx.send(JobEvent::Changed(read.clone())).unwrap();
        }
        deliver(&mut rx, &mut held, &mut open, &scoped, &publisher).await;
        let published = publisher.published();
        assert_eq!(published.len(), 1);
        assert_eq!(value(&published[0].2), *scenario["reads"].as_array().unwrap().last().unwrap());
    }

    /// Replays what Node's adapter did in a scenario.
    struct Replay(Value);

    #[async_trait]
    impl MediaGenerator for Replay {
        async fn resolve(&self, lane: &str, kind: &str, model: &str) -> Result<ResolvedMedia, MediaFailure> {
            Ok(ResolvedMedia { kind: kind.into(), lane: lane.into(), model: model.into(), max_references: 1, request_model: None })
        }
        async fn lanes(&self) -> Value {
            json!([])
        }
        async fn generate(&self, request: GenerationRequest) -> Result<GeneratedMedia, MediaFailure> {
            for value in self.0["progress"].as_array().unwrap() {
                (request.progress)(value.as_f64().unwrap());
            }
            let ends = &self.0["ends"];
            if ends["waitsForCancel"] == true {
                request.cancel.cancelled().await;
                return Err(MediaFailure { message: "aborted".into(), code: None, usage: None });
            }
            if let Some(thrown) = ends.get("throws") {
                return Err(MediaFailure { message: thrown["message"].as_str().unwrap().into(), code: thrown["code"].as_str().map(str::to_owned), usage: None });
            }
            Ok(GeneratedMedia { bytes: b"bytes".to_vec(), mime: ends["result"]["mime"].as_str().unwrap().into(), revised_prompt: None, duration_seconds: ends["result"]["durationSeconds"].as_f64(), usage: None })
        }
    }

    /// A job table over a store whose clock and ids are the ones the recording pinned.
    struct Table {
        _dir: tempfile::TempDir,
        jobs: Arc<MediaJobs>,
        clock: Arc<AtomicI64>,
        scenario: Value,
    }

    impl Table {
        fn new(scenario: &Value) -> Self {
            let clock = Arc::new(AtomicI64::new(scenario["clock"]["startAt"].as_i64().unwrap()));
            let ids: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(scenario["ids"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_owned()).collect()));
            let marks = Marks {
                now: Arc::new({
                    let clock = clock.clone();
                    move || clock.load(Ordering::SeqCst)
                }),
                id: Arc::new(move || ids.lock().unwrap().pop_front().expect("Node drew this id")),
            };
            let dir = tempfile::tempdir().unwrap();
            let store = Arc::new(MediaStore::with_marks(dir.path(), mixdog_rt::testing::tokens().durability_io, marks));
            let jobs = MediaJobs::new(store, Arc::new(Replay(scenario.clone())), Some(4));
            Self { _dir: dir, jobs, clock, scenario: scenario.clone() }
        }

        /// Starts the job at Node's start instant and lets it end at Node's end instant.
        async fn run(&self) -> (Value, String) {
            let started = self.jobs.start(&self.scenario["request"]).await.unwrap();
            let id = started["id"].as_str().unwrap().to_owned();
            self.clock.store(self.scenario["clock"]["endAt"].as_i64().unwrap(), Ordering::SeqCst);
            if self.scenario["ends"]["waitsForCancel"] == true {
                assert_eq!(self.jobs.cancel(&id)["canceled"], true);
            }
            yield_until(|| self.jobs.get(&id).is_some_and(|job| job["status"] != "running")).await;
            (started, id)
        }

        /// The instant Node's clock stood at when its list swept.
        fn at_sweep(&self) {
            self.clock.store(self.scenario["clock"]["sweepAt"].as_i64().unwrap(), Ordering::SeqCst);
        }
    }

    async fn yield_until(mut done: impl FnMut() -> bool) {
        for _ in 0..100_000 {
            if done() {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("the condition never held");
    }

    /// The Rust table, run through each scenario Node ran under the clock and ids Node's recording pinned,
    /// announces exactly the answers Node gave, field for field and step for step: the start answer, every
    /// progress report, the terminal answer. Node keeps the job past its TTL until a list sweeps it, and so
    /// does the table: only the sweep ends the job, and it announces that.
    #[tokio::test]
    async fn every_answer_of_the_table_is_node_s_answer_and_only_a_sweep_ends_the_job() {
        for scenario in twin()["scenarios"].as_array().unwrap() {
            let name = &scenario["name"];
            let table = Table::new(scenario);
            let mut events = table.jobs.subscribe();
            let (started, id) = table.run().await;
            let reads = scenario["reads"].as_array().unwrap();
            assert_eq!(&started, &reads[0], "{name}: the start answer");
            let mut announced = Vec::new();
            while let Ok(JobEvent::Changed(snapshot)) = events.try_recv() {
                announced.push(snapshot);
            }
            assert_eq!(&announced, reads, "{name}: every announced answer");
            assert_eq!(table.jobs.get(&id).as_ref(), reads.last(), "{name}: the terminal answer");

            table.at_sweep();
            assert_eq!(table.jobs.get(&id).is_some(), scenario["answeredBeforeSweep"], "{name}: past the TTL the job stays until a sweep");
            assert!(events.try_recv().is_err(), "{name}: nothing ends the job but a sweep");
            table.jobs.list();
            assert_eq!(table.jobs.get(&id), scenario["afterSweep"].as_object().map(|_| scenario["afterSweep"].clone()), "{name}: the sweep removed it");
            assert_eq!(events.try_recv(), Ok(JobEvent::Swept(id)), "{name}");
        }
    }

    /// Feeds that remember what was created, so a test can subscribe to a job's feed as a client would.
    struct Feeds {
        inner: MockScopedFeeds,
        made: Mutex<Vec<(String, Arc<dyn ScopedFeed>)>>,
    }

    impl ScopedFeeds for Feeds {
        fn create(&self, id: mixdog_core_api::ids::FeedId, view: Arc<dyn FeedView>) -> Arc<dyn ScopedFeed> {
            let feed = self.inner.create(id.clone(), view);
            self.made.lock().unwrap().push((id.to_string(), feed.clone()));
            feed
        }
    }

    impl Feeds {
        fn source(&self, id: &str) -> Option<Arc<dyn FeedSource>> {
            let made = self.made.lock().unwrap();
            let (_, feed) = made.iter().find(|(made, _)| made == id)?;
            let source: Arc<dyn FeedSource> = feed.clone();
            Some(source)
        }
    }

    fn frames(conn: &MockConnection) -> Vec<Value> {
        conn.drain_text().iter().filter_map(|text| serde_json::from_str::<Value>(text.split_once(':')?.1).ok()).filter(|frame| frame["method"].is_string()).collect()
    }

    /// Through the core's real hub and route table: the job's changes reach the subscribers of `media:<jobId>`
    /// with the values Node answered, the app feed never holds the section, and the sweep's removal reaches the
    /// subscriber before the route is dropped.
    #[tokio::test]
    async fn the_job_s_feed_carries_node_s_values_and_the_sweep_removes_the_key() {
        let limits = MockLimits::default();
        let twin = twin();
        for scenario in twin["scenarios"].as_array().unwrap() {
            let name = &scenario["name"];
            let table = Table::new(scenario);
            let app_feed: Arc<dyn Feed> = Arc::new(MockFeed::new(mixdog_core_api::ids::FeedId::from("app"), epoch(7), Arc::new(EchoView), limits));
            let runtime = StateRuntime::new(app_feed);
            let feeds = Arc::new(Feeds { inner: MockScopedFeeds::new(limits), made: Mutex::new(Vec::new()) });
            let cancel = CancellationToken::new();
            spawn_media_section(&table.jobs, runtime.publisher.clone(), runtime.scoped_sections(feeds.clone()), cancel.clone());
            let (_, id) = table.run().await;
            let feed_id = format!("media:{id}");
            yield_until(|| feeds.source(&feed_id).is_some()).await;

            let conn = MockConnection::new(ConnectionId(1), limits);
            let source = feeds.source(&feed_id).unwrap();
            let attached = subscribe(&source, SubscriptionId::from("sub"), Window::Fixed, None, &conn).unwrap();
            conn.send_control_release(Bytes::from_static(b"{}"), attached.release).unwrap();

            // What the subscriber learns, in order: the snapshot's value, then each push.
            let reads = scenario["reads"].as_array().unwrap();
            let mut learned: Vec<Value> = Vec::new();
            while learned.last() != reads.last() {
                for frame in frames(&conn) {
                    let update = if frame["method"] == "feed/snapshot" { frame["params"]["state"]["sections"][0].clone() } else { frame["params"].clone() };
                    assert_eq!((update["section"].as_str(), update["key"].as_str()), (Some("mediaJobs"), Some(id.as_str())), "{name}");
                    learned.push(update["value"].clone());
                }
                tokio::task::yield_now().await;
            }
            let mut from = 0;
            for value in &learned {
                from += reads[from..].iter().position(|read| read == value).unwrap_or_else(|| panic!("{name}: {value} is not one of Node's answers, in order"));
            }
            assert!(runtime.app.current(SectionName::MediaJobs, Some(id.as_str())).is_none(), "{name}: the app snapshot never holds the section");

            table.at_sweep();
            table.jobs.list();
            let mut removed = false;
            while !removed {
                removed = frames(&conn).iter().any(|frame| frame["params"]["removed"] == true && frame["params"]["key"] == id.as_str());
                tokio::task::yield_now().await;
            }
            cancel.cancel();
        }
    }
}