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
}

/// The client's last position and the window its state was built for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResumeFrom {
    pub position: FeedPosition,
    pub window: Window,
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
    Open {
        lane: Arc<dyn Lane>,
        window: Window,
        resume_from: Option<ResumeFrom>,
    },
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
}

/// The feed's current read model, swapped by pointer on publish (persistent structure).
pub trait FeedView: Send + Sync + 'static {
    /// Encodes the snapshot frame for `window` at `at`. Runs only on cpu-interactive; its
    /// input is bounded by the window design, so the frame fits `maxSnapshotBytes`.
    fn encode_snapshot(
        &self,
        lane: &InLane<CpuInteractive>,
        at: FeedPosition,
        window: &Window,
    ) -> Bytes;
}

/// The subscriber side of a feed, as the server sees it.
pub trait FeedSource: Send + Sync {
    fn feed_id(&self) -> FeedId;

    /// The atomic attach (module docs). Never waits: the snapshot is encoded after return and
    /// fills its slot. Fails with `connectionClosed` (recovery of a detached subscription) or
    /// a core state error of the feed's owner (for example `threadClosing`), registering
    /// nothing.
    fn attach(&self, req: AttachRequest) -> Result<AttachDecision, CoreError>;

    /// Removes the subscription and closes its lane. Unknown ids are ignored.
    fn detach(&self, sub: SubscriptionId);
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
    let recovery = Arc::new(FeedRecovery {
        feed: Arc::downgrade(feed),
    });
    let (lane, release) = sink
        .open_lane(sub.clone(), recovery)
        .map_err(|_| CoreError::ConnectionClosed)?;
    let start = AttachStart::Open {
        lane: lane.clone(),
        window,
        resume_from,
    };
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
            let _ = feed.attach(AttachRequest {
                sub,
                start: AttachStart::Recover { reservation },
            });
        }
    }
}

/// The producer side of a feed.
pub trait Feed: FeedSource {
    /// The last published position.
    fn position(&self) -> FeedPosition;

    /// Appends `frames` (contiguous, starting at `position().seq + 1`) and, if given, swaps the
    /// view to the state after the last frame, all under the feed lock. Called only by the
    /// feed's single producer, after the state the frames describe is durable.
    fn publish(
        &self,
        frames: &[FeedFrame],
        view: Option<Arc<dyn FeedView>>,
    ) -> Result<(), PublishError>;
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
