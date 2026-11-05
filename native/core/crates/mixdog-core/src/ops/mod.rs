//! Mutation op ids (P §9, SPEC R30): one execution per `(scope, opId)`, `op/status` with
//! fencing, and retention.
//!
//! Each scope has one [`OpGate`], used by the scope's owner around every mutation:
//!
//! 1. `begin` → [`Begin::Execute`] for the first arrival, or [`Begin::Done`] with the shared
//!    or stored outcome for a duplicate; `opIdConflict`, `opFenced`, `opIdExpired` refuse.
//! 2. The owner applies the mutation with its op record in the same durable write (the log
//!    record of a thread, the `state/core.sqlite` transaction of a domain), then
//!    [`OpTicket::complete`]s; an external action is bracketed by
//!    [`OpTicket::external_pending`] and [`OpTicket::finish`].
//!
//! [`CoreOpIndex`] answers `op/status` by asking the scope's gate. The durable records are
//! behind [`OpStore`] (and [`OpRetention`] for non-thread scopes), supplied by each owner;
//! a non-thread scope's is [`StateOpStore`] on `state/core.sqlite`.

mod digest;
mod gate;
mod index;
mod state_store;
mod store;
#[cfg(test)]
mod tests;
mod uuid7;

pub use self::digest::PayloadDigest;
pub use self::gate::AppliedOp;
pub use self::gate::Begin;
pub use self::gate::OpGate;
pub use self::gate::OpOutcome;
pub use self::gate::OpRequest;
pub use self::gate::OpTicket;
pub use self::gate::PruneStep;
pub use self::index::CoreOpIndex;
pub use self::index::ThreadOpGates;
pub use self::state_store::StateOpStore;
pub use self::state_store::op_row;
pub use self::store::OpRecord;
pub use self::store::OpRetention;
pub use self::store::OpState;
pub use self::store::OpStore;
