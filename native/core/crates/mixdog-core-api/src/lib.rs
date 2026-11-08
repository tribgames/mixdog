//! The seams between the server, the transport and the core (P §2.3, SPEC §4.2, RL §3, §13).
//! `mixdog-app-server` sees the core only through these traits; `mixdog-core` implements them.
//!
//! Runtime-latency guarantees carried by the types:
//! - **Control plane**: C0 operations ([`thread::RunControl`]) and directory lookups for them
//!   ([`thread::ThreadDirectory::get`]) are synchronous, so they cannot wait on an actor inbox,
//!   storage, encoding or another thread.
//! - **Feeds**: [`feed::FeedSource::attach`] and [`feed::Feed::publish`] are synchronous and
//!   serialized by the feed lock; snapshot encoding needs an `InLane<CpuInteractive>` proof
//!   ([`feed::FeedView`]), so it can only run on cpu-interactive.
//! - **Writer**: [`sink::ConnectionSink`] and [`sink::Lane`] never wait; lanes open gated and
//!   only the response carrying their [`sink::LaneRelease`] ungates them.
//! - **Lanes**: blocking and CPU work goes through `mixdog-rt` lane tokens.

pub mod call;
pub mod domain;
pub mod error;
pub mod feed;
pub mod feed_publisher;
pub mod handle;
pub mod host;
pub mod ids;
#[cfg(feature = "mock")]
pub mod mock;
pub mod ops;
pub mod server_request;
pub mod service;
pub mod sink;
pub mod state;
pub mod thread;
pub mod turn_review;

pub use call::CallContext;
pub use call::Caller;
pub use call::CoreRequest;
pub use call::Reply;
pub use call::Subscribe;
pub use error::CoreError;
pub use feed::Feed;
pub use feed::FeedSource;
pub use feed::FeedView;
pub use feed::ScopedFeed;
pub use feed::ScopedFeeds;
pub use handle::CoreHandle;
pub use handle::CoreState;
pub use host::ClaimedHostChannel;
pub use host::ClientEpoch;
pub use host::ConnectionNotifier;
pub use host::ApprovalPresence;
pub use host::ApprovalSurfaces;
pub use host::DesktopPresence;
pub use host::HostCapability;
pub use host::HostClaim;
pub use host::HostChannel;
pub use host::HostError;
pub use host::Lease;
pub use host::model_proxy_unavailable_text;
pub use host::HostMediaSink;
pub use ops::OpIndex;
pub use server_request::ServerRequestSink;
pub use service::DomainService;
pub use sink::ConnectionSink;
pub use sink::Lane;
pub use state::StatePublisher;
pub use thread::RunControl;
pub use thread::ThreadDirectory;
pub use thread::ThreadHandle;
