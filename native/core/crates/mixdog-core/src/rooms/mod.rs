//! Group rooms, agent home threads, agent memory front end and the agent pool section.
//!
//! Record mutation of rooms runs under the one `global("room")` writer (`records::Rooms`); agent
//! home and agent memory are serialized per agent (`serial::KeyedSerial`), so different agents
//! never wait on each other.

pub mod config;
pub mod exchange;
pub mod home;
pub mod ids;
pub mod memory;
pub mod pool;
pub mod records;
pub mod rows;
pub mod serial;

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
