//! What a launcher of the core does before it connects: attach to the core that serves, or start one and wait until it
//! serves ([`ensure_core`]), keep the crash capture of the core it starts ([`crash_capture`]), and the process
//! lifecycle and staged-update entry points the launching binary calls around its own run ([`lifecycle`],
//! [`staged_update`]).
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "a launcher is a process of its own with no lane: each call is one bounded file or process operation before the core serves or after it ended"
)]

pub mod crash_capture;
pub mod ensure_core;
pub mod lifecycle;
pub mod staged_update;
