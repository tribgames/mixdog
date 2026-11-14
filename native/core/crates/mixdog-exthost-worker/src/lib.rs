//! The worker side of the extension-host protocol (RL §11): a process the `mixdog-exthost` pool starts, that serves the office and
//! pdf methods one call at a time over framed stdio.
//!
//! - [`wire`] is the frame layout, mirrored from `mixdog_exthost::frame`.
//! - [`run::serve`] is the loop: READY, then one call at a time, chunks under a credit window the pool re-grants, cancel through
//!   the call's token, BYE or the end of the pipe to leave.
//! - [`registry::Registry`] holds the methods; [`ctx::CallCtx`] is what a handler gets; [`pathguard`] is the approved-path check
//!   every handler that touches a file goes through.
//! - Frames leave on a private duplicate of standard output ([`run::stdio`]); a handler never writes to the frame stream, and a
//!   child it starts gets its standard output piped or null.

pub mod ctx;
pub mod error;
pub mod methods;
pub mod pathguard;
pub mod registry;
pub mod run;
pub mod wire;

pub use ctx::CallCtx;
pub use error::CodedError;
pub use error::is_environment_error;
pub use registry::Outcome;
pub use registry::Registry;
pub use run::serve;
