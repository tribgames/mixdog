//! Per-account request admission (PW §7.2, RL §6).
//!
//! One [`Lane`] per provider account. Normal traffic is not concurrency-gated:
//! a lane's limit is unbounded until the operator configures one or, on a lane
//! marked `adaptive`, until the account reports a real 429. Independent lanes
//! share nothing but a lock-free lookup table, and a lane's own lock is held
//! for counter updates only (never across an await), so unrelated sessions,
//! accounts and providers never wait on each other.
//!
//! Waiting requests are served best priority first and, within one priority,
//! round-robin by owner so one session cannot starve another. A request that is
//! dropped while queued leaves the queue; a granted but unclaimed slot is
//! released.
//!
//! A permit may carry its run's [`RunLiveness`]. On a lane with an
//! `unattended_lease`, a permit whose run is unattended and has made no progress
//! for that long gives its slot back; the run itself is not ended and stays
//! abortable. An attended run's permit is never reclaimed (SPEC §4.9).

mod lane;

pub use lane::Admission;
pub use lane::AdmissionError;
pub use lane::AdmissionMetrics;
pub use lane::AdmissionRequest;
pub use lane::Block;
pub use lane::CooldownNotice;
pub use lane::Lane;
pub use lane::LaneKey;
pub use lane::LaneSettings;
pub use lane::LaneSnapshot;
pub use lane::Outcome;
pub use lane::Permit;
pub use lane::Priority;
pub use lane::RunLiveness;