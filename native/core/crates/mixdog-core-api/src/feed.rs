//! Feeds and the one attach algorithm (P §6, SPEC §4.2 R4).
//!
//! A feed is an ordered stream of encoded notification frames with an `epoch` and a contiguous
//! `seq` starting at 1: one per thread (`feed.id = threadId`), one `app` feed, and scoped feeds
//! (`terminal:<tab>`, `fs:<watch>`, `search:<session>`, `login:<flow>`, `git:<root>`, …;
//! DS §2.1). Every feed is one [`Feed`]
//! holding its byte-bounded ring, its current [`FeedView`] and its subscriber lanes under one
//! `std::sync::Mutex` (RL §5.1).
//!
//! **Attach** ([`FeedSource::attach`], sync, never through an actor inbox) is the one
//! registration path. It runs for a new subscription ([`AttachStart::Open`], on RT-C, through
//! [`subscribe`]) and for the writer's recovery of a lagged lane ([`AttachStart::Recover`],
//! mode forced to snapshot into the writer's reservation). Under the feed lock it reads
//! `(view, seq S, ring)`, decides replay or snapshot, pushes the replay frames or a
//! [`crate::sink::SnapshotSlot`] (holding the recovery reservation, or `maxSnapshotBytes`
//! reserved now, or lags the lane when the budget lacks it), and registers the lane at `S`.
//! After unlocking it submits the snapshot encode for `(feed, epoch, S, window)` to
//! cpu-interactive (single-flight, cached), which fills the slot.
//!
//! **Publish** ([`Feed::publish`], by the one producer of the feed after its state is durable):
//! under the same lock it appends the frames to the ring, swaps the view, and pushes each frame
//! into every non-lagged lane with `try_reserve`, lagging a lane whose reservation fails.
//!
//! Because both run under the one lock, a lane registered at `S` receives exactly the frames
//! `> S`, behind its replay frames or slot; nothing is lost or duplicated, and the wire order
//! per lane is response → replay frames or snapshot at `S` → live frames from `S + 1`:
//!
//! ```
//! use std::sync::Arc;
//! use bytes::Bytes;
//! use mixdog_core_api::feed::*;
//! use mixdog_core_api::ids::{ConnectionId, FeedId, SubscriptionId};
//! use mixdog_core_api::mock::{epoch, event, EchoView, MockConnection, MockFeed, MockLimits};
//! use mixdog_core_api::sink::ConnectionSink;
//!
//! let limits = MockLimits::default();
//! let feed = Arc::new(MockFeed::new(FeedId::from("app"), epoch(7), Arc::new(EchoView), limits));
//! feed.publish(&[event(1), event(2), event(3)], None).unwrap();
//!
//! let conn = MockConnection::new(ConnectionId(1), limits);
//! let source: Arc<dyn FeedSource> = feed.clone();
//! let attached = subscribe(&source, SubscriptionId::from("s1"), Window::Fixed, None, &conn).unwrap();
//! assert_eq!(attached.decision.mode, AttachMode::Snapshot);
//! assert_eq!(attached.decision.start_seq, 4);
//!
//! // Published before the response is written: queued behind the snapshot, not sent.
//! feed.publish(&[event(4)], None).unwrap();
//! assert!(conn.drain().is_empty());
//!
//! conn.send_control_release(Bytes::from_static(b"response"), attached.release).unwrap();
//! feed.publish(&[event(5)], None).unwrap();
//! assert_eq!(
//!     conn.drain_text(),
//!     ["control:response", "s1:snapshot@3", "s1:evt@4", "s1:evt@5"],
//! );
//! ```
//!
//! A resume position in the same epoch and window whose frames are still in the ring and fit
//! the free event budget replays instead:
//!
//! ```
//! use std::sync::Arc;
//! use bytes::Bytes;
//! use mixdog_core_api::feed::*;
//! use mixdog_core_api::ids::{ConnectionId, FeedId, SubscriptionId};
//! use mixdog_core_api::mock::{epoch, event, EchoView, MockConnection, MockFeed, MockLimits};
//! use mixdog_core_api::sink::ConnectionSink;
//!
//! let limits = MockLimits::default();
//! let feed = Arc::new(MockFeed::new(FeedId::from("app"), epoch(7), Arc::new(EchoView), limits));
//! feed.publish(&[event(1), event(2), event(3)], None).unwrap();
//!
//! let conn = MockConnection::new(ConnectionId(1), limits);
//! let resume_from = Some(ResumeFrom {
//!     position: FeedPosition { epoch: epoch(7), seq: 1 },
//!     window: Window::Fixed,
//!     positioned: None,
//! });
//! let source: Arc<dyn FeedSource> = feed.clone();
//! let attached = subscribe(&source, SubscriptionId::from("s1"), Window::Fixed, resume_from, &conn).unwrap();
//! assert_eq!(attached.decision.mode, AttachMode::Replay);
//! assert_eq!(attached.decision.start_seq, 2);
//!
//! feed.publish(&[event(4)], None).unwrap();
//! conn.send_control_release(Bytes::from_static(b"response"), attached.release).unwrap();
//! assert_eq!(
//!     conn.drain_text(),
//!     ["control:response", "s1:evt@2", "s1:evt@3", "s1:evt@4"],
//! );
//! ```
//!
//! A connection that asks again for a feed it already follows, in the same window and from a
//! position its subscription delivers on from, is not attached a second time: that subscription
//! carries on ([`FeedSource::carries`]), so nothing it delivered reaches the connection twice.
//!
//! Scoped feeds come from [`ScopedFeeds::create`] and end with [`ScopedFeed::close`]; between
//! the two they are ordinary feeds on this same attach and publish path.
//!
//! The executable form of this contract is [`crate::mock::conformance`]; every [`Feed`]
//! implementation runs it, and every [`ScopedFeeds`] implementation runs its `run_scoped`.

