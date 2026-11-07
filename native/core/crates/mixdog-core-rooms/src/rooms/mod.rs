//! Group rooms, agent home threads, agent memory front end and the agent pool section.
//!
//! Record mutation of rooms runs under the one `global("room")` writer (`records::Rooms`); agent
//! home and agent memory are serialized per agent (`mixdog_rt::KeyedChains`), so different agents
//! never wait on each other.

pub mod calls;
pub mod catalog_rows;
pub mod config;
pub mod exchange;
pub mod home;
pub mod live;
pub mod maintainer;
pub mod memory;
pub mod pool;
pub mod preview;
pub mod records;
pub mod row_message;
pub mod rows;
pub mod memory_control;
pub mod runner;
pub mod service;
pub mod sessions;
pub mod store;
pub mod supervisor;
pub mod turn_post;
pub mod turn_host;
pub mod turn_answer;
pub mod exchange_run;
pub mod member_turn;
pub mod turn_prompt;
pub mod usage;
pub mod room_relay;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RoomError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    /// A stale list revision: list again.
    #[error("precondition failed: {0}")]
    PreconditionFailed(String),
    #[error("{0}")]
    Port(String),
}
