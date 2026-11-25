//! The `mixdogd` subcommands whose flow is a library of its own: the headless exec, and the helper processes a core starts,
//! which the `mixdog` program serves too.

pub mod exec;
pub mod helpers;