use std::fmt;
use std::sync::Arc;
use std::sync::Weak;

use bytes::Bytes;
use mixdog_rt::CpuInteractive;
use mixdog_rt::InLane;
use serde::Deserialize;
use serde::Serialize;

use crate::error::CoreError;
use crate::ids::FeedEpoch;
use crate::ids::FeedId;
use crate::ids::SubscriptionId;
use crate::sink::ConnectionSink;
use crate::sink::Lane;
use crate::sink::LaneRecovery;
use crate::sink::LaneRelease;
use crate::sink::Reservation;

/// A position in a feed: the frame `seq` of `epoch` (0 = before the first frame). The epoch is
/// drawn when the feed's producer instance is created (thread actor load; `serverInstanceId`
/// for the app feed).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FeedPosition {
    pub epoch: FeedEpoch,
    pub seq: u64,
}

/// The closed window descriptor of a subscription (P §6.3). Compared structurally: a changed
/// window never replays.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Window {
    /// The app feed and scoped feeds: the feed's whole read model.
    Fixed,
    /// The items of the newest turns up to n (1 ≤ n ≤ 512).
    LastItems(u16),
    LastTurns(u16),
    /// Header and runtime sections only (wire `{none: true}`).
    HeaderOnly,
    /// The positioned projection of a thread's transcript: the subscription holds a [`Grant`], first the newest
    /// stored records up to n rows ([`FeedView::first_grant`]). A frame that tells a record's rows reaches it with no
    /// row ([`FeedFrame::for_grant`]); the rows of a stored record reach it as that record's unit, when its grant
    /// holds the record ([`Feed::deliver`]). Replays into a new lane when the previous subscription's grant and the
    /// ring still cover the gap ([`PositionedResume`]); otherwise installs a fresh snapshot.
    Positioned(u16),
}

/// The name of the range a followed tail makes: the newest records a snapshot carried, and every record delivered
/// after them.
pub const TAIL_RANGE: &str = "tail";

/// How a grant holds a record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Held {
    /// In a range the subscription was sent: the record's unit replaces the one it has.
    Range,
    /// Beyond everything it was sent, under a followed tail: the unit is new to it, and joins the tail's range.
    Tail,
}

