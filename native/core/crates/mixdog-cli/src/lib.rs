//! The `mixdogd` subcommands whose flow is a library of its own: the headless exec and the helper processes a core starts, both of
//! which the terminal program `mixdog` hands to the `mixdogd` beside it.

pub mod exec;
pub mod helpers;
