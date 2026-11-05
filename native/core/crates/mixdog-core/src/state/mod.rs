//! The one `StatePublisher` and section registry (DS §2, SPEC R14).
//!
//! [`SectionFeedState`] owns the sections of one feed: per `(section, key)` a strictly increasing
//! revision and the latest value. A publication appends one notification frame to the feed and
//! swaps the feed's read model in the same call; the read model is the attach snapshot
//! (`app/snapshot`: the current value of every section). There is no timer and no debounce:
//! the owner calls `publish` after its state is durable.
//!
//! [`StateHub`] is the `StatePublisher` every domain receives. App sections go to the app feed;
//! sections of scoped feeds (thread, `git:<root>`, `lsp:<root>`, …) go to the publisher their
//! owner registered through [`ScopedRoutes`].

mod routes;

pub use routes::RouteGuard;
pub use routes::ScopedRouteTable;
pub use routes::StateRuntime;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use bytes::Bytes;
use mixdog_core_api::feed::Feed;
use mixdog_core_api::feed::FeedFrame;
use mixdog_core_api::feed::FeedPosition;
use mixdog_core_api::feed::FeedView;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::FeedEpoch;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::state::StatePublisher;
use mixdog_protocol::INLINE_MAX;
use mixdog_protocol::SectionFeed;
use mixdog_protocol::SectionName;
use mixdog_rt::CpuInteractive;
use mixdog_rt::InLane;
use serde::Serialize;
use serde_json::Value;

/// A section value as published: inline when its encoding fits `INLINE_MAX`, else a stub the
/// client pages with the section's list method (`count` = items of the array or object).
pub fn change_of<T: Serialize>(value: &T) -> SectionChange {
    let encoded = serde_json::to_vec(value).expect("section values serialize");
    if encoded.len() <= INLINE_MAX {
        return SectionChange::Set(Bytes::from(encoded));
    }
    let count = match serde_json::to_value(value).expect("section values serialize") {
        Value::Array(items) => items.len(),
        Value::Object(fields) => fields.len(),
        _ => 1,
    };
    SectionChange::Stub {
        count: count as u64,
    }
}

type SectionKey = (SectionName, Option<String>);

#[derive(Clone)]
struct Entry {
    revision: u64,
    change: SectionChange,
}

type Entries = HashMap<SectionKey, Entry>;

pub struct SectionFeedState {
    feed: Arc<dyn Feed>,
    stamp: Stamp,
    inner: Mutex<Inner>,
}

struct Inner {
    seq: u64,
    entries: Arc<Entries>,
}

/// `"feed":{"id","epoch"` of every frame; the `seq` is appended per frame.
#[derive(Clone)]
struct Stamp {
    prefix: String,
}

impl Stamp {
    fn new(id: &FeedId, epoch: &FeedEpoch) -> Self {
        Self {
            prefix: format!(
                r#""feed":{{"id":{},"epoch":{},"seq":"#,
                id.to_json_string(),
                epoch.to_json_string()
            ),
        }
    }

    fn close(&self, out: &mut Vec<u8>, seq: u64) {
        out.extend_from_slice(self.prefix.as_bytes());
        out.extend_from_slice(seq.to_string().as_bytes());
        out.extend_from_slice(b"}}");
    }
}