/// The records a positioned subscription holds: ranges of record ordinals of one lineage, and whether it follows
/// the tail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    /// Names exactly these ranges on this subscription; it grows with every change of them.
    pub version: u64,
    pub lineage: u64,
    /// Ascending by their first ordinal.
    pub ranges: Vec<GrantRange>,
    /// Every record from this ordinal on is held as it arrives.
    pub tail_from: Option<u64>,
}

/// One range of a grant: the records `first..=last`, with what its owner tells the subscription about it. The feed
/// reads only the ordinals; the identity and the edges are its producer's, kept here so that whoever changes the
/// grant next (a demand change, a lineage change) finds them with the ranges they belong to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrantRange {
    /// Names the range for as long as the subscription holds it.
    pub id: Arc<str>,
    pub first: u64,
    pub last: u64,
    /// The position that continues the range toward older rows; `None` when the transcript starts here.
    pub older: Option<Arc<str>>,
    /// The same toward newer rows; `None` when the transcript ends here.
    pub newer: Option<Arc<str>>,
    /// The position of the record `first`: where a read of the range starts.
    pub from: Arc<str>,
    /// The position of the record `last`.
    pub to: Arc<str>,
}

impl GrantRange {
    /// A range with no edges and no positions told, named by its first ordinal.
    pub fn of(first: u64, last: u64) -> Self {
        Self { id: Arc::from(format!("r{first}")), first, last, older: None, newer: None, from: Arc::from(""), to: Arc::from("") }
    }
}

impl Grant {
    /// How the grant holds the record `ordinal` of `lineage`: by a range it was sent, else by the tail it follows.
    pub fn held(&self, lineage: u64, ordinal: u64) -> Option<Held> {
        if lineage != self.lineage {
            return None;
        }
        if self.ranges.iter().any(|range| (range.first..=range.last).contains(&ordinal)) {
            return Some(Held::Range);
        }
        self.tail_from.is_some_and(|from| ordinal >= from).then_some(Held::Tail)
    }

    /// The record `ordinal` at `position`, new under the followed tail, joins the tail's range; `after` is the
    /// position of the stored record before it, when there is one.
    pub fn extend_tail(&mut self, ordinal: u64, position: &str, after: Option<&str>) {
        match self.ranges.iter_mut().find(|range| &*range.id == TAIL_RANGE) {
            Some(tail) => {
                tail.last = ordinal;
                tail.to = Arc::from(position);
            }
            None => {
                let position: Arc<str> = Arc::from(position);
                let older = after.map(|_| position.clone());
                self.ranges.push(GrantRange {
                    id: Arc::from(TAIL_RANGE),
                    first: ordinal,
                    last: ordinal,
                    older,
                    newer: None,
                    from: position.clone(),
                    to: position,
                });
                self.ranges.sort_by_key(|range| (range.first, range.last));
            }
        }
        self.tail_from = Some(ordinal + 1);
    }

    /// The ordinals of each range.
    pub fn spans(&self) -> Vec<(u64, u64)> {
        self.ranges.iter().map(|range| (range.first, range.last)).collect()
    }
}

/// The ranges a grant is changed to ([`FeedSource::regrant`], [`Feed::rebase`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrantAsk {
    pub lineage: u64,
    /// In any order; an empty one (`first > last`) is dropped. Ranges are kept as given: the asker decides which
    /// are one.
    pub ranges: Vec<GrantRange>,
    pub tail_from: Option<u64>,
}

impl GrantAsk {
    /// The grant of `version` these ranges make.
    pub fn granted(mut self, version: u64) -> Grant {
        self.ranges.retain(|range| range.first <= range.last);
        self.ranges.sort_by_key(|range| (range.first, range.last));
        Grant { version, lineage: self.lineage, ranges: self.ranges, tail_from: self.tail_from }
    }
}

