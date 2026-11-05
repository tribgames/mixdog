//! Orchestration tool front ends: `session`, `agent`, `explore`, `Skill`, `load_tool`,
//! `call_tool`, `setup`, `media`, `tidy`, `office`.

pub mod agent;
pub mod bridge;
pub mod explore;
pub mod office;
pub mod office_writes;
pub mod ports;
pub mod register;
pub mod schema;
pub mod service;
pub mod setup_input;
pub mod session;
pub mod skill;
pub mod status;
#[cfg(test)]
pub(crate) mod tests;
pub mod util;