/// `{"section","key","revision", value|stub|removed}`, the `params` of a section notification
/// and an element of the snapshot.
fn update_json(out: &mut Vec<u8>, section: SectionName, key: &Option<String>, entry: &Entry) {
    out.extend_from_slice(br#"{"section":"#);
    out.extend_from_slice(section.wire().to_json_string().as_bytes());
    out.extend_from_slice(br#","key":"#);
    out.extend_from_slice(key.to_json_string().as_bytes());
    out.extend_from_slice(format!(r#","revision":{}"#, entry.revision).as_bytes());
    match &entry.change {
        SectionChange::Set(value) => {
            out.extend_from_slice(br#","value":"#);
            out.extend_from_slice(value);
        }
        SectionChange::Stub { count } => {
            out.extend_from_slice(format!(r#","stub":{{"count":{count},"stub":true}}"#).as_bytes());
        }
        SectionChange::Removed => out.extend_from_slice(br#","removed":true"#),
    }
    out.push(b'}');
}

trait ToJsonString {
    fn to_json_string(&self) -> String;
}

impl<T: Serialize + ?Sized> ToJsonString for T {
    fn to_json_string(&self) -> String {
        serde_json::to_string(self).expect("plain values serialize")
    }
}

impl SectionFeedState {
    /// Sections of `feed`, whose only producer this is. Starts empty at the feed's position.
    pub fn new(feed: Arc<dyn Feed>) -> Self {
        let at = feed.position();
        let stamp = Stamp::new(&feed.feed_id(), &at.epoch);
        Self {
            feed,
            stamp,
            inner: Mutex::new(Inner {
                seq: at.seq,
                entries: Arc::new(Entries::new()),
            }),
        }
    }

    /// The latest `(revision, change)` of a section, `None` when it was never set or was removed.
    pub fn current(
        &self,
        section: SectionName,
        key: Option<&str>,
    ) -> Option<(u64, SectionChange)> {
        let inner = lock(&self.inner);
        let entry = inner.entries.get(&(section, key.map(str::to_owned)))?;
        (entry.change != SectionChange::Removed).then(|| (entry.revision, entry.change.clone()))
    }
}

impl SectionFeedState {
    /// Appends a notification that is not a section (`core/drain`) to the feed as its next frame.
    /// The snapshot is unchanged: the notification is an event, not state. This state is the
    /// feed's only producer, so the frame takes the next seq here.
    pub fn notify<P: Serialize>(&self, method: &str, params: &P) {
        let mut inner = lock(&self.inner);
        let seq = inner.seq + 1;
        let mut bytes = Vec::with_capacity(160);
        bytes.extend_from_slice(br#"{"method":"#);
        bytes.extend_from_slice(method.to_json_string().as_bytes());
        bytes.extend_from_slice(br#","params":"#);
        bytes.extend_from_slice(params.to_json_string().as_bytes());
        bytes.push(b',');
        self.stamp.close(&mut bytes, seq);
        let frame = FeedFrame { seq, bytes: Bytes::from(bytes) };
        if self.feed.publish(&[frame], None).is_ok() {
            inner.seq = seq;
        }
    }
}

impl StatePublisher for SectionFeedState {
    fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
        let mut inner = lock(&self.inner);
        let slot = (section, key);
        let entry = Entry {
            revision: inner.entries.get(&slot).map_or(0, |e| e.revision) + 1,
            change,
        };
        let seq = inner.seq + 1;
        let mut bytes = Vec::with_capacity(160);
        bytes.extend_from_slice(br#"{"method":"#);
        bytes.extend_from_slice(section.notification_method().to_json_string().as_bytes());
        bytes.extend_from_slice(br#","params":"#);
        update_json(&mut bytes, section, &slot.1, &entry);
        bytes.push(b',');
        self.stamp.close(&mut bytes, seq);

        let mut entries = (*inner.entries).clone();
        entries.insert(slot, entry);
        let entries = Arc::new(entries);
        let view = Arc::new(SectionsView {
            stamp: self.stamp.clone(),
            entries: entries.clone(),
        });
        let frame = FeedFrame {
            seq,
            bytes: Bytes::from(bytes),
        };
        // This state is the feed's only producer, so the seq cannot gap.
        if self.feed.publish(&[frame], Some(view)).is_ok() {
            inner.seq = seq;
            inner.entries = entries;
        }
    }
}

/// The attach snapshot: every section's current value at the position the attach registered.
struct SectionsView {
    stamp: Stamp,
    entries: Arc<Entries>,
}

impl FeedView for SectionsView {
    fn encode_snapshot(
        &self,
        _lane: &InLane<CpuInteractive>,
        at: FeedPosition,
        _window: &Window,
    ) -> Bytes {
        let mut live: Vec<(&SectionKey, &Entry)> = self
            .entries
            .iter()
            .filter(|(_, e)| e.change != SectionChange::Removed)
            .collect();
        live.sort_by(|a, b| (a.0.0.wire(), &a.0.1).cmp(&(b.0.0.wire(), &b.0.1)));
        let mut out = Vec::with_capacity(256);
        out.extend_from_slice(br#"{"method":"app/snapshot","params":{"sections":["#);
        for (i, ((section, key), entry)) in live.into_iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            update_json(&mut out, *section, key, entry);
        }
        out.extend_from_slice(b"]},");
        self.stamp.close(&mut out, at.seq);
        Bytes::from(out)
    }
}

/// The read model of a feed that has published nothing yet: a snapshot with no sections. The
/// composition root gives it to `CoreFeed::new` before the first `SectionFeedState` publication.
pub fn empty_view(id: &FeedId, epoch: &FeedEpoch) -> Arc<dyn FeedView> {
    Arc::new(SectionsView {
        stamp: Stamp::new(id, epoch),
        entries: Arc::new(Entries::new()),
    })
}

/// Where the sections of scoped feeds go. The owner of a scoped feed (thread actor, `git:<root>`
/// inspector, …) answers for its own keys; no route means no subscriber exists.
pub trait ScopedRoutes: Send + Sync {
    fn route(&self, section: SectionName, key: Option<&str>) -> Option<Arc<dyn StatePublisher>>;
}

/// The `StatePublisher` of the core.
pub struct StateHub {
    app: Arc<SectionFeedState>,
    scoped: Arc<dyn ScopedRoutes>,
}

impl StateHub {
    pub fn new(app: Arc<SectionFeedState>, scoped: Arc<dyn ScopedRoutes>) -> Self {
        Self { app, scoped }
    }

    pub fn app(&self) -> &Arc<SectionFeedState> {
        &self.app
    }
}

impl StatePublisher for StateHub {
    fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
        match section.feed() {
            SectionFeed::App => self.app.publish(section, key, change),
            _ => {
                if let Some(target) = self.scoped.route(section, key.as_deref()) {
                    target.publish(section, key, change);
                }
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod tests;