/// A grant changed at a fence ([`FeedSource::regrant`]): the old grant accounted for every frame through `at`, every
/// later frame is delivered by the new one, and `slot` holds the place between them in the subscription's lane for the
/// message that tells the change and carries what the subscription newly holds, as of `at`.
#[must_use]
pub struct GrantFence {
    pub at: FeedPosition,
    pub version: u64,
    pub slot: crate::sink::SnapshotSlot,
}

/// The positioned grant a reconnecting client held on its previous subscription, so the core can
/// continue that grant on replay instead of encoding a fresh snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PositionedResume {
    pub subscription_id: SubscriptionId,
    pub window_version: u64,
}

/// The client's last position and the window its state was built for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResumeFrom {
    pub position: FeedPosition,
    pub window: Window,
    pub positioned: Option<PositionedResume>,
}

/// The input of the one attach algorithm.
pub struct AttachRequest {
    pub sub: SubscriptionId,
    pub start: AttachStart,
}

/// How an attach starts: the only difference between a subscription and a lag recovery.
pub enum AttachStart {
    /// A new subscription on a freshly opened, gated `lane`: replay after `resume_from` when it
    /// is replayable and its frames fit the free event budget, else snapshot at `S`.
    Open { lane: Arc<dyn Lane>, window: Window, resume_from: Option<ResumeFrom> },
    /// Writer-driven recovery of the subscription's lagged lane (P §6.5 step 3): mode forced
    /// to snapshot at `S` into `reservation` (`maxSnapshotBytes`), with the registered lane
    /// and window. A subscription no longer registered answers `connectionClosed`.
    Recover { reservation: Reservation },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachMode {
    Replay,
    Snapshot,
}

/// The core's decision; the client only stated its position.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachDecision {
    pub mode: AttachMode,
    pub epoch: FeedEpoch,
    /// First live seq after the replay frames (`resumeFrom.seq + 1`) or the snapshot (`S + 1`).
    pub start_seq: u64,
    /// `S + 1`: the first seq published after this attach. A replay's frames are below it: they were published while the client
    /// was away.
    pub live_seq: u64,
}

impl AttachDecision {
    /// The decision for a held subscription that carries on ([`FeedSource::carries`]) in a feed at `head`: a replay
    /// after `resume`, whose frames the subscription delivered or still holds in its lane.
    pub fn carried(head: FeedPosition, resume: &ResumeFrom) -> Self {
        Self { mode: AttachMode::Replay, epoch: head.epoch, start_seq: resume.position.seq + 1, live_seq: head.seq + 1 }
    }
}

/// A registered subscription. The server must write its response with
/// [`ConnectionSink::send_control_release`] using `release`.
#[must_use]
#[derive(Debug)]
pub struct Attached {
    pub decision: AttachDecision,
    pub release: LaneRelease,
}

/// One encoded notification frame of a feed. `bytes` already carries `feed{id, epoch, seq}`;
/// it is encoded once and shared by the ring and every lane.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedFrame {
    pub seq: u64,
    pub bytes: Bytes,
    /// The frame as a positioned subscription gets it, when that differs: the same event with no row when it tells a
    /// record's rows, or a row no record holds with where it stands. `bytes` is then what every other subscription gets.
    pub positioned: Option<Bytes>,
}

impl FeedFrame {
    /// A frame every subscription gets as it is.
    pub fn new(seq: u64, bytes: Bytes) -> Self {
        Self { seq, bytes, positioned: None }
    }

    /// The encoded bytes the frame holds in all its forms: what a ring that keeps it accounts for.
    pub fn held_bytes(&self) -> usize {
        self.bytes.len() + self.positioned.as_ref().map_or(0, Bytes::len)
    }

    /// The frame as a subscription holding `grant` gets it (`None`: one that is not positioned). Always a frame of
    /// this seq: a positioned subscription is told the progress, never skipped, and never a record's row by this frame.
    pub fn for_grant(&self, grant: Option<&Grant>) -> &Bytes {
        match (&self.positioned, grant) {
            (Some(positioned), Some(_)) => positioned,
            _ => &self.bytes,
        }
    }
}

