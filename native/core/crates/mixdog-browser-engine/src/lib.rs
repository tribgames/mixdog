//! The Browser Use engine in the core: it drives the desktop's guest pages through the typed `host/browser/*` lane
//! ([`port::BrowserHost`]) and keeps everything the TypeScript engine of `apps/desktop/src/main/browser/` decided
//! itself: the per-page ledgers, the command queue, refs and snapshots, settling, replies, approvals and the runner.
//!
//! This crate is the skeleton: the ports (`port`), the wire-facing types the ports share (`types`), the limits every
//! module shares (`limits`), the failure type mapped from JSON-RPC `data.code` (`error`), a scripted host for tests
//! (`fake`), and the module tree whose submodules later tasks fill. Each module file names its owner on its first line.

pub mod actions;
pub mod approval;
pub mod error;
#[cfg(any(test, feature = "test-support"))]
pub mod fake;
pub mod lane;
pub mod ledger;
pub mod limits;
pub mod port;
pub mod queue;
pub mod refs;
pub mod reply;
pub mod runner;
pub mod settle;
pub mod types;

pub use error::HostCallError;
pub use port::ApprovalPort;
pub use port::BlobPort;
pub use port::BrowserHost;
pub use port::EngineSink;
pub use port::FilePort;
pub use port::HostWire;
pub use port::TakeoverPort;
pub use port::TurnEvents;
