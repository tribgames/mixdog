//! Core lifecycle (LR §5, SPEC R21–R23, R48): the state machine, the one wind-down
//! procedure with its `noClients` trigger, the ordered release, and the report-only stall
//! monitor.
//!
//! Boot order the composition (WP-INTEGRATE) must follow: the core starts `Booting` and
//! publishes discovery as `booting`; the verdict then either calls `set_blocked` (a 1.4.5
//! owner that cannot be proven gone; the core stays up so `release`/`terminate` work) or
//! proceeds; a data migration calls `set_migrating` and reports progress; only after the
//! RPC listener is bound and discovery can name it does it call `set_serving`. Until then
//! `stop` exits at once.

mod handle;
mod machine;
mod model;
mod ports;
mod real;
mod release;
mod stall;
#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;

pub use handle::ActivityGuard;
pub use handle::ConnectionGuard;
pub use handle::Lifecycle;
pub use handle::LifecycleConfig;
pub use handle::new_instance_id;
pub use model::*;
pub use ports::CorePort;
pub use ports::Exiter;
pub use ports::Ports;
pub use ports::Publication;
pub use real::CancelRegistry;
pub use real::CoreWiring;
pub use real::DiscoveryPublication;
pub use real::Hook;
pub use real::ProcessExiter;
pub use real::RuntimeCore;
pub use real::Tracked;
pub use release::LAST_EXIT_FILE;
pub use release::LastExit;
pub use release::write_last_exit;
pub use stall::Post;
pub use stall::StallConfig;
pub use stall::StallMonitor;
pub use stall::StallReporter;
pub use stall::tokio_post;

pub(crate) use machine::ct_eq;
pub(crate) use machine::hex;
