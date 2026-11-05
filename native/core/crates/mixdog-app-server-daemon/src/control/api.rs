//! The management path's request and reply types live in `mixdog_app_protocol::mgmt`, so the
//! client and the CLI use them without this crate. Re-exported here for the listener.

pub use mixdog_app_protocol::mgmt::*;

use crate::lifecycle::CommandError;

/// The 409 body of a refused command.
pub fn command_error(error: CommandError) -> ErrorReply {
    ErrorReply::new(error.code(), error.to_string())
}