/// The feed's current read model, swapped by pointer on publish (persistent structure).
pub trait FeedView: Send + Sync + 'static {
    /// Encodes the snapshot frame for `window` at `at`. Runs only on cpu-interactive; its
    /// input is bounded by the window design, so the frame fits `maxSnapshotBytes`.
    fn encode_snapshot(&self, lane: &InLane<CpuInteractive>, at: FeedPosition, window: &Window) -> Bytes;

    /// The encoded snapshot as it is delivered to one lane now. A snapshot is encoded once and shared by every attach at its seq,
    /// so a value that depends on the time of delivery (the wait left of a retrying turn) is set here, by a copy of the frame
    /// and never by encoding it again. The default delivers the frame as it is.
    fn at_delivery(&self, frame: Bytes) -> Bytes {
        frame
    }

    /// The encoded snapshot of a [`Window::Positioned`] window as the subscription whose grant takes `version` gets
    /// it: the shared encoding states the feed seq, and a subscription's window version never repeats, so a snapshot
    /// that recovers a lane states the version its grant took. The default delivers the frame as it is.
    fn at_window_version(&self, frame: Bytes, _version: u64) -> Bytes {
        frame
    }

    /// The ranges the snapshot of a [`Window::Positioned`] `window` carries: the grant a subscription starts with.
    /// Read under the feed lock, so it only reads what the view holds. `None`: the view shows no positioned rows.
    fn first_grant(&self, _window: &Window) -> Option<GrantAsk> {
        None
    }
}

/// The subscriber side of a feed, as the server sees it.
pub trait FeedSource: Send + Sync {
    fn feed_id(&self) -> FeedId;

    /// The last published position.
    fn position(&self) -> FeedPosition;

    /// The atomic attach (module docs). Never waits: the snapshot is encoded after return and
    /// fills its slot. Fails with `connectionClosed` (recovery of a detached subscription) or
    /// a core state error of the feed's owner (for example `threadClosing`), registering
    /// nothing.
    fn attach(&self, req: AttachRequest) -> Result<AttachDecision, CoreError>;

    /// Whether `sub`, a subscription the asking connection holds on this feed, already carries what a new one for
    /// `window` resumed from `resume` would: it is registered here for that window, and `resume` names that window and
    /// a position of this epoch that its lane delivers on from (at or after the position the lane was attached at, up
    /// to the head). The answer is then the decision of a replay with nothing left to send
    /// ([`AttachDecision::carried`]). `None`: attach anew. A source that wraps another answers with the other's.
    fn carries(&self, sub: &SubscriptionId, window: &Window, resume: &ResumeFrom) -> Option<AttachDecision>;

    /// Removes the subscription and closes its lane. Unknown ids are ignored.
    fn detach(&self, sub: SubscriptionId);

    /// Whether this feed's events are the ordered class ([`ConnectionSink::open_ordered_lane`]):
    /// events Node's phone path never drops (`remote-relay-push-lanes.ts:103-176`,
    /// `remote-relay-catalog.ts:79-90`). Merged, droppable state feeds answer `false`.
    fn ordered(&self) -> bool {
        false
    }

    /// The grant `sub` holds now; `None` for a subscription that is not positioned or not registered.
    fn grant(&self, _sub: &SubscriptionId) -> Option<Grant> {
        None
    }

    /// Changes the grant of the positioned subscription `sub` to `ask`, at the feed's position now (the fence), when
    /// `base_version` names the grant it holds. Under the feed lock it only swaps the grant and pushes the
    /// [`GrantFence`]'s slot into the lane; what the slot is filled with is read and encoded after return, and
    /// every frame published meanwhile waits behind it. Fails, changing nothing, with `connectionClosed` (the
    /// subscription is gone), `invalidParams` (it is not positioned) or `preconditionFailed` (another grant stands:
    /// the ask was made of ranges the subscription no longer holds; or its lane is being recovered, and the
    /// recovery's snapshot installs the grant it then holds).
    fn regrant(&self, _sub: &SubscriptionId, _base_version: u64, _ask: GrantAsk) -> Result<GrantFence, CoreError> {
        Err(CoreError::ConnectionClosed)
    }

