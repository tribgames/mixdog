//! The control listener and its management path (LR §6, §7.1; SPEC R21, R23, X19): `/mgmt/*`
//! for the one wind-down procedure, `/health` and the `426` refusals for 1.4.5 clients.

pub mod api;
mod http;
pub mod legacy;
mod server;
pub mod wait_exit;
#[cfg(test)]
mod tests;

pub use legacy::Legacy;
pub use legacy::UPDATE_TEXT;
pub use server::ControlConfig;
pub use server::ControlListener;
pub use server::ControlServer;
pub use server::new_token;
