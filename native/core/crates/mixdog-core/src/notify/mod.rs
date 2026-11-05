//! Notification center: one decision for every channel, then the sinks (host toast request,
//! relay push, in-app notice). No storage on the decision path.

pub mod decision;
pub mod engine;
pub mod preview;