    /// The connection whose lane `sub` is; `None` for a subscription that is not registered, or a lane that names none.
    fn owner(&self, _sub: &SubscriptionId) -> Option<crate::ids::ConnectionId> {
        None
    }

    /// The most bytes one frame pushed into a subscription's lane may have and still be delivered (the reservation of
    /// a snapshot slot).
    fn frame_budget(&self) -> usize {
        usize::MAX
    }
}

/// Subscribes `sub` to `feed` over `sink`: opens a gated lane whose lag recovery re-enters
/// `feed.attach` with [`AttachStart::Recover`], then attaches it with [`AttachStart::Open`].
/// The server writes the response with the returned release.
pub fn subscribe(
    feed: &Arc<dyn FeedSource>,
    sub: SubscriptionId,
    window: Window,
    resume_from: Option<ResumeFrom>,
    sink: &dyn ConnectionSink,
) -> Result<Attached, CoreError> {
    let recovery = Arc::new(FeedRecovery { feed: Arc::downgrade(feed) });
    let opened = if feed.ordered() { sink.open_ordered_lane(sub.clone(), recovery) } else { sink.open_lane(sub.clone(), recovery) };
    let (lane, release) = opened.map_err(|_| CoreError::ConnectionClosed)?;
    let start = AttachStart::Open { lane: lane.clone(), window, resume_from };
    match feed.attach(AttachRequest { sub, start }) {
        Ok(decision) => Ok(Attached { decision, release }),
        Err(error) => {
            lane.close();
            Err(error)
        }
    }
}

/// The lane's way back into its feed; weak so a lane never keeps its feed alive.
struct FeedRecovery {
    feed: Weak<dyn FeedSource>,
}

impl LaneRecovery for FeedRecovery {
    fn recover(&self, sub: SubscriptionId, reservation: Reservation) {
        if let Some(feed) = self.feed.upgrade() {
            // A detached subscription has nothing to recover; its reservation returns on drop.
            let _ = feed.attach(AttachRequest { sub, start: AttachStart::Recover { reservation } });
        }
    }
}

/// What [`Feed::rebase`] asks of each positioned subscription: its id, its grant, the version a change would take and the
/// feed's position; the ranges that survive with the encoded message that tells the subscription, or `None` to keep the
/// grant.
pub type Rebase<'a> = dyn FnMut(&SubscriptionId, &Grant, u64, &FeedPosition) -> Option<(GrantAsk, Bytes)> + 'a;

/// The producer side of a feed.
pub trait Feed: FeedSource {
    /// Appends `frames` (contiguous, starting at `position().seq + 1`) and, if given, swaps the
    /// view to the state after the last frame, all under the feed lock. Called only by the
    /// feed's single producer, after the state the frames describe is durable.
    fn publish(&self, frames: &[FeedFrame], view: Option<Arc<dyn FeedView>>) -> Result<(), PublishError>;

    /// Whether [`Self::publish_deferred`] is supported: the view may then lag the frames, and a snapshot attach is given the
    /// view at the seq it was built for and the frames after it from the ring.
    fn defers(&self) -> bool {
        false
    }

    /// Appends `frames` whose state the current view does not include yet (a burst of streaming deltas): the producer
    /// rebuilds its view later instead of once per frame, as a client applies the frames to the snapshot it holds. Only for a
    /// feed that [`defers`](Self::defers); the default publishes with no view swap.
    fn publish_deferred(&self, frames: &[FeedFrame]) -> Result<(), PublishError> {
        self.publish(frames, None)
    }

    /// The producer has published nothing for a while and expects to stay so: the feed lets go of the frames its view already
    /// describes. A client that resumes from before them is served the view instead of a replay.
    fn rest(&self) {}

