//! Mocks of every seam, for packages that develop against the frozen contract.
//!
//! - [`MockConnection`]: a transport connection with the byte-budgeted writer of P §6.5,
//!   driven synchronously by [`MockConnection::drain`].
//! - [`MockFeed`]: the attach/publish algorithm of SPEC §4.2 over [`MockConnection`] lanes;
//!   [`MockScopedFeeds`] creates them as scoped feeds.
//! - [`MockCore`] and friends: `CoreHandle`, `ThreadDirectory`, `ThreadHandle`, `OpIndex`,
//!   `DomainService`, `ServerRequestSink`, `StatePublisher`, `HostChannel`, `HostMediaSink`.
//! - [`conformance`]: the attach-ordering scenarios every `Feed` implementation passes, and
//!   the scoped-feed scenarios every `ScopedFeeds` implementation passes.
//!
//! Lane jobs run inline on the submitting thread (`mixdog_rt::testing`), so a snapshot slot is
//! filled before `attach` returns and `drain` output is deterministic.

mod core;
mod feed;
mod transport;

pub mod conformance;

use bytes::Bytes;
use mixdog_rt::CpuInteractive;
use mixdog_rt::InLane;

use crate::feed::FeedFrame;
use crate::feed::FeedPosition;
use crate::feed::FeedView;
use crate::feed::Window;
use crate::ids::FeedEpoch;

pub use self::core::ControlCall;
pub use self::core::Handler;
pub use self::core::MockCore;
pub use self::core::MockDirectory;
pub use self::core::MockDomain;
pub use self::core::MockHostChannel;
pub use self::core::MockHostMedia;
pub use self::core::MockOpIndex;
pub use self::core::MockServerRequests;
pub use self::core::MockStatePublisher;
pub use self::core::MockThread;
pub use self::core::ServerRequestEvent;
pub use self::feed::FeedTap;
pub use self::feed::MockFeed;
pub use self::feed::MockScopedFeeds;
pub use self::transport::MockConnection;
pub use self::transport::Written;

/// Writer and feed limits shared by a mock connection and the feeds attached to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MockLimits {
    pub queue_bytes: usize,
    pub control_reserve_bytes: usize,
    pub max_snapshot_bytes: usize,
    pub ring_bytes: usize,
}

impl Default for MockLimits {
    /// SPEC §3.1 values.
    fn default() -> Self {
        Self {
            queue_bytes: 8 << 20,
            control_reserve_bytes: 512 << 10,
            max_snapshot_bytes: 3 << 20,
            ring_bytes: 4 << 20,
        }
    }
}

impl MockLimits {
    pub fn event_budget_bytes(&self) -> usize {
        self.queue_bytes - self.control_reserve_bytes
    }
}

/// A view whose snapshot frame is `snapshot@<seq>`.
#[derive(Clone, Copy, Debug, Default)]
pub struct EchoView;

impl FeedView for EchoView {
    fn encode_snapshot(
        &self,
        _lane: &InLane<CpuInteractive>,
        at: FeedPosition,
        _window: &Window,
    ) -> Bytes {
        Bytes::from(format!("snapshot@{}", at.seq))
    }
}

/// The frame `evt@<seq>`.
pub fn event(seq: u64) -> FeedFrame {
    FeedFrame {
        seq,
        bytes: Bytes::from(format!("evt@{seq}")),
    }
}

/// A 32-hex-digit epoch with value `n`.
pub fn epoch(n: u128) -> FeedEpoch {
    FeedEpoch::from(format!("{n:032x}"))
}
