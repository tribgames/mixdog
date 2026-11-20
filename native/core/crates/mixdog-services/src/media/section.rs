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