    /// After a frame that changed the lineage (a rewind, a clear, a compaction): every positioned subscription's grant
    /// is asked of `rebase`, given the grant, the version its change would take and the feed's position, and
    /// answering the ranges that survive with the encoded message that tells the subscription, pushed into its lane
    /// at once; `None` keeps the grant. Called by the producer right after it published the lineage change, so no
    /// frame of the new lineage is delivered by an old grant.
    fn rebase(&self, _rebase: &mut Rebase<'_>) {}

    /// The stored record `ordinal` of `lineage`, at `position`, as it reads now: each positioned subscription whose
    /// grant holds it is sent `frame` of how it holds it, at the feed's position, in its lane at once; one that
    /// follows the tail then holds the record in the tail's range (`after`: the position of the stored record before
    /// it). `view`, when given, becomes the feed's view under the same lock, so a snapshot attached after this call
    /// carries the record and one attached before is sent it here. Called by the producer in the order the records
    /// were stored and read.
    fn deliver(
        &self,
        _lineage: u64,
        _ordinal: u64,
        _position: &str,
        _after: Option<&str>,
        _view: Option<Arc<dyn FeedView>>,
        _frame: &mut dyn FnMut(Held, &FeedPosition) -> Bytes,
    ) {
    }

    /// Every range a positioned subscription holds in `lineage`.
    fn held(&self, _lineage: u64) -> Vec<GrantRange> {
        Vec::new()
    }
}

/// A scoped feed (`fs:<watchId>`, `search:<sessionId>`, …; DS §2.1), created through
/// [`ScopedFeeds`] by the domain that owns its scope. Its subscribing method returns it in
/// [`crate::call::Reply::Subscribe`] with [`Window::Fixed`], so it is attached by
/// [`subscribe`] like every other feed; its [`FeedView`] encodes the `feed/snapshot` frame.
pub trait ScopedFeed: Feed {
    /// Ends the feed when its scope ends (unwatch, stop, the owning connection's close): under
    /// the feed lock it detaches every subscription, closing its lane and releasing its
    /// unwritten frames. Afterwards `attach` answers `connectionClosed` (the subscription raced
    /// the close of its scope) and registers nothing, and `publish` reaches no lane. Idempotent.
    fn close(&self);

    /// How many subscriptions are attached now.
    fn subscribers(&self) -> usize;
}

/// Creates scoped feeds. Implemented by WP-FEED, injected into domain services by the
/// composition root.
///
/// Every created feed is independent: its own lock, ring, view and lanes, and no registry that
/// `attach` or `publish` consult. So one feed's burst, slow subscriber or held lock never
/// delays another feed; feeds share nothing but each subscriber connection's event budget
/// (P §6.5). A created feed does not depend on the factory staying alive.
pub trait ScopedFeeds: Send + Sync {
    /// An empty feed `id` (`<kind>:<key>`, seq 0) whose initial view is `view`, under a freshly
    /// drawn epoch, so a position in an earlier feed with the same id never replays.
    fn create(&self, id: FeedId, view: Arc<dyn FeedView>) -> Arc<dyn ScopedFeed>;

    /// [`Self::create`] with `on_last_detach` invoked once the feed's last attached subscriber
    /// detaches through any subscription path (including `feed/subscribe`).
    fn create_watching_detach(&self, id: FeedId, view: Arc<dyn FeedView>, on_last_detach: Arc<dyn Fn() + Send + Sync>) -> Arc<dyn ScopedFeed>;

    /// [`Self::create`] for a feed of the ordered class ([`FeedSource::ordered`]). A factory
    /// without the class creates a plain feed.
    fn create_ordered(&self, id: FeedId, view: Arc<dyn FeedView>) -> Arc<dyn ScopedFeed> {
        self.create(id, view)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublishError {
    /// A frame's seq is not the next one; nothing was published.
    SeqGap { expected: u64, got: u64 },
}

impl fmt::Display for PublishError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PublishError::SeqGap { expected, got } => {
                write!(f, "feed seq gap: expected {expected}, got {got}")
            }
        }
    }
}

impl std::error::Error for PublishError {}
