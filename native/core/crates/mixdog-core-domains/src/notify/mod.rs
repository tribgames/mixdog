//! Notification center: one decision for every channel, then the sinks (host toast request,
//! relay push, in-app notice). No storage on the decision path.

pub mod audience;
pub mod decision;
pub mod engine;
pub mod held;
pub mod presence;
pub mod preview;
pub mod screen;
pub mod service;
